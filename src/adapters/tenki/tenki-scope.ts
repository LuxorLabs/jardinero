import type { AppConfig } from '../../config.js';

// Marks a sandbox as created by Jardinero. The reaper only ever touches sandboxes
// carrying this, so foreign sandboxes sharing the workspace are never reaped.
export const JARDINERO_SANDBOX_APP = 'jardinero';

// Metadata keys stamped on every worker sandbox and read back by the reaper.
// One source of truth so the producer (worker) and consumer (reaper) cannot drift.
export const SANDBOX_METADATA = {
  app: 'app',
  runId: 'run_id',
  orchestratorId: 'orchestrator_id',
  workflow: 'workflow',
  workflowInstance: 'workflow_instance',
} as const;

// The identity call the scope guard needs, declared here rather than imported
// from the SDK so a test can supply one without loading it.
export interface TenkiScopeClient {
  whoAmI(): Promise<{ workspaces?: { id: string; name: string }[] }>;
}

// Workspace scope for the calls that accept one. A workspace API key carries its
// workspace as its own identity, so the server infers the scope and this stays
// unset; a service token can span workspaces and has to name the one it means.
// Which kind the credential is cannot be decided here -- both are prefixed tk_ --
// so when nothing is configured the credential is asked what it reaches, and an
// ambiguous answer is refused. Letting the server pick would scatter sandboxes
// across whichever workspace it chose, which is unrecoverable once they exist.
export async function resolveWorkspaceScope(
  config: AppConfig,
  env: NodeJS.ProcessEnv,
  client: TenkiScopeClient,
): Promise<{ workspaceId?: string }> {
  const key = config.worker.tenkiWorkspaceIdEnv;
  const configured = env[key]?.trim();
  if (configured) return { workspaceId: configured };

  const workspaces = (await client.whoAmI()).workspaces ?? [];
  // One reachable workspace is unambiguous, so the request stays unscoped and the
  // server resolves it from the credential.
  if (workspaces.length === 1) return {};

  const reached = workspaces.map((workspace) => `${workspace.name} (${workspace.id})`).join(', ');
  throw new Error(
    workspaces.length === 0
      ? `Missing ${key}; the Tenki credential reaches no workspace.`
      : `Missing ${key}; the Tenki credential reaches ${workspaces.length} workspaces: ${reached}.`,
  );
}

// Client-construction options for `new TenkiSandbox(...)`: auth token and, when
// overridden, the API base URL. Shared by the worker runner and the reaper so
// both talk to Tenki with the same credentials resolved from the same env keys.
export function buildTenkiClientOptions(
  config: AppConfig,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const options: Record<string, string> = {};
  const apiKey = env[config.worker.tenkiApiKeyEnv];
  if (apiKey) options.authToken = apiKey;
  const baseUrl = env[config.worker.tenkiApiUrlEnv];
  if (baseUrl) options.baseUrl = baseUrl;
  return options;
}
