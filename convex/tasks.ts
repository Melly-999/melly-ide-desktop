import { v, ConvexError } from 'convex/values';
import { mutation, query } from './model.ts';
import { requireProject } from './auth.ts';

export const submit = mutation({args: {project: v.id('projects'), instruction: v.string()}, handler: async (ctx, args) => {
  const {user} = await requireProject(ctx, args.project, true);
  if (!args.instruction.trim() || args.instruction.length > 8000) throw new ConvexError('INVALID_INSTRUCTION');
  const task = await ctx.db.insert('tasks', {project: args.project, submittedBy: user._id, instruction: args.instruction, status: 'awaiting_approval', revision: 0});
  await ctx.db.insert('approvals', {task, requestedBy: user._id, taskRevision: 0, decision: 'pending'}); return task;
}});
export const list = query({args: {project: v.id('projects')}, handler: async (ctx, args) => {
  await requireProject(ctx, args.project); return ctx.db.query('tasks').withIndex('by_project', q => q.eq('project', args.project)).collect();
}});
export const decide = mutation({args: {task: v.id('tasks'), expectedRevision: v.number(), decision: v.union(v.literal('approved'), v.literal('rejected'))}, handler: async (ctx, args) => {
  const task = await ctx.db.get(args.task); if (!task) throw new ConvexError('FORBIDDEN');
  const {user} = await requireProject(ctx, task.project, true);
  const approval = await ctx.db.query('approvals').withIndex('by_task', q => q.eq('task', args.task)).unique();
  if (!approval || approval.decision !== 'pending' || task.status !== 'awaiting_approval' || task.revision !== args.expectedRevision || approval.taskRevision !== task.revision) throw new ConvexError('STALE_APPROVAL');
  await ctx.db.patch(approval._id, {decision: args.decision, decidedBy: user._id});
  await ctx.db.patch(task._id, {status: args.decision, revision: task.revision + 1});
  return {status: args.decision, execution: 'DISCONNECTED' as const};
}});
