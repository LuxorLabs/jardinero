import type { AppConfig } from '../../config.js';
import type { EngineCommands } from '../../orchestrator/engine-commands.js';
import { runPreflight } from '../../platform/preflight.js';
import type { HandlerResponse } from '../respond.js';

export interface AdminContext {
  config: AppConfig;
  announceLogReview: EngineCommands['announceLogReview'];
  env?: NodeJS.ProcessEnv;
  notifyChanged(): void;
}

// adminResponse is the operator control plane behind the admin token. Every route is a
// verb, never a read of domain state: the reads live on the capsule and dashboard
// surfaces.
export async function adminResponse(
  context: AdminContext,
  request: { method: string; url: URL },
): Promise<HandlerResponse | undefined> {
  const { method, url } = request;

  if (method === 'POST' && url.pathname === '/admin/trigger/log-review') {
    return await triggerLogReview(context, url);
  }

  if (method === 'GET' && url.pathname === '/admin/preflight') {
    // Always 200: a report that says the deployment is missing credentials is a
    // successful answer, not a server fault.
    const report = await runPreflight(context.config, context.env ?? process.env);
    return { status: 200, body: report };
  }

  // The caller owns the one route this module does not: the shared run-retry handler.
  return undefined;
}

async function triggerLogReview(context: AdminContext, url: URL): Promise<HandlerResponse> {
  const announcement = await context.announceLogReview({
    repo: url.searchParams.get('repo') ?? undefined,
    namespace: url.searchParams.get('namespace') ?? undefined,
  });
  const accepted = announcement.announced.length > 0;
  if (accepted) context.notifyChanged();
  return {
    status: accepted ? 202 : 200,
    body: {
      accepted,
      announced: announcement.announced,
      unknown_repositories: announcement.unknownRepositories,
    },
  };
}
