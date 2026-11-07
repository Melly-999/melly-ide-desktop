import { v, ConvexError } from 'convex/values';
import { mutation, query } from './model.ts';
import { requireProject, requireOrganization } from './auth.ts';
const target = v.union(v.literal('klaus'), v.literal('mellycore'));
export const consent = mutation({args: {project: v.id('projects'), target, allowed: v.boolean()}, handler: async (ctx, args) => {
  const {user} = await requireProject(ctx, args.project, true);
  const current = await ctx.db.query('memoryConsents').withIndex('by_project_user_target', q => q.eq('project', args.project).eq('user', user._id).eq('target', args.target)).unique();
  if (current) await ctx.db.patch(current._id, {allowed: args.allowed, revision: current.revision + 1});
  else await ctx.db.insert('memoryConsents', {...args, user: user._id, revision: 1});
}});
export const sharing = query({args: {project: v.id('projects'), target}, handler: async (ctx, args) => {
  const {user} = await requireProject(ctx, args.project);
  const current = await ctx.db.query('memoryConsents').withIndex('by_project_user_target', q => q.eq('project', args.project).eq('user', user._id).eq('target', args.target)).unique();
  return {allowed: current?.allowed === true, revision: current?.revision || 0};
}});
// A future server gateway calls this with the caller's verified Convex session.
// No client userId, role, memorySpaceId or entitlement is accepted.
export const authorize = query({args: {organization: v.id('organizations'), project: v.optional(v.id('projects')), scope: v.union(v.literal('personal'), v.literal('project'), v.literal('shared')), operation: v.union(v.literal('read'), v.literal('write')), target: v.optional(target)}, handler: async (ctx, args) => {
  const {user} = await requireOrganization(ctx, args.organization, args.operation === 'write');
  const base = {userId: user._id, tenantId: args.organization, canWrite: args.operation === 'write'};
  if (args.scope === 'personal') return base;
  if (!args.project) throw new ConvexError('MEMORY_SCOPE_DENIED');
  const {project} = await requireProject(ctx, args.project, args.operation === 'write');
  if (project.organization !== args.organization) throw new ConvexError('MEMORY_SCOPE_DENIED');
  if (args.scope === 'project') return {...base, projectId: project._id};
  if (!args.target) throw new ConvexError('SHARING_CONSENT_REQUIRED');
  const consent = await ctx.db.query('memoryConsents').withIndex('by_project_user_target', q => q.eq('project', project._id).eq('user', user._id).eq('target', args.target!)).unique();
  if (!consent?.allowed) throw new ConvexError('SHARING_CONSENT_REQUIRED');
  return {...base, projectId: project._id, sharedContextId: `${project._id}/${user._id}/${consent.revision}`};
}});
