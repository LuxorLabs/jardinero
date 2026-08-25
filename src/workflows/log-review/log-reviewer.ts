import type { AppConfig, LogReviewRepoConfig } from '../../config.js';

export function logReviewRepos(config: AppConfig): LogReviewRepoConfig[] {
  return config.workflows.logReviewer.repos;
}

// logReviewTargetsFor answers which entries a trigger reviews: with no repo every entry,
// with a repo every entry for it, and with both the one that matches.
export function logReviewTargetsFor(
  config: AppConfig,
  options: { repo?: string; namespace?: string } = {},
): LogReviewRepoConfig[] {
  const repos = config.workflows.logReviewer.repos;
  if (!options.repo) return [...repos];
  const matches = repos.filter((candidate) => candidate.repo === options.repo);
  if (matches.length === 0) {
    const available = repos.map((candidate) => candidate.repo).join(', ');
    throw new Error(`Unknown log review repo "${options.repo}". Available repos: ${available}`);
  }
  if (options.namespace === undefined) return matches;
  const target = matches.find((candidate) => candidate.namespace === options.namespace);
  if (!target) {
    const available = matches.map((candidate) => candidate.namespace ?? '(none)').join(', ');
    throw new Error(
      `Unknown log review namespace "${options.namespace}" for repo "${options.repo}". Available namespaces: ${available}`,
    );
  }
  return [target];
}
