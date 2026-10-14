const GITHUB_API_BASE = 'https://api.github.com';

// Posts a conversation comment on the pull request so the person who tagged us
// can read why nothing else happened.
export async function postPullRequestComment(options: {
  repo: string;
  pullRequestNumber: number;
  body: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${GITHUB_API_BASE}/repos/${options.repo}/issues/${options.pullRequestNumber}/comments`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${options.token}`,
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ body: options.body }),
    },
  );
  if (!response.ok) {
    const detail = await commentErrorMessage(response);
    throw new Error(
      `GitHub comment on ${options.repo}#${options.pullRequestNumber} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
    );
  }
}

async function commentErrorMessage(response: Response): Promise<string | undefined> {
  const body = await response.text().catch(() => '');
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    return typeof parsed.message === 'string' ? parsed.message : undefined;
  } catch {
    return undefined;
  }
}
