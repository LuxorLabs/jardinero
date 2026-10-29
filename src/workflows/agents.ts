import type { GitHubTokenPermissions } from '../adapters/github/github-app-token.js';
import type { SandboxTask } from '../orchestrator/sandbox-pool.js';

export const AGENT_KINDS = [
  'log_reviewer',
  'fix_implementer',
  'pr_maintainer',
  'linear_implementer',
  'linear_verifier',
  'request_router',
] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];

export const PROMPT_GLOBAL_REPO = '*';

// Cap per entry, worst case ~16 KB added to a prompt with the global and the repo ones.
// In code and not a CHECK, so raising it never needs a table rebuild.
export const MAX_PROMPT_LENGTH = 8_192;

export interface Prompt {
  repo: string;
  agent: AgentKind;
  instructions: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export function agentKindForTask(task: SandboxTask): AgentKind {
  switch (task.workflow) {
    case 'log_review':
      return 'log_reviewer';
    case 'fix_implement':
      return 'fix_implementer';
    case 'pr_maintain':
      return 'pr_maintainer';
    case 'linear':
      return task.payload.role === 'verify' ? 'linear_verifier' : 'linear_implementer';
    case 'request_router':
      return 'request_router';
  }
}

// agentGitHubPermissions answers the least access an agent's sandbox token is minted with, or
// nothing for an agent that never touches GitHub.
export function agentGitHubPermissions(agent: AgentKind): GitHubTokenPermissions | undefined {
  switch (agent) {
    case 'log_reviewer':
      // Reads the code and the open pull requests, to skip a finding one already fixes.
      return { contents: 'read', pull_requests: 'read' };
    case 'fix_implementer':
    case 'pr_maintainer':
    case 'linear_implementer':
      // Pushes a branch, opens or updates its pull request, answers its threads and reads its CI.
      return { contents: 'write', pull_requests: 'write', checks: 'read' };
    case 'linear_verifier':
      // Judges a pull request without writing to it.
      return { contents: 'read', pull_requests: 'read', checks: 'read' };
    case 'request_router':
      return undefined;
  }
}

export function taskRepo(task: SandboxTask): string | undefined {
  const value = task.payload.repo;
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
