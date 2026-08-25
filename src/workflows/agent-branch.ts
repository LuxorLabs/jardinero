/**
 * Computes the git branch name an agent run should push to.
 *
 * Shape: `agent/<slug>-<runIdShort>`
 *  - `slug` is the sanitized handoff fingerprint, capped at SLUG_MAX_LENGTH.
 *  - `runIdShort` is the first 8 hex chars of the run UUID, giving 32 bits of
 *    entropy — enough to disambiguate concurrent runs without dominating the
 *    branch name visually.
 *
 * The `agent/` prefix is load-bearing for downstream dedup/poll logic
 * (see implementation-pr-dedup.ts and the `poll_branch_prefix` config) — do not change it without
 * updating those callers.
 */

const PREFIX = 'agent/';
// How much of the subject the branch name carries. The branch is a handle, not a
// description: the title and the body of the pull request say the rest.
const SLUG_MAX_LENGTH = 40;
const RUN_ID_SHORT_LENGTH = 8;
const FALLBACK_SLUG = 'unspecified';

export function computeAgentBranch(runId: string, fingerprint: string | undefined): string {
  const slug = slugifyFingerprint(fingerprint);
  return `${PREFIX}${slug}-${runIdShort(runId)}`;
}

export function runIdShort(runId: string): string {
  return runId.replace(/-/g, '').slice(0, RUN_ID_SHORT_LENGTH);
}

function slugifyFingerprint(fingerprint: string | undefined): string {
  // Preserve case: fingerprints often embed code identifiers like
  // `startUpdateMember` or `PoolService.GetSubaccountsHashingStatus`.
  // Lowercasing destroys readability without making the branch any safer
  // (git refs are case-preserving and GitHub treats them case-sensitively).
  const cleaned = (fingerprint ?? '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (cleaned.length === 0) return FALLBACK_SLUG;
  if (cleaned.length <= SLUG_MAX_LENGTH) return cleaned;

  // Truncate at the last dash before the cap so we don't chop mid-word.
  // Require the boundary to be past the halfway point — otherwise hard-cut.
  const truncated = cleaned.slice(0, SLUG_MAX_LENGTH);
  const lastDash = truncated.lastIndexOf('-');
  return lastDash > SLUG_MAX_LENGTH / 2 ? truncated.slice(0, lastDash) : truncated;
}
