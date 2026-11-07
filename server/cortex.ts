import { Cortex } from '@cortexmemory/sdk';

export type MemoryScope = 'personal' | 'project' | 'agent' | 'shared';
export type MemoryRequest = {scope: MemoryScope; projectId?: string; agentId?: string; target?: 'klaus' | 'mellycore'};
// Supplied only by a server authorizer after JWT verification, membership and current consent checks.
export type MemoryGrant = {userId: string; tenantId: string; projectId?: string; agentId?: string; sharedContextId?: string; canWrite: boolean};
export type MemoryAuthorizer = (request: MemoryRequest, operation: 'read' | 'write') => Promise<MemoryGrant>;
type VectorClient = Pick<Cortex, 'vector' | 'close'>;
export type CortexFactory = (grant: MemoryGrant) => VectorClient;

export function spaceId(request: MemoryRequest, grant: MemoryGrant) {
  const part = (s: string | undefined) => { if (!s || s.length > 160) throw new Error('MEMORY_SCOPE_DENIED'); return encodeURIComponent(s); };
  const root = `melly-ide/v1/${part(grant.tenantId)}`;
  if (request.scope === 'personal') return `${root}/personal/${part(grant.userId)}`;
  if (request.scope === 'project' && grant.projectId === request.projectId) return `${root}/project/${part(grant.projectId)}`;
  if (request.scope === 'agent' && grant.agentId === request.agentId) return `${root}/agent/${part(grant.agentId)}`;
  if (request.scope === 'shared' && grant.projectId === request.projectId && grant.sharedContextId && ['klaus', 'mellycore'].includes(request.target || '')) return `${root}/shared/${part(grant.sharedContextId)}/${part(request.target)}`;
  throw new Error('MEMORY_SCOPE_DENIED');
}
function approvedText(text: string) {
  if (!text.trim() || text.length > 8000 || /-----BEGIN [\w ]*PRIVATE KEY-----|\b(?:ghp_|github_pat_|sk-)[\w-]{16,}|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]/i.test(text)) throw new Error('UNSAFE_MEMORY_CONTENT');
}
export class CortexMemoryGateway {
  private readonly authorize: MemoryAuthorizer;
  private readonly factory: CortexFactory;
  constructor(authorize: MemoryAuthorizer, factory: CortexFactory) { this.authorize = authorize; this.factory = factory; }
  async store(request: MemoryRequest, text: string, reviewed: boolean) {
    if (reviewed !== true) throw new Error('MEMORY_REVIEW_REQUIRED');
    approvedText(text); const grant = await this.authorize(request, 'write');
    if (!grant.canWrite) throw new Error('MEMORY_WRITE_DENIED');
    const space = spaceId(request, grant); const client = this.factory(grant);
    try { return await client.vector.store(space, {content: text, contentType: 'fact', tenantId: grant.tenantId, userId: grant.userId, source: {type: 'system', userId: grant.userId}, metadata: {importance: 50, tags: ['user-reviewed', 'context-only']}}); }
    finally { client.close(); }
  }
  async search(request: MemoryRequest, query: string) {
    approvedText(query); const grant = await this.authorize(request, 'read');
    const space = spaceId(request, grant); const client = this.factory(grant);
    try { return await client.vector.search(space, query, {limit: 10}); }
    finally { client.close(); }
  }
}
// Actual SDK, no imitation store. No LLM, embeddings, graph or execution tools configured.
// Not exposed as a browser route. Activation requires a separately authorized Cortex deployment
// with server-enforced tenant/space isolation; SDK AuthContext alone is not proof of authorization.
export function sdkFactory(config: {convexUrl: string; authorizedDevelopmentInstance: boolean; serverIsolationVerified: boolean}): CortexFactory {
  if (!config.authorizedDevelopmentInstance || !config.serverIsolationVerified || !/^https:\/\/[a-zA-Z0-9-]+\.convex\.cloud$/.test(config.convexUrl)) throw new Error('CORTEX_CONNECTION_BLOCKED');
  return grant => new Cortex({convexUrl: config.convexUrl, auth: {userId: grant.userId, tenantId: grant.tenantId}});
}
