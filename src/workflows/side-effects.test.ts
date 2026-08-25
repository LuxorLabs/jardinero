import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { WorkerResult } from '../types.js';
import type { SandboxTask } from '../orchestrator/sandbox-pool.js';
import {
  extractOpenedPullRequestUrl,
  isImplementationRun,
  type SideEffectCheck,
  type SideEffectVerification,
  type VerifySideEffectsOptions,
  verifySideEffects,
} from './side-effects.js';

const RUN_ID = 'run-123';
const PR_URL = 'https://github.com/acme/web.app/pull/123';
const PR_API = 'https://api.github.com/repos/acme/web.app/pulls/123';
const COMMIT_API = 'https://api.github.com/repos/acme/web.app/commits/abc';
const RUN_BRANCH = 'agent/unspecified-run123';
const RUN_TRAILER = `[agent] fix issue\n\nAgent-Run-Id: ${RUN_ID}`;

describe('isImplementationRun', () => {
  const cases = [
    {
      name: 'When workflow is `fix_implement` then should succeed',
      task: task('fix_implement'),
      want: true,
    },
    {
      name: 'When workflow is linear without a role then should succeed',
      task: task('linear'),
      want: true,
    },
    {
      name: 'When workflow is linear with a non string role then should succeed',
      task: task('linear', { role: 42 }),
      want: true,
    },
    {
      name: 'When workflow is linear with the verify role then should return false',
      task: task('linear', { role: 'verify' }),
      want: false,
    },
    {
      name: 'When workflow is `log_review` then should return false',
      task: task('log_review'),
      want: false,
    },
    {
      name: 'When workflow is `pr_maintain` then should return false',
      task: task('pr_maintain'),
      want: false,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.equal(isImplementationRun(c.task), c.want);
    });
  }
});

describe('verifySideEffects', () => {
  const cases: VerifyCase[] = [
    {
      name: 'When implementation run declares a `no_pr_outcome` then should skip verification',
      task: task('linear'),
      workerResult: {
        noPrOutcome: noPrOutcome({
          reason: 'needs_clarification',
          recommendedFollowup: 'Which endpoint should report health?',
        }),
      },
      want: {
        status: 'skipped',
        openedPrUrl: undefined,
        checks: [
          {
            name: 'no_pr_outcome',
            status: 'skipped',
            detail: /needs_clarification: Which endpoint should report health\?/,
          },
        ],
      },
    },
    {
      name: 'When `no_pr_outcome` omits a followup then should skip with the default detail',
      task: task('fix_implement'),
      workerResult: { noPrOutcome: noPrOutcome({ recommendedFollowup: undefined }) },
      want: {
        status: 'skipped',
        openedPrUrl: undefined,
        checks: [
          {
            name: 'no_pr_outcome',
            status: 'skipped',
            detail: /unreproducible: No PR warranted after validation\./,
          },
        ],
      },
    },
    {
      name: 'When `no_pr_outcome` output mentions a predecessor pr then should skip verification',
      task: task('linear', { role: 'implement', repo: 'acme/orchestrator' }),
      result: {
        lastMessage:
          'No code change needed; leaving https://github.com/acme/orchestrator/pull/122 open.',
      },
      workerResult: { noPrOutcome: noPrOutcome({ reason: 'outside_repo' }) },
      githubToken: 'token',
      want: {
        status: 'skipped',
        openedPrUrl: undefined,
        checks: [{ name: 'no_pr_outcome', status: 'skipped' }],
      },
    },
    {
      name: 'When `no_pr_outcome` and an opened pr are both reported then should verify the pr',
      task: task('fix_implement'),
      workerResult: { openedPrUrl: PR_URL, noPrOutcome: noPrOutcome() },
      githubToken: 'token',
      responses: {
        [PR_API]: { state: 'open', head: { ref: RUN_BRANCH, sha: 'abc' } },
        [COMMIT_API]: { commit: { message: RUN_TRAILER } },
      },
      want: {
        status: 'verified',
        openedPrUrl: PR_URL,
        absentChecks: ['no_pr_outcome'],
      },
    },
    {
      name: 'When non implementation run declares a `no_pr_outcome` then should skip on the url check',
      task: task('log_review'),
      workerResult: { noPrOutcome: noPrOutcome() },
      want: {
        status: 'skipped',
        openedPrUrl: undefined,
        checks: [{ name: 'opened_pr_url', status: 'skipped' }],
        absentChecks: ['no_pr_outcome'],
      },
    },
    {
      name: 'When implementation run reports no `pull_request` then should return failed',
      task: task('linear'),
      want: {
        status: 'failed',
        openedPrUrl: undefined,
        checks: [
          {
            name: 'opened_pr_url',
            status: 'failed',
            detail: /did not report a GitHub pull request URL/,
          },
        ],
      },
    },
    {
      name: 'When verify role run reports no `pull_request` then should skip verification',
      task: task('linear', { role: 'verify' }),
      want: {
        status: 'skipped',
        openedPrUrl: undefined,
        checks: [{ name: 'opened_pr_url', status: 'skipped' }],
      },
    },
    {
      name: 'When reported `pull_request` url is unparseable then should return failed',
      task: task('fix_implement'),
      workerResult: { openedPrUrl: 'https://github.com/acme/web.app/pulls' },
      want: {
        status: 'failed',
        openedPrUrl: 'https://github.com/acme/web.app/pulls',
        checks: [
          {
            name: 'opened_pr_url',
            status: 'failed',
            detail: /Could not parse pull request URL/,
          },
        ],
      },
    },
    {
      name: 'When `log_review` mentions a pr and the github token is missing then should warn',
      task: task('log_review'),
      result: { stdout: `Opened ${PR_URL}` },
      want: {
        status: 'warning',
        openedPrUrl: undefined,
        checks: [{ name: 'github_api', status: 'warning', detail: /token unavailable/ }],
      },
    },
    {
      name: 'When `log_review` pr lookup fails then should warn',
      task: task('log_review'),
      result: { stdout: `Opened ${PR_URL}` },
      githubToken: 'token',
      responses: {},
      want: {
        status: 'warning',
        openedPrUrl: undefined,
        checks: [
          { name: 'github_api', status: 'warning', detail: /GitHub PR verification failed/ },
        ],
      },
    },
    {
      name: 'When `log_review` pr branch belongs to this run then should return failed',
      task: task('log_review'),
      result: { stdout: `Opened ${PR_URL}` },
      githubToken: 'token',
      responses: {
        [PR_API]: { state: 'open', head: { ref: RUN_BRANCH, sha: 'abc' } },
      },
      want: {
        status: 'failed',
        openedPrUrl: PR_URL,
        checks: [{ name: 'log_review_no_pr', status: 'failed', detail: /referenced a PR branch/ }],
      },
    },
    {
      name: 'When `log_review` pr `head_sha` is unavailable then should skip as unrelated',
      task: task('log_review'),
      result: { stdout: `Opened ${PR_URL}` },
      githubToken: 'token',
      responses: {
        [PR_API]: { state: 'open', head: { ref: 'historical-branch' } },
      },
      want: {
        status: 'skipped',
        openedPrUrl: undefined,
        checks: [
          { name: 'mentioned_pr_url', status: 'skipped', detail: /head SHA was unavailable/ },
        ],
      },
    },
    {
      name: 'When `log_review` commit lookup fails then should warn',
      task: task('log_review'),
      result: { stdout: `Opened ${PR_URL}` },
      githubToken: 'token',
      responses: {
        [PR_API]: { state: 'open', head: { ref: 'historical-branch', sha: 'abc' } },
      },
      want: {
        status: 'warning',
        openedPrUrl: undefined,
        checks: [
          {
            name: 'agent_commit_trailer',
            status: 'warning',
            detail: /commit verification failed/,
          },
        ],
      },
    },
    {
      name: 'When `log_review` pr commit carries this run trailer then should return failed',
      task: task('log_review'),
      result: { stdout: `Opened ${PR_URL}` },
      githubToken: 'token',
      responses: {
        [PR_API]: { state: 'open', head: { ref: 'unexpected-branch', sha: 'abc' } },
        [COMMIT_API]: { commit: { message: `[agent] rogue change\n\nAgent-Run-Id: ${RUN_ID}` } },
      },
      want: {
        status: 'failed',
        openedPrUrl: PR_URL,
        checks: [{ name: 'log_review_no_pr', status: 'failed', detail: /head commit includes/ }],
      },
    },
    {
      name: 'When `log_review` pr is unrelated to this run then should skip verification',
      task: task('log_review'),
      result: { stdout: `Opened ${PR_URL}` },
      githubToken: 'token',
      responses: {
        [PR_API]: { state: 'open', head: { ref: 'historical-branch', sha: 'abc' } },
        [COMMIT_API]: { commit: { message: 'historical commit' } },
      },
      want: {
        status: 'skipped',
        openedPrUrl: undefined,
        checks: [{ name: 'mentioned_pr_url', status: 'skipped', detail: /not tied to this run/ }],
      },
    },
    {
      name: 'When reported `pull_request` is in another repo then should fail the repo scope check',
      task: task('fix_implement', { repo: 'acme/webapp' }),
      workerResult: { openedPrUrl: 'https://github.com/attacker/example/pull/1' },
      want: {
        status: 'failed',
        openedPrUrl: 'https://github.com/attacker/example/pull/1',
        checks: [
          { name: 'opened_pr_url', status: 'failed' },
          { name: 'repo_scope', status: 'failed', detail: /Expected acme\/webapp/ },
        ],
      },
    },
    {
      name: 'When reported `pull_request` repo casing differs then should pass the repo scope check',
      task: task('fix_implement'),
      workerResult: { openedPrUrl: 'https://github.com/acme/WEB.APP/pull/123' },
      githubToken: 'token',
      responses: {
        'https://api.github.com/repos/acme/WEB.APP/pulls/123': {
          state: 'open',
          head: { ref: RUN_BRANCH, sha: 'abc' },
        },
        'https://api.github.com/repos/acme/WEB.APP/commits/abc': {
          commit: { message: RUN_TRAILER },
        },
      },
      want: {
        status: 'verified',
        openedPrUrl: 'https://github.com/acme/WEB.APP/pull/123',
        checks: [{ name: 'opened_pr_url', status: 'verified' }],
        absentChecks: ['repo_scope'],
      },
    },
    {
      name: 'When the github token is unavailable then should warn and stop',
      task: task('fix_implement'),
      workerResult: { openedPrUrl: PR_URL },
      want: {
        status: 'warning',
        openedPrUrl: PR_URL,
        checks: [{ name: 'github_api', status: 'warning', detail: /token unavailable/ }],
        absentChecks: ['agent_branch', 'agent_commit_trailer'],
      },
    },
    {
      name: 'When the github pr lookup fails then should warn',
      task: task('fix_implement'),
      workerResult: { openedPrUrl: PR_URL },
      githubToken: 'token',
      responses: {},
      want: {
        status: 'warning',
        openedPrUrl: PR_URL,
        checks: [{ name: 'github_api', status: 'warning', detail: /HTTP 404/ }],
      },
    },
    {
      name: 'When the github pr response is not an object then should warn',
      task: task('fix_implement'),
      workerResult: { openedPrUrl: PR_URL },
      githubToken: 'token',
      responses: { [PR_API]: null },
      want: {
        status: 'warning',
        openedPrUrl: PR_URL,
        checks: [{ name: 'github_api', status: 'warning', detail: /non-object response/ }],
      },
    },
    {
      name: 'When the github pr response is invalid json then should warn',
      task: task('fix_implement'),
      workerResult: { openedPrUrl: PR_URL },
      githubToken: 'token',
      fetchImpl: invalidPrJsonFetch(),
      want: {
        status: 'warning',
        openedPrUrl: PR_URL,
        checks: [{ name: 'github_api', status: 'warning', detail: /returned invalid JSON/ }],
      },
    },
    {
      name: 'When the github pr response omits a state then should fail the pr exists check',
      task: task('fix_implement'),
      workerResult: { openedPrUrl: PR_URL },
      githubToken: 'token',
      responses: {
        [PR_API]: { head: { ref: RUN_BRANCH, sha: 'abc' } },
        [COMMIT_API]: { commit: { message: RUN_TRAILER } },
      },
      want: {
        status: 'failed',
        openedPrUrl: PR_URL,
        checks: [
          { name: 'github_pr_exists', status: 'failed', detail: /did not include a state/ },
          { name: 'agent_branch', status: 'verified' },
        ],
      },
    },
    {
      name: 'When `fix_implement` pr branch and trailer match this run then should validate successfully',
      task: task('fix_implement'),
      workerResult: { openedPrUrl: PR_URL },
      githubToken: 'token',
      responses: {
        [PR_API]: { state: 'open', head: { ref: RUN_BRANCH, sha: 'abc' } },
        [COMMIT_API]: { commit: { message: RUN_TRAILER } },
      },
      want: {
        status: 'verified',
        openedPrUrl: PR_URL,
        checks: [
          { name: 'github_pr_exists', status: 'verified', detail: /PR is open/ },
          { name: 'agent_branch', status: 'verified' },
          { name: 'agent_commit_trailer', status: 'verified' },
        ],
        absentChecks: ['agent_branch_exact_shape'],
      },
    },
    {
      name: 'When linear pr branch and trailer match this run then should validate successfully',
      task: task('linear', { fingerprint: 'linear.JAR-42' }),
      workerResult: { openedPrUrl: PR_URL },
      githubToken: 'token',
      responses: {
        [PR_API]: { state: 'open', head: { ref: 'agent/linear-JAR-42-run123', sha: 'abc' } },
        [COMMIT_API]: { commit: { message: RUN_TRAILER } },
      },
      want: {
        status: 'verified',
        openedPrUrl: PR_URL,
        checks: [{ name: 'agent_branch', status: 'verified' }],
      },
    },
    {
      // A pass continuing a pull request is judged by that pull request: the head branch
      // belongs to the pass that opened it, not to this run.
      name: 'When a pass continues the pull request it was given then should validate successfully',
      task: task('linear', { fingerprint: 'linear.JAR-42', pr_number: 123 }),
      workerResult: { openedPrUrl: PR_URL },
      githubToken: 'token',
      responses: {
        [PR_API]: { state: 'open', head: { ref: 'agent/linear-JAR-42-firstrun', sha: 'abc' } },
        [COMMIT_API]: { commit: { message: RUN_TRAILER } },
      },
      want: {
        status: 'verified',
        openedPrUrl: PR_URL,
        checks: [{ name: 'continued_pull_request', status: 'verified' }],
        absentChecks: ['agent_branch'],
      },
    },
    {
      name: 'When a pass opens another pull request instead of continuing its own then should fail',
      task: task('linear', { fingerprint: 'linear.JAR-42', pr_number: 124 }),
      workerResult: { openedPrUrl: PR_URL },
      githubToken: 'token',
      responses: {
        [PR_API]: { state: 'open', head: { ref: 'agent/linear-JAR-42-run123', sha: 'abc' } },
        [COMMIT_API]: { commit: { message: RUN_TRAILER } },
      },
      want: {
        status: 'failed',
        openedPrUrl: PR_URL,
        checks: [
          { name: 'continued_pull_request', status: 'failed', detail: /expected #124, got #123/ },
        ],
      },
    },
    {
      // Seen in the wild: Codex kept the runIdShort but paraphrased the slug.
      // The run still verifies so PR maintenance gets seeded; the deviation is a
      // soft signal, not a gate.
      name: 'When codex paraphrased the branch but kept the `run_id` then should warn on the shape',
      task: task('fix_implement', { fingerprint: 'some.fingerprint' }),
      workerResult: { openedPrUrl: PR_URL },
      githubToken: 'token',
      responses: {
        [PR_API]: {
          state: 'open',
          head: { ref: 'agent/api-gateway-codex-paraphrased-run123', sha: 'abc' },
        },
        [COMMIT_API]: { commit: { message: RUN_TRAILER } },
      },
      want: {
        status: 'warning',
        openedPrUrl: PR_URL,
        checks: [
          { name: 'agent_branch', status: 'verified' },
          { name: 'agent_branch_exact_shape', status: 'warning', detail: /deviated/ },
        ],
      },
    },
    {
      name: 'When the pr branch does not contain the `run_id` then should fail the branch check',
      task: task('fix_implement'),
      workerResult: { openedPrUrl: PR_URL },
      githubToken: 'token',
      responses: {
        [PR_API]: { state: 'open', head: { ref: 'agent/unrelated-other-987654', sha: 'abc' } },
        [COMMIT_API]: { commit: { message: RUN_TRAILER } },
      },
      want: {
        status: 'failed',
        openedPrUrl: PR_URL,
        checks: [
          { name: 'agent_branch', status: 'failed', detail: /head\.ref=agent\/unrelated-other/ },
        ],
      },
    },
    {
      name: 'When the pr `head_ref` is not a string then should fail the branch check',
      task: task('fix_implement'),
      workerResult: { openedPrUrl: PR_URL },
      githubToken: 'token',
      responses: {
        [PR_API]: { state: 'open', head: { ref: { value: RUN_BRANCH }, sha: 'abc' } },
        [COMMIT_API]: { commit: { message: RUN_TRAILER } },
      },
      want: {
        status: 'failed',
        openedPrUrl: PR_URL,
        checks: [{ name: 'agent_branch', status: 'failed', detail: /PR head ref unavailable/ }],
      },
    },
    {
      name: 'When a non implementation run pr has a head branch then should record it',
      task: task('pr_maintain'),
      workerResult: { openedPrUrl: PR_URL },
      githubToken: 'token',
      responses: {
        [PR_API]: { state: 'open', head: { ref: 'fix/manual-branch', sha: 'abc' } },
        [COMMIT_API]: { commit: { message: 'manual fix' } },
      },
      want: {
        status: 'warning',
        openedPrUrl: PR_URL,
        checks: [
          { name: 'head_branch', status: 'verified', detail: /head\.ref=fix\/manual-branch/ },
          { name: 'agent_commit_trailer', status: 'warning' },
        ],
        absentChecks: ['agent_branch'],
      },
    },
    {
      name: 'When a non implementation run pr has no head branch then should verify the trailer only',
      task: task('pr_maintain'),
      workerResult: { openedPrUrl: PR_URL },
      githubToken: 'token',
      responses: {
        [PR_API]: { state: 'open', head: { sha: 'abc' } },
        [COMMIT_API]: { commit: { message: RUN_TRAILER } },
      },
      want: {
        status: 'verified',
        openedPrUrl: PR_URL,
        checks: [{ name: 'agent_commit_trailer', status: 'verified' }],
        absentChecks: ['head_branch', 'agent_branch'],
      },
    },
    {
      name: 'When the pr `head_sha` is unavailable then should warn on the trailer check',
      task: task('fix_implement'),
      workerResult: { openedPrUrl: PR_URL },
      githubToken: 'token',
      responses: {
        [PR_API]: { state: 'open', head: { ref: RUN_BRANCH } },
      },
      want: {
        status: 'warning',
        openedPrUrl: PR_URL,
        checks: [
          {
            name: 'agent_commit_trailer',
            status: 'warning',
            detail: /head SHA unavailable/,
          },
        ],
      },
    },
    {
      name: 'When the commit lookup fails then should warn',
      task: task('fix_implement'),
      workerResult: { openedPrUrl: PR_URL },
      githubToken: 'token',
      responses: {
        [PR_API]: { state: 'open', head: { ref: RUN_BRANCH, sha: 'abc' } },
      },
      want: {
        status: 'warning',
        openedPrUrl: PR_URL,
        checks: [{ name: 'agent_commit_trailer', status: 'warning', detail: /HTTP 404/ }],
      },
    },
    {
      name: 'When the commit response is invalid json then should warn',
      task: task('fix_implement'),
      workerResult: { openedPrUrl: PR_URL },
      githubToken: 'token',
      fetchImpl: invalidCommitJsonFetch(),
      want: {
        status: 'warning',
        openedPrUrl: PR_URL,
        checks: [
          { name: 'agent_commit_trailer', status: 'warning', detail: /returned invalid JSON/ },
        ],
      },
    },
    {
      name: 'When the commit response is not an object then should warn',
      task: task('fix_implement'),
      workerResult: { openedPrUrl: PR_URL },
      githubToken: 'token',
      responses: {
        [PR_API]: { state: 'open', head: { ref: RUN_BRANCH, sha: 'abc' } },
        [COMMIT_API]: null,
      },
      want: {
        status: 'warning',
        openedPrUrl: PR_URL,
        checks: [
          { name: 'agent_commit_trailer', status: 'warning', detail: /non-object response/ },
        ],
      },
    },
    {
      // Mirrors run a1c1ba80: the agent opened no PR but investigated an existing
      // human PR, whose branch and commit are not this run's.
      name: 'When an implementation run only referenced a foreign pr then should not attribute it',
      task: task('fix_implement', { repo: 'acme/webapp' }),
      result: {
        lastMessage: 'This is already handled by https://github.com/acme/webapp/pull/3216.',
      },
      githubToken: 'token',
      responses: {
        'https://api.github.com/repos/acme/webapp/pulls/3216': {
          state: 'closed',
          head: { ref: 'mon/sup-2573-derivatives-crashes', sha: 'abc' },
        },
        'https://api.github.com/repos/acme/webapp/commits/abc': {
          commit: { message: 'fix crash when db is unavailable' },
        },
      },
      want: {
        status: 'failed',
        openedPrUrl: undefined,
        checks: [
          { name: 'opened_pr_url', status: 'failed', detail: /No pull request opened by this run/ },
        ],
        absentChecks: ['agent_branch', 'agent_commit_trailer'],
      },
    },
    {
      name: 'When an implementation pr lacks the run trailer then should return failed',
      task: task('fix_implement'),
      workerResult: { openedPrUrl: PR_URL },
      githubToken: 'token',
      responses: {
        [PR_API]: { state: 'open', head: { ref: RUN_BRANCH, sha: 'abc' } },
        [COMMIT_API]: { commit: { message: '[agent] fix issue' } },
      },
      want: {
        status: 'failed',
        openedPrUrl: PR_URL,
        checks: [{ name: 'agent_commit_trailer', status: 'failed' }],
      },
    },
    {
      name: 'When the commit message is not a string then should fail the trailer check',
      task: task('fix_implement'),
      workerResult: { openedPrUrl: PR_URL },
      githubToken: 'token',
      responses: {
        [PR_API]: { state: 'open', head: { ref: RUN_BRANCH, sha: 'abc' } },
        [COMMIT_API]: { commit: { message: { text: RUN_TRAILER } } },
      },
      want: {
        status: 'failed',
        openedPrUrl: PR_URL,
        checks: [
          {
            name: 'agent_commit_trailer',
            status: 'failed',
            detail: /does not include this run trailer/,
          },
        ],
      },
    },
    {
      name: 'When a corrective run pr carries another run trailer then should fail the trailer check',
      task: task('linear', {
        role: 'implement',
        branch: 'agent/linear-JAR-53-abc123',
        pr_number: 53,
        fingerprint: 'linear.JAR-53',
      }),
      githubToken: 'token',
      responses: {
        'https://api.github.com/repos/acme/web.app/pulls/53': {
          state: 'open',
          head: { ref: 'agent/linear-JAR-53-abc123', sha: 'abc' },
        },
        [COMMIT_API]: { commit: { message: '[agent] earlier work\n\nAgent-Run-Id: other-run' } },
      },
      want: {
        status: 'failed',
        openedPrUrl: 'https://github.com/acme/web.app/pull/53',
        checks: [{ name: 'agent_commit_trailer', status: 'failed' }],
      },
    },
    {
      name: 'When a corrective run pushed to the payload pr then should validate successfully',
      task: task('linear', {
        role: 'implement',
        branch: 'agent/linear-JAR-53-abc123',
        pr_number: 53,
        fingerprint: 'linear.JAR-53',
      }),
      result: { lastMessage: 'Addressed the review issues and pushed to the same branch.' },
      githubToken: 'token',
      responses: {
        'https://api.github.com/repos/acme/web.app/pulls/53': {
          state: 'open',
          head: { ref: 'agent/linear-JAR-53-abc123', sha: 'abc' },
        },
        [COMMIT_API]: {
          commit: { message: `[agent] fix: address review\n\nAgent-Run-Id: ${RUN_ID}` },
        },
      },
      want: {
        status: 'verified',
        openedPrUrl: 'https://github.com/acme/web.app/pull/53',
      },
    },
    {
      name: 'When the reported `pr_url` carries secrets then should report the canonical url',
      task: task('fix_implement'),
      workerResult: {
        openedPrUrl: `https://pr-user:pr-secret@github.com/acme/web.app/pull/123?token=prquerysecret`,
      },
      githubToken: 'token',
      responses: {
        [PR_API]: { state: 'open', head: { ref: RUN_BRANCH, sha: 'abc' } },
        [COMMIT_API]: { commit: { message: RUN_TRAILER } },
      },
      want: {
        status: 'verified',
        openedPrUrl: PR_URL,
        checks: [{ name: 'opened_pr_url', status: 'verified', detail: /^https:\/\/github\.com/ }],
      },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const verification = await verifySideEffects({
        runId: RUN_ID,
        task: c.task,
        result: c.result ?? {},
        workerResult: c.workerResult,
        githubToken: c.githubToken,
        fetchImpl: c.fetchImpl ?? (c.responses ? mockFetch(c.responses) : undefined),
      });

      assert.equal(verification.status, c.want.status);
      assert.equal(verification.openedPrUrl, c.want.openedPrUrl);
      for (const expected of c.want.checks ?? []) {
        const check = verification.checks.find((actual) => actual.name === expected.name);
        assert.ok(
          check,
          `expected a ${expected.name} check, got ${verification.checks.map((actual) => actual.name).join(', ')}`,
        );
        assert.equal(check.status, expected.status, `${expected.name} status`);
        if (expected.detail) assert.match(check.detail, expected.detail);
      }
      for (const name of c.want.absentChecks ?? []) {
        assert.equal(
          verification.checks.some((actual) => actual.name === name),
          false,
          `did not expect a ${name} check`,
        );
      }
      // A raw parser error must never reach the operator-facing detail text.
      assert.doesNotMatch(JSON.stringify(verification), /SyntaxError|Expected property name/);
    });
  }
});

describe('extractOpenedPullRequestUrl', () => {
  const cases: Array<{
    name: string;
    task: SandboxTask;
    result?: unknown;
    workerResult?: Pick<WorkerResult, 'openedPrUrl'>;
    want: string | undefined;
  }> = [
    {
      name: 'When the worker reports a pr in the expected repo then should return it',
      task: task('fix_implement'),
      workerResult: { openedPrUrl: PR_URL },
      want: PR_URL,
    },
    {
      name: 'When the task has no repo then should return the reported pr',
      task: task('fix_implement', { repo: undefined }),
      workerResult: { openedPrUrl: 'https://github.com/any/repo/pull/9' },
      want: 'https://github.com/any/repo/pull/9',
    },
    {
      name: 'When the reported `pr_url` carries secrets then should return the canonical url',
      task: task('fix_implement'),
      workerResult: {
        openedPrUrl: 'https://pr-user:pr-secret@github.com/acme/web.app/pull/123?token=x',
      },
      want: PR_URL,
    },
    {
      name: 'When the reported `pr_url` differs in casing then should return the expected casing',
      task: task('fix_implement'),
      workerResult: { openedPrUrl: 'https://github.com/acme/WEB.APP/pull/123?token=x' },
      want: PR_URL,
    },
    {
      name: 'When the reported `pr_url` is undecorated then should return it verbatim',
      task: task('fix_implement'),
      workerResult: { openedPrUrl: 'https://github.com/acme/WEB.APP/pull/123' },
      want: 'https://github.com/acme/WEB.APP/pull/123',
    },
    {
      name: 'When the reported pr is in another repo and the output names the expected repo then should prefer the output pr',
      task: task('fix_implement', { repo: 'acme/webapp' }),
      workerResult: { openedPrUrl: 'https://github.com/attacker/example/pull/1' },
      result: { lastMessage: 'Opened https://github.com/acme/webapp/pull/3563' },
      want: 'https://github.com/acme/webapp/pull/3563',
    },
    {
      name: 'When the reported pr is in another repo and the output has no alternative then should return the reported url',
      task: task('fix_implement', { repo: 'acme/webapp' }),
      workerResult: { openedPrUrl: 'https://github.com/attacker/example/pull/1' },
      want: 'https://github.com/attacker/example/pull/1',
    },
    {
      name: 'When the workflow does not produce pull requests then should return undefined',
      task: task('pr_maintain'),
      result: { output: `Historical entry: ${PR_URL}` },
      want: undefined,
    },
    {
      name: 'When a verify role run carries a payload pr then should return undefined',
      task: task('linear', {
        role: 'verify',
        branch: 'agent/linear-JAR-53-abc123',
        pr_number: 53,
      }),
      want: undefined,
    },
    {
      name: 'When a corrective linear run has a payload pr then should prefer it',
      task: task('linear', {
        role: 'implement',
        branch: 'agent/linear-JAR-53-abc123',
        pr_number: 53,
      }),
      result: {
        lastMessage: `While investigating I read ${PR_URL}, then pushed to the same branch.`,
      },
      want: 'https://github.com/acme/web.app/pull/53',
    },
    {
      name: 'When a linear payload pr has no branch then should still judge that pull request',
      task: task('linear', { role: 'implement', pr_number: 53 }),
      result: { lastMessage: 'No pull request opened yet.' },
      want: 'https://github.com/acme/web.app/pull/53',
    },
    {
      name: 'When the `log_review` output mentions a pr then should return it',
      task: task('log_review'),
      result: { output: `Historical changelog entry: ${PR_URL}` },
      want: PR_URL,
    },
    {
      name: 'When the output names several prs in the expected repo then should prefer the last',
      task: task('fix_implement', { repo: 'acme/webapp' }),
      result: {
        stdout: [
          'Inspected historical fix https://github.com/acme/webapp/pull/2319.',
          'Implemented and opened PR: https://github.com/acme/webapp/pull/3581',
        ].join('\n'),
      },
      want: 'https://github.com/acme/webapp/pull/3581',
    },
    {
      name: 'When the final message names an expected repo pr then should prefer it over the output',
      task: task('fix_implement', { repo: 'acme/webapp' }),
      result: {
        stdout: 'Historical changeset entry: https://github.com/acme/webapp/pull/538',
        lastMessage: 'Implemented and opened PR: https://github.com/acme/webapp/pull/3563',
      },
      want: 'https://github.com/acme/webapp/pull/3563',
    },
    {
      name: 'When the final message is not a string then should fall back to the output',
      task: task('fix_implement', { repo: 'acme/webapp' }),
      result: {
        stdout: 'Opened https://github.com/acme/webapp/pull/2',
        lastMessage: 42,
      },
      want: 'https://github.com/acme/webapp/pull/2',
    },
    {
      name: 'When the result is a string then should extract the `pr_url`',
      task: task('fix_implement', { repo: 'acme/webapp' }),
      result: 'Opened https://github.com/acme/webapp/pull/1',
      want: 'https://github.com/acme/webapp/pull/1',
    },
    {
      name: 'When the result is an array then should extract the `pr_url`',
      task: task('fix_implement', { repo: 'acme/webapp' }),
      result: ['Opened https://github.com/acme/webapp/pull/3'],
      want: 'https://github.com/acme/webapp/pull/3',
    },
    {
      name: 'When the output only names other repo prs then should return the first',
      task: task('fix_implement', { repo: 'acme/webapp' }),
      result: { stdout: 'See https://github.com/acme/schema/pull/538 for context.' },
      want: 'https://github.com/acme/schema/pull/538',
    },
    {
      name: 'When an initial linear run reports `no_pr` then should return undefined',
      task: task('linear', { role: 'implement' }),
      result: { lastMessage: 'No pull request opened yet.' },
      want: undefined,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.equal(extractOpenedPullRequestUrl(c.task, c.result ?? {}, c.workerResult), c.want);
    });
  }
});

interface ExpectedCheck {
  name: string;
  status: SideEffectCheck['status'];
  detail?: RegExp;
}

interface VerifyCase {
  name: string;
  task: SandboxTask;
  result?: unknown;
  workerResult?: VerifySideEffectsOptions['workerResult'];
  githubToken?: string;
  responses?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  want: {
    status: SideEffectVerification['status'];
    openedPrUrl: string | undefined;
    checks?: ExpectedCheck[];
    absentChecks?: string[];
  };
}

function task(
  workflow: SandboxTask['workflow'],
  payload: Record<string, unknown> = {},
): SandboxTask {
  return {
    workflow,
    promptOverrides: {},
    payload: {
      repo: 'acme/web.app',
      ...payload,
    },
  };
}

function noPrOutcome(
  overrides: Partial<NonNullable<WorkerResult['noPrOutcome']>> = {},
): NonNullable<WorkerResult['noPrOutcome']> {
  return {
    outcome: 'no_pr',
    reason: 'unreproducible',
    evidence: ['Could not reproduce the 500 with the logged route and parameters.'],
    recommendedFollowup: 'Wait for another occurrence with exception logs.',
    raw: {},
    ...overrides,
  };
}

function mockFetch(responses: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const key = requestKey(url);
    if (!(key in responses)) {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }
    return new Response(JSON.stringify(responses[key]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function invalidCommitJsonFetch(): typeof fetch {
  return (async (url: string | URL | Request) => {
    if (requestKey(url).includes('/pulls/')) {
      return new Response(
        JSON.stringify({ state: 'open', head: { ref: RUN_BRANCH, sha: 'abc' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{not json', { status: 200 });
  }) as typeof fetch;
}

function invalidPrJsonFetch(): typeof fetch {
  return (async () => new Response('{not json', { status: 200 })) as typeof fetch;
}

function requestKey(url: string | URL | Request): string {
  if (typeof url === 'string') return url;
  return url instanceof URL ? url.toString() : url.url;
}
