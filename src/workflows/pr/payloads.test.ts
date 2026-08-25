import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { loadConfig } from '../../config.js';
import type { FixImplementer, PrMaintainer } from '../../store/types.js';
import { fixImplementerPayload, prMaintainerPayload } from './payloads.js';

const CONFIG = loadConfig();
const REPOSITORY = 'acme/web.app';

describe('prMaintainerPayload', () => {
  const cases: PrMaintainerCase[] = [
    {
      name: 'When the pull request is named then should carry it with the reply cap',
      want: {
        repo: REPOSITORY,
        pr_number: 4688,
        max_replies_per_thread: CONFIG.workflows.prMaintainer.maxRepliesPerThread,
        attempt: 0,
      },
    },
    {
      // The agent is told which pass this is so it can say so when it answers.
      name: 'When passes were already spent then should carry how many',
      instance: { attemptCount: 2 },
      want: {
        repo: REPOSITORY,
        pr_number: 4688,
        max_replies_per_thread: CONFIG.workflows.prMaintainer.maxRepliesPerThread,
        attempt: 2,
      },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const payload = prMaintainerPayload(prMaintainer(c.instance), REPOSITORY, CONFIG);

      assert.deepEqual(payload, c.want);
    });
  }
});

describe('fixImplementerPayload', () => {
  const cases: FixImplementerCase[] = [
    {
      name: 'When the finding is fully described then should carry all of it',
      instance: {
        serviceName: 'api',
        environmentName: 'production',
        findingEvidence: 'null payment method',
      },
      want: {
        repo: REPOSITORY,
        fingerprint: 'fp-1',
        service: 'api',
        environment: 'production',
        implementation_handoff: 'null payment method',
      },
    },
    {
      name: 'When the finding names no service or evidence then should leave those out',
      want: { repo: REPOSITORY, fingerprint: 'fp-1' },
    },
    {
      name: 'When a pass already opened a pull request then should carry it',
      instance: { pullRequestNumber: 4166 },
      want: {
        repo: REPOSITORY,
        fingerprint: 'fp-1',
        pr_number: 4166,
      },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const payload = fixImplementerPayload(fixImplementer(c.instance), REPOSITORY);

      assert.deepEqual(payload, c.want);
    });
  }
});

function prMaintainer(overrides: Partial<PrMaintainer> = {}): PrMaintainer {
  return {
    id: 'instance-1',
    requestRouterId: null,
    workflowState: 'prm_pending',
    repositoryId: 'repository-1',
    pullRequestNumber: 4688,
    attemptCount: 0,
    lastActedCommitSha: null,
    sandboxRunId: null,
    needsHumanReason: null,
    lastStateCheckedAt: null,
    stateChangedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function fixImplementer(overrides: Partial<FixImplementer> = {}): FixImplementer {
  return {
    id: 'instance-1',
    logReviewerId: null,
    workflowState: 'fi_pending',
    repositoryId: 'repository-1',
    findingFingerprint: 'fp-1',
    serviceName: null,
    environmentName: null,
    findingEvidence: null,
    pullRequestNumber: null,
    verifiedCommitSha: null,
    verifierVerdict: null,
    verifierIssues: null,
    sandboxRunId: null,
    needsHumanReason: null,
    discardReason: null,
    lastStateCheckedAt: null,
    stateChangedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

interface PrMaintainerCase {
  name: string;
  instance?: Partial<PrMaintainer>;
  want: Record<string, unknown>;
}

interface FixImplementerCase {
  name: string;
  instance?: Partial<FixImplementer>;
  want: Record<string, unknown>;
}
