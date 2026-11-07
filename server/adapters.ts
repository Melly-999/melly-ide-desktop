export type AdapterName = 'klaus' | 'mellycore' | 'yuzuki';
export type AdapterStatus = {contractVersion: 1; adapter: AdapterName; connection: 'disconnected'; reason: string};
export type EvidenceReference = {runId: string; uri: string; sha256: string};
export type AuthorizedTask = {contractVersion: 1; projectId: string; taskId: string; approvalId: string; approvedRevision: number; instructionDigest: string};
export interface KlausAdapter {
  status(): AdapterStatus;
  submit(task: AuthorizedTask): Promise<{accepted: boolean; runId?: string}>;
  executionStatus(runId: string): Promise<{status: 'queued' | 'running' | 'completed' | 'failed'; evidence: EvidenceReference[]}>;
}
export interface MellyCoreAdapter {
  status(): AdapterStatus;
  projection(): Promise<{contractVersion: 1; runs: EvidenceReference[]; capabilities: string[]; providerHealth: Record<string, string>; approvals: string[]}>;
}
export interface YuzukiAdapter {status(): AdapterStatus; shareApprovedContext(projectId: string, contextDigest: string, consentId: string): Promise<void>}
export function disconnectedStatus(adapter: AdapterName): AdapterStatus { return {contractVersion: 1, adapter, connection: 'disconnected', reason: 'No authorized endpoint, audience, protocol mapping or capability grant configured.'}; }
export const adapters = {
  klaus: {status: () => disconnectedStatus('klaus'), submit: async (_task: AuthorizedTask) => { throw new Error('KLAUS_DISCONNECTED'); }, executionStatus: async (_id: string) => { throw new Error('KLAUS_DISCONNECTED'); }} satisfies KlausAdapter,
  mellycore: {status: () => disconnectedStatus('mellycore'), projection: async () => { throw new Error('MELLYCORE_DISCONNECTED'); }} satisfies MellyCoreAdapter,
  yuzuki: {status: () => disconnectedStatus('yuzuki'), shareApprovedContext: async (_project: string, _digest: string, _consent: string) => { throw new Error('YUZUKI_PRIVATE_SCOPE_DISCONNECTED'); }} satisfies YuzukiAdapter,
};
