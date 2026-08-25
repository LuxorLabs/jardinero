import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { loadConfig } from '../../config.js';
import type { LinearImplementer } from '../../store/types.js';
import { linearImplementerPayload, linearVerifierPayload } from './payloads.js';

const CONFIG = loadConfig();
const REPOSITORY = 'acme/web.app';

describe('linearImplementerPayload', () => {
  const cases: LinearCase[] = [
    {
      name: 'When the pass has everything then should carry the ticket, its pull request and the rejections',
      instance: {
        linearSessionId: 'session-1',
        promptContext: '<issue identifier="JAR-58"/>',
        pullRequestNumber: 4166,
        verifierIssues: 'tests missing',
        iterationNumber: 1,
      },
      want: {
        repo: REPOSITORY,
        fingerprint: 'linear.JAR-58',
        linear_issue_id: 'iss-1',
        linear_issue_identifier: 'JAR-58',
        draft_pr: true,
        iteration: 1,
        linear_session_id: 'session-1',
        prompt_context: '<issue identifier="JAR-58"/>',
        pr_number: 4166,
        verifier_issues: ['tests missing'],
      },
    },
    {
      name: 'When the verifier rejected on several counts then should carry one entry per line',
      instance: {
        pullRequestNumber: 4166,
        verifierIssues: 'the projection is a no-op\n\nthe gate never ran',
        iterationNumber: 1,
      },
      want: {
        repo: REPOSITORY,
        fingerprint: 'linear.JAR-58',
        linear_issue_id: 'iss-1',
        linear_issue_identifier: 'JAR-58',
        draft_pr: true,
        iteration: 1,
        pr_number: 4166,
        verifier_issues: ['the projection is a no-op', 'the gate never ran'],
      },
    },
    {
      name: 'When only the pull request is known then should still carry it',
      instance: { pullRequestNumber: 4166, iterationNumber: 1 },
      want: {
        repo: REPOSITORY,
        fingerprint: 'linear.JAR-58',
        linear_issue_id: 'iss-1',
        linear_issue_identifier: 'JAR-58',
        draft_pr: true,
        iteration: 1,
        pr_number: 4166,
      },
    },
    {
      name: 'When it is the first pass then should carry only the ticket',
      want: {
        repo: REPOSITORY,
        fingerprint: 'linear.JAR-58',
        linear_issue_id: 'iss-1',
        linear_issue_identifier: 'JAR-58',
        draft_pr: true,
        iteration: 0,
      },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const payload = linearImplementerPayload(linearImplementer(c.instance), REPOSITORY);

      assert.deepEqual(payload, c.want);
    });
  }
});

describe('linearVerifierPayload', () => {
  const cases: LinearCase[] = [
    {
      // `role` is what selects the verifier prompt in the runner.
      name: 'When there is a pull request to judge then should carry it with the verify role',
      instance: { pullRequestNumber: 4688 },
      want: {
        repo: REPOSITORY,
        fingerprint: 'linear.JAR-58',
        linear_issue_id: 'iss-1',
        linear_issue_identifier: 'JAR-58',
        draft_pr: true,
        iteration: 0,
        role: 'verify',
        effort: CONFIG.workflows.linearImplementer.verifyEffort,
        pr_number: 4688,
      },
    },
    {
      name: 'When no pull request was opened yet then should still carry the verify role',
      want: {
        repo: REPOSITORY,
        fingerprint: 'linear.JAR-58',
        linear_issue_id: 'iss-1',
        linear_issue_identifier: 'JAR-58',
        draft_pr: true,
        iteration: 0,
        role: 'verify',
        effort: CONFIG.workflows.linearImplementer.verifyEffort,
      },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const payload = linearVerifierPayload(linearImplementer(c.instance), REPOSITORY, CONFIG);

      assert.deepEqual(payload, c.want);
    });
  }
});

function linearImplementer(overrides: Partial<LinearImplementer> = {}): LinearImplementer {
  return {
    id: 'instance-1',
    requestRouterId: null,
    workflowState: 'li_pending',
    repositoryId: 'repository-1',
    linearIssueId: 'iss-1',
    linearIssueIdentifier: 'JAR-58',
    linearSessionId: null,
    promptContext: null,
    pullRequestNumber: null,
    iterationNumber: 0,
    verifiedCommitSha: null,
    verifierVerdict: null,
    verifierIssues: null,
    sandboxRunId: null,
    needsHumanReason: null,
    lastStateCheckedAt: null,
    stateChangedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

interface LinearCase {
  name: string;
  instance?: Partial<LinearImplementer>;
  want: Record<string, unknown>;
}
