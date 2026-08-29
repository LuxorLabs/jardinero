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

// Workspace scope for the calls that accept one. A workspace API key carries its
// workspace as its own identity, so the server infers the scope and this stays
// unset; a service token can span workspaces and has to name the one it means.
export function resolveWorkspaceScope(
  config: AppConfig,
  env: NodeJS.ProcessEnv,
): { workspaceId?: string } {
  const workspaceId = env[config.worker.tenkiWorkspaceIdEnv]?.trim();
  return workspaceId ? { workspaceId } : {};
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
