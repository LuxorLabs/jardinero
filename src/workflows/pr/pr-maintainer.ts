// Appended to every top-level comment the agent posts, so its own comments can be
// recognised and dropped; otherwise a reply would trigger another pass forever.
export const AGENT_PR_COMMENT_MARKER = '<!-- jardinero-pr-maintainer -->';

export interface AgentPullRequestFacts {
  headBranch?: string;
}

export interface AgentPullRequestRule {
  branchPrefix: string;
}

// isAgentPullRequest answers whether a pull request is one of ours to maintain.
// Every branch an agent pushes carries the prefix, and nothing else of ours does.
export function isAgentPullRequest(
  facts: AgentPullRequestFacts,
  rule: AgentPullRequestRule,
): boolean {
  if (!rule.branchPrefix) return false;
  return facts.headBranch?.startsWith(rule.branchPrefix) ?? false;
}
