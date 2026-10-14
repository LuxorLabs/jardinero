import { CODEX_AUTH_REVOKED_MESSAGE } from '../adapters/codex/codex-auth-revoked.js';
import { createAgentActivity } from '../adapters/linear/linear-api.js';
import type { AppConfig } from '../config.js';
import type { LinearSessionWriter } from './state-machines/linear-implementer/service.js';

export class LinearSessions implements LinearSessionWriter {
  constructor(
    private readonly config: AppConfig,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async reportCodexAuthRevoked(sessionId: string): Promise<Error | undefined> {
    const token = this.env[this.config.workflows.linearImplementer.apiTokenEnv];
    if (!token) return new Error('missing linear api token');
    try {
      await createAgentActivity({
        sessionId,
        content: { type: 'error', body: CODEX_AUTH_REVOKED_MESSAGE },
        token,
        fetchImpl: this.fetchImpl,
      });
      return undefined;
    } catch (error: unknown) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }
}
