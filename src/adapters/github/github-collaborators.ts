import { isPlainObject } from '../../platform/json.js';

const GITHUB_API_BASE = 'https://api.github.com';

// canPushToRepository returns whether a login has write access or more to a repository.
export async function canPushToRepository(options: {
  repo: string;
  login: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${GITHUB_API_BASE}/repos/${options.repo}/collaborators/${encodeURIComponent(options.login)}/permission`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${options.token}`,
        'x-github-api-version': '2022-11-28',
      },
    },
  );
  // Read a 404 as no access: GitHub returns it for a login it does not know.
  if (response.status === 404) return false;
  const ref = `${options.login} on ${options.repo}`;
  if (!response.ok) {
    throw new Error(`GitHub permission lookup for ${ref} failed with HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`GitHub permission lookup for ${ref} returned invalid JSON`);
  }
  const permission = isPlainObject(body) ? body.permission : undefined;
  if (typeof permission !== 'string') {
    throw new Error(`GitHub permission lookup for ${ref} returned no permission`);
  }
  // Count only admin and write: the legacy `permission` folds maintain into write and triage
  // into read.
  return permission === 'admin' || permission === 'write';
}
