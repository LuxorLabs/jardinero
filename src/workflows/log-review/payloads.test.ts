import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { loadConfig } from '../../config.js';
import type { LogReviewer } from '../../store/types.js';
import { logReviewerPayload } from './payloads.js';

const REPOSITORY = 'acme/widgets';

const PRODUCTION_TARGET = {
  repo: REPOSITORY,
  namespace: 'production',
  clusters: ['demo-a', 'demo-b'],
  services: ['api', 'worker'],
};

const BILLING_TARGET = {
  repo: REPOSITORY,
  namespace: 'billing',
  clusters: ['demo-a'],
  services: ['billing-api'],
  permissionSignals: {
    statusCodes: [401, 403],
    grpcCodes: ['permission_denied'],
    keywords: ['denied'],
    knownNoise: ['Expired links are expected.'],
  },
};

// Spans namespaces, so it configures none and is queried by cluster alone.
const SPANNING_TARGET = {
  repo: 'acme/gadgets',
  clusters: ['demo-a'],
  services: ['gadget-api'],
};

const CONFIG = loadConfig();
CONFIG.workflows.logReviewer.repos = [PRODUCTION_TARGET, BILLING_TARGET, SPANNING_TARGET];
const LOG_REVIEW = CONFIG.workflows.logReviewer;

describe('logReviewerPayload', () => {
  const cases: LogReviewerCase[] = [
    {
      name: 'When the scan names a namespace then should scan the services that namespace configures',
      instance: { serviceName: 'production', environmentName: 'production' },
      want: {
        repo: REPOSITORY,
        lookback_min: LOG_REVIEW.lookbackMin,
        dry_run: LOG_REVIEW.dryRun,
        service: 'production',
        environment: 'production',
        namespace: 'production',
        cluster: PRODUCTION_TARGET.clusters[0],
        clusters: PRODUCTION_TARGET.clusters,
        services: PRODUCTION_TARGET.services,
      },
    },
    {
      name: 'When the namespace configures permission signals then should carry them',
      instance: { serviceName: 'billing', environmentName: 'billing' },
      want: {
        repo: REPOSITORY,
        lookback_min: LOG_REVIEW.lookbackMin,
        dry_run: LOG_REVIEW.dryRun,
        service: 'billing',
        environment: 'billing',
        namespace: 'billing',
        cluster: BILLING_TARGET.clusters[0],
        clusters: BILLING_TARGET.clusters,
        services: BILLING_TARGET.services,
        permission_signals: BILLING_TARGET.permissionSignals,
      },
    },
    {
      // The target spans namespaces so it configures none, and the scan stores that as null:
      // both ways of saying "no namespace" have to find the same target.
      name: 'When the target configures no namespace then should still carry its cluster',
      repository: SPANNING_TARGET.repo,
      want: {
        repo: SPANNING_TARGET.repo,
        lookback_min: LOG_REVIEW.lookbackMin,
        dry_run: LOG_REVIEW.dryRun,
        cluster: SPANNING_TARGET.clusters[0],
        clusters: SPANNING_TARGET.clusters,
        services: SPANNING_TARGET.services,
      },
    },
    {
      // A scan of the whole repository falls back to every service its targets configure.
      name: 'When the scan names no service then should scan the ones configured for its repo',
      want: {
        repo: REPOSITORY,
        lookback_min: LOG_REVIEW.lookbackMin,
        dry_run: LOG_REVIEW.dryRun,
        services: [...PRODUCTION_TARGET.services, ...BILLING_TARGET.services],
      },
    },
    {
      name: 'When the repository is not configured then should scan no service',
      repository: 'acme/unknown',
      want: {
        repo: 'acme/unknown',
        lookback_min: LOG_REVIEW.lookbackMin,
        dry_run: LOG_REVIEW.dryRun,
        services: [],
      },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const payload = logReviewerPayload(
        logReviewer(c.instance),
        c.repository ?? REPOSITORY,
        CONFIG,
      );

      assert.deepEqual(payload, c.want);
    });
  }
});

function logReviewer(overrides: Partial<LogReviewer> = {}): LogReviewer {
  return {
    id: 'instance-1',
    requestRouterId: null,
    workflowState: 'lr_pending',
    repositoryId: 'repository-1',
    serviceName: null,
    environmentName: null,
    findingCount: 0,
    sandboxRunId: null,
    lastStateCheckedAt: null,
    stateChangedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

interface LogReviewerCase {
  name: string;
  instance?: Partial<LogReviewer>;
  repository?: string;
  want: Record<string, unknown>;
}
