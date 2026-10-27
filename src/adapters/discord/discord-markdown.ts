import type { AppConfig } from '../../config.js';
import { formatGitHubPullRequestUrl } from '../../platform/github-url.js';

// linearIssueMention links the ticket to Linear, or returns the bare identifier when
// `workspace_url` is unset.
export function linearIssueMention(config: AppConfig, identifier: string): string {
  const workspace = config.workflows.linearImplementer.workspaceUrl.trim().replace(/\/+$/, '');
  return workspace ? `[${identifier}](${workspace}/issue/${identifier})` : identifier;
}

// pullRequestMention links the pull request to GitHub, or returns the bare `#number` when the
// repository is unknown.
export function pullRequestMention(repositoryFullName: string | undefined, number: number): string {
  return repositoryFullName
    ? `[#${number}](${formatGitHubPullRequestUrl(repositoryFullName, number)})`
    : `#${number}`;
}

// discordPlainText escapes Discord markdown and mention syntax, so the text shows as written.
export function discordPlainText(text: string): string {
  return text.replace(/[\\`*_~|[\]#<]/g, '\\$&');
}
