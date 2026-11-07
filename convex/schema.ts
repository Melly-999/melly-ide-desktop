import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export const role = v.union(v.literal('owner'), v.literal('editor'), v.literal('viewer'));
export const taskStatus = v.union(v.literal('awaiting_approval'), v.literal('approved'), v.literal('rejected'), v.literal('canceled'));
export const aiVerificationStatus = v.union(v.literal('verified'),v.literal('mismatch'),v.literal('unavailable'),v.literal('pending'));
export default defineSchema({
  aiDevGrants: defineTable({grantId:v.string(),owner:v.string(),model:v.string(),purpose:v.string(),expiresAt:v.number(),attemptedAt:v.number(),requestId:v.string()}).index('by_grantId',['grantId']),
  aiBudgets: defineTable({scope:v.string(),chargedNano:v.number(),inflight:v.number(),minute:v.number(),requests:v.number(),blocked:v.boolean()}).index('by_scope',['scope']),
  aiJobs: defineTable({grantId:v.optional(v.string()),owner:v.string(),requestId:v.string(),model:v.string(),responseModel:v.optional(v.string()),generationId:v.optional(v.string()),providerName:v.optional(v.string()),routedProvider:v.optional(v.string()),routingStrategy:v.optional(v.string()),routingAttempt:v.optional(v.number()),serviceTier:v.optional(v.string()),verificationStatus:aiVerificationStatus,status:v.union(v.literal('running'),v.literal('complete'),v.literal('failed')),startedAt:v.number(),finishedAt:v.optional(v.number()),reservationNano:v.number(),chargedNano:v.number(),reportedNano:v.optional(v.number()),actualNano:v.optional(v.number()),reportedPromptTokens:v.optional(v.number()),reportedCompletionTokens:v.optional(v.number()),promptTokens:v.optional(v.number()),completionTokens:v.optional(v.number()),error:v.optional(v.string()),hidden:v.boolean()}).index('by_owner',['owner']).index('by_owner_requestId',['owner','requestId']).index('by_owner_hidden_status',['owner','hidden','status']),
  users: defineTable({identity: v.string()}).index('by_identity', ['identity']),
  organizations: defineTable({name: v.string(), owner: v.id('users')}),
  memberships: defineTable({organization: v.id('organizations'), user: v.id('users'), role}).index('by_org_user', ['organization', 'user']).index('by_user', ['user']),
  projects: defineTable({organization: v.id('organizations'), name: v.string(), creator: v.id('users')}).index('by_org', ['organization']),
  projectMemberships: defineTable({project: v.id('projects'), user: v.id('users'), role}).index('by_project_user', ['project', 'user']),
  workspaces: defineTable({project: v.id('projects'), localId: v.string(), name: v.string(), revision: v.number(), updatedBy: v.id('users')}).index('by_project_local', ['project', 'localId']),
  devices: defineTable({user: v.id('users'), localId: v.string(), name: v.string()}).index('by_user_local', ['user', 'localId']),
  tasks: defineTable({project: v.id('projects'), submittedBy: v.id('users'), instruction: v.string(), status: taskStatus, revision: v.number()}).index('by_project', ['project']),
  approvals: defineTable({task: v.id('tasks'), requestedBy: v.id('users'), taskRevision: v.number(), decision: v.union(v.literal('pending'), v.literal('approved'), v.literal('rejected')), decidedBy: v.optional(v.id('users'))}).index('by_task', ['task']),
  evidence: defineTable({project: v.id('projects'), task: v.id('tasks'), reference: v.string(), producer: v.string()}),
  modelPreferences: defineTable({user: v.id('users'), model: v.string()}).index('by_user', ['user']),
  entitlements: defineTable({organization: v.id('organizations'), tier: v.union(v.literal('free'), v.literal('pro')), verifiedBy: v.string(), expiresAt: v.number()}).index('by_org', ['organization']),
  syncOperations: defineTable({user: v.id('users'), operationId: v.string(), payload: v.string(), revision: v.number(), workspace: v.id('workspaces')}).index('by_user_operation', ['user', 'operationId']),
  syncConflicts: defineTable({user: v.id('users'), project: v.id('projects'), localId: v.string(), expected: v.number(), actual: v.number()}).index('by_user', ['user']),
  memoryConsents: defineTable({project: v.id('projects'), user: v.id('users'), target: v.union(v.literal('klaus'), v.literal('mellycore')), allowed: v.boolean(), revision: v.number()}).index('by_project_user_target', ['project', 'user', 'target']),
});
