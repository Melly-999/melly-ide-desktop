import { v, ConvexError } from 'convex/values';
import { mutation, query } from './model.ts';
import { requireOrganization, requireProject, requireUser } from './auth.ts';

const bounded = (value: string, length = 100) => {
  if (!value.trim() || value.length > length || /[\x00-\x1f]/.test(value)) throw new ConvexError('INVALID_INPUT'); return value.trim();
};
export const initializeAccount = mutation({args: {}, handler: async ctx => {
  const identity = await ctx.auth.getUserIdentity(); if (!identity) throw new ConvexError('UNAUTHENTICATED');
  let user = await ctx.db.query('users').withIndex('by_identity', q => q.eq('identity', identity.tokenIdentifier)).unique();
  if (user) return (await ctx.db.query('memberships').withIndex('by_user', q => q.eq('user', user!._id)).collect()).map(m => m.organization);
  const userId = await ctx.db.insert('users', {identity: identity.tokenIdentifier});
  const organization = await ctx.db.insert('organizations', {name: 'Personal workspace', owner: userId});
  await ctx.db.insert('memberships', {organization, user: userId, role: 'owner'}); return [organization];
}});
export const createProject = mutation({args: {organization: v.id('organizations'), name: v.string()}, handler: async (ctx, args) => {
  const {user} = await requireOrganization(ctx, args.organization, true);
  const project = await ctx.db.insert('projects', {organization: args.organization, name: bounded(args.name), creator: user._id});
  await ctx.db.insert('projectMemberships', {project, user: user._id, role: 'owner'}); return project;
}});
export const listProjects = query({args: {organization: v.id('organizations')}, handler: async (ctx, args) => {
  const {user, member} = await requireOrganization(ctx, args.organization);
  const projects = await ctx.db.query('projects').withIndex('by_org', q => q.eq('organization', args.organization)).collect();
  if (member.role === 'owner') return projects;
  const visible = [];
  for (const project of projects) { const access = await ctx.db.query('projectMemberships').withIndex('by_project_user', q => q.eq('project', project._id).eq('user', user._id)).unique(); if (access) visible.push(project); }
  return visible;
}});
export const listMetadata = query({args: {project: v.id('projects')}, handler: async (ctx, args) => {
  await requireProject(ctx, args.project); return ctx.db.query('workspaces').withIndex('by_project_local', q => q.eq('project', args.project)).collect();
}});
export const syncMetadata = mutation({args: {project: v.id('projects'), localId: v.string(), name: v.string(), expectedRevision: v.number(), operationId: v.string()}, handler: async (ctx, args) => {
  const {user} = await requireProject(ctx, args.project, true);
  bounded(args.localId); bounded(args.operationId); bounded(args.name);
  if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0) throw new ConvexError('INVALID_REVISION');
  const payload = JSON.stringify(args);
  const replay = await ctx.db.query('syncOperations').withIndex('by_user_operation', q => q.eq('user', user._id).eq('operationId', args.operationId)).unique();
  if (replay) { if (replay.payload !== payload) throw new ConvexError('IDEMPOTENCY_KEY_REUSED'); return {ok: true as const, revision: replay.revision, workspace: replay.workspace}; }
  const current = await ctx.db.query('workspaces').withIndex('by_project_local', q => q.eq('project', args.project).eq('localId', args.localId)).unique();
  const actual = current?.revision || 0;
  if (actual !== args.expectedRevision) { await ctx.db.insert('syncConflicts', {user: user._id, project: args.project, localId: args.localId, expected: args.expectedRevision, actual}); return {ok: false as const, conflict: true, actual}; }
  const revision = actual + 1;
  const workspace = current?._id || await ctx.db.insert('workspaces', {project: args.project, localId: args.localId, name: args.name, revision, updatedBy: user._id});
  if (current) await ctx.db.patch(current._id, {name: args.name, revision, updatedBy: user._id});
  await ctx.db.insert('syncOperations', {user: user._id, operationId: args.operationId, payload, revision, workspace});
  return {ok: true as const, revision, workspace};
}});
export const registerDevice = mutation({args: {localId: v.string(), name: v.string()}, handler: async (ctx, args) => {
  const user = await requireUser(ctx); bounded(args.localId); bounded(args.name);
  const current = await ctx.db.query('devices').withIndex('by_user_local', q => q.eq('user', user._id).eq('localId', args.localId)).unique();
  if (current) { await ctx.db.patch(current._id, {name: args.name}); return current._id; }
  return ctx.db.insert('devices', {user: user._id, ...args});
}});
export const setModelPreference = mutation({args: {model: v.string()}, handler: async (ctx, args) => {
  const user = await requireUser(ctx); bounded(args.model);
  const current = await ctx.db.query('modelPreferences').withIndex('by_user', q => q.eq('user', user._id)).unique();
  if (current) await ctx.db.patch(current._id, args); else await ctx.db.insert('modelPreferences', {user: user._id, ...args});
}});
export const entitlement = query({args: {organization: v.id('organizations')}, handler: async (ctx, args) => {
  await requireOrganization(ctx, args.organization);
  const projection = await ctx.db.query('entitlements').withIndex('by_org', q => q.eq('organization', args.organization)).unique();
  const verified = Boolean(projection && projection.expiresAt > Date.now());
  return {tier: verified ? projection!.tier : 'free', verified};
}});
