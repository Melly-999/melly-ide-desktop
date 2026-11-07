import { ConvexError } from 'convex/values';
import type { GenericId } from 'convex/values';
import type { QueryCtx } from './model.ts';

export async function requireUser(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError('UNAUTHENTICATED');
  const user = await ctx.db.query('users').withIndex('by_identity', q => q.eq('identity', identity.tokenIdentifier)).unique();
  if (!user) throw new ConvexError('ACCOUNT_NOT_INITIALIZED');
  return user;
}
export async function requireOrganization(ctx: QueryCtx, organization: GenericId<'organizations'>, write = false) {
  const user = await requireUser(ctx);
  const member = await ctx.db.query('memberships').withIndex('by_org_user', q => q.eq('organization', organization).eq('user', user._id)).unique();
  if (!member || (write && member.role === 'viewer')) throw new ConvexError('FORBIDDEN');
  return {user, member};
}
export async function requireProject(ctx: QueryCtx, projectId: GenericId<'projects'>, write = false) {
  const project = await ctx.db.get(projectId);
  if (!project) throw new ConvexError('FORBIDDEN');
  const {user, member} = await requireOrganization(ctx, project.organization, write);
  const access = await ctx.db.query('projectMemberships').withIndex('by_project_user', q => q.eq('project', projectId).eq('user', user._id)).unique();
  if (member.role !== 'owner' && (!access || (write && access.role === 'viewer'))) throw new ConvexError('FORBIDDEN');
  return {user, project, role: member.role === 'owner' ? 'owner' as const : access!.role};
}
