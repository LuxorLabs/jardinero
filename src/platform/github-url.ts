import { isNonBlankString, isPositiveSafeInteger } from './json.js';

export function extractGitHubPullRequestUrl(value: unknown): string | undefined {
  return extractGitHubPullRequestUrls(value)[0];
}

export function extractGitHubPullRequestUrls(value: unknown): string[] {
  const urls: string[] = [];
  collectGitHubPullRequestUrls(value, urls, new Set<object>());
  return urls;
}

function collectGitHubPullRequestUrls(value: unknown, urls: string[], seen: Set<object>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(
      /https:\/\/(?:[^/?#\s@]+(?::[^/?#\s@]*)?@)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+(?:[/?#][^\s)"'`<>]*)?/g,
    )) {
      urls.push(match[0]);
    }
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      collectGitHubPullRequestUrls(item, urls, seen);
    }
    return;
  }
  for (const item of Object.values(value)) {
    collectGitHubPullRequestUrls(item, urls, seen);
  }
}

export function parseGitHubPullRequestUrl(
  url: string,
): { repo: string; number: number } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') {
    return undefined;
  }
  const [owner, repo, pull, numberText] = parsed.pathname.split('/').filter(Boolean);
  if (!owner || !repo || pull !== 'pull' || !numberText || !/^\d+$/.test(numberText)) {
    return undefined;
  }
  const number = Number(numberText);
  if (!Number.isSafeInteger(number) || number <= 0) return undefined;
  return {
    repo: `${owner}/${repo}`,
    number,
  };
}

export function formatGitHubPullRequestUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/pull/${number}`;
}

export function sameGitHubRepo(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && left.toLowerCase() === right.toLowerCase();
}

// Trust a GitHub API PR payload only when its own html_url parses back to the same
// number and repo it claims; a mismatch means a confused or wrong-repo response, so
// return undefined. On agreement, hand back the canonical (repo, number) using the
// caller's expected repo casing so downstream URLs are reconstructed, never echoed.
export function canonicalPullRequestFrom(
  htmlUrl: unknown,
  claimedNumber: unknown,
  expectedRepo: string,
): { repo: string; number: number } | undefined {
  if (!isNonBlankString(htmlUrl) || !isPositiveSafeInteger(claimedNumber)) return undefined;
  const parsed = parseGitHubPullRequestUrl(htmlUrl);
  if (!parsed || parsed.number !== claimedNumber || !sameGitHubRepo(parsed.repo, expectedRepo)) {
    return undefined;
  }
  return { repo: expectedRepo, number: claimedNumber };
}

// GitHub REST timestamps are UTC RFC-3339; fractional seconds are optional
// (the API omits them, but Date#toISOString and some callers include them).
// A timezone offset other than `Z` is rejected so comparisons stay lexicographic.
export function isGitHubTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
