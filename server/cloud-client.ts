import { ConvexClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
export type Metadata = {localId: string; name: string; revision: number};
type SyncArgs = {project: string; localId: string; name: string; expectedRevision: number; operationId: string};
type SyncResult = {ok: true; revision: number; workspace: string} | {ok: false; conflict: true; actual: number};
// Framework-neutral integration for a future approved frontend bundle.
// getToken must come from Clerk's authenticated session (template/audience convex), never localStorage.
export class CloudMetadataSession {
  private client: ConvexClient | null = null;
  connect(config: {url: string; environment: 'development'; ownerVerified: boolean}, getToken: (options: {forceRefreshToken: boolean}) => Promise<string | null>) {
    if (!config.ownerVerified || config.environment !== 'development' || !/^https:\/\/[a-zA-Z0-9-]+\.convex\.cloud$/.test(config.url)) throw new Error('CLOUD_CONNECTION_BLOCKED');
    if (this.client) throw new Error('Disconnect the previous account first.');
    this.client = new ConvexClient(config.url); this.client.setAuth(getToken);
  }
  observe(project: string, receive: (metadata: Metadata[]) => void) {
    if (!this.client) throw new Error('CLOUD_DISCONNECTED');
    return this.client.onUpdate(makeFunctionReference<'query', {project: string}, Metadata[]>('workspaces:listMetadata'), {project}, receive);
  }
  async sync(args: SyncArgs, approved: boolean): Promise<SyncResult> {
    if (!approved || !this.client) throw new Error('CLOUD_MUTATION_NOT_AUTHORIZED');
    return this.client.mutation(makeFunctionReference<'mutation', SyncArgs, SyncResult>('workspaces:syncMetadata'), args);
  }
  async disconnect() { const client = this.client; this.client = null; await client?.close(); }
}
