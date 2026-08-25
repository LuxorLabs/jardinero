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

export function taskRepo(task: SandboxTask): string | undefined {
  const value = task.payload.repo;
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
