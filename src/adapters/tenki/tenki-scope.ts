import type { AppConfig } from '../../config.js';

// Marks a sandbox as created by Jardinero. The reaper only ever touches sandboxes
// carrying this so a shared Tenki project's foreign sandboxes are never reaped.
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

export interface TenkiScope {
  workspaceId?: string;
  projectId: string;
}

interface TenkiIdentityProject {
  id: string;
  name?: string;
}

interface TenkiIdentityWorkspace {
  id: string;
  name?: string;
  projects: TenkiIdentityProject[];
}

interface TenkiIdentity {
  workspaces: TenkiIdentityWorkspace[];
}

export interface TenkiScopeClient {
  whoAmI(): Promise<TenkiIdentity>;
}

export async function resolveTenkiScope(
  config: AppConfig,
  env: NodeJS.ProcessEnv,
  sandbox: TenkiScopeClient,
): Promise<TenkiScope> {
  const configuredProjectId = env[config.worker.tenkiProjectIdEnv]?.trim();
  const configuredWorkspaceId = env[config.worker.tenkiWorkspaceIdEnv]?.trim();
  if (configuredProjectId) {
    return {
      projectId: configuredProjectId,
      workspaceId: configuredWorkspaceId || undefined,
    };
  }

  const identity = await sandbox.whoAmI();
  const projects = identity.workspaces.flatMap((workspace) =>
    workspace.projects.map((project) => ({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      projectId: project.id,
      projectName: project.name,
    })),
  );

  if (projects.length === 1) {
    return {
      workspaceId: configuredWorkspaceId || projects[0]!.workspaceId,
      projectId: projects[0]!.projectId,
    };
  }

  const available = projects
    .map((project) => `${project.projectName ?? '<unnamed>'} (${project.projectId})`)
    .join(', ');
  throw new Error(
    projects.length === 0
      ? `Missing ${config.worker.tenkiProjectIdEnv}; Tenki auth returned no projects.`
      : `Missing ${config.worker.tenkiProjectIdEnv}; Tenki auth has ${projects.length} projects: ${available}.`,
  );
}

export function applyTenkiScope(options: Record<string, unknown>, scope: TenkiScope): void {
  options.projectId = scope.projectId;
  if (scope.workspaceId) options.workspaceId = scope.workspaceId;
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
