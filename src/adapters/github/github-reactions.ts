const GITHUB_API_BASE = 'https://api.github.com';

// The eight reactions GitHub's API accepts; arbitrary emoji are not allowed.
export const REACTION_CONTENTS = [
  '+1',
  '-1',
  'laugh',
  'confused',
  'heart',
  'hooray',
  'rocket',
  'eyes',
] as const;

export type ReactionContent = (typeof REACTION_CONTENTS)[number];

export function isReactionContent(value: string): value is ReactionContent {
  return (REACTION_CONTENTS as readonly string[]).includes(value);
}

// Inline review comments and top-level conversation (issue) comments belong to a
// PR but live under different reaction endpoints.
export type CommentType = 'review' | 'issue';

function reactionUrl(repo: string, commentType: CommentType, commentId: number): string {
  const segment = commentType === 'review' ? 'pulls/comments' : 'issues/comments';
  return `${GITHUB_API_BASE}/repos/${repo}/${segment}/${commentId}/reactions`;
}

// Posts a reaction to a PR comment. GitHub returns 201 when the reaction is new
// and 200 when it already exists, so this is idempotent and safe to re-issue.
export async function postCommentReaction(options: {
  repo: string;
  commentType: CommentType;
  commentId: number;
  content: ReactionContent;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    reactionUrl(options.repo, options.commentType, options.commentId),
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${options.token}`,
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: options.content }),
    },
  );
  if (!response.ok) {
    // GitHub's JSON `message` distinguishes a missing scope ("Resource not accessible
    // by integration") from bad credentials or a deleted comment; surface it so the
    // audit row is actionable rather than just a bare status code.
    const detail = await reactionErrorMessage(response);
    throw new Error(
      `GitHub reaction ${options.content} on ${options.commentType} comment ${options.commentId} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
    );
  }
}

async function reactionErrorMessage(response: Response): Promise<string | undefined> {
  const body = await response.text().catch(() => '');
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    return typeof parsed.message === 'string' ? parsed.message : undefined;
  } catch {
    return undefined;
  }
}
