import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { loadConfig } from '../../config.js';
import type { LogReviewAnnouncement, LogReviewScope } from '../../orchestrator/engine-commands.js';
import { type AdminContext, adminResponse } from './admin.js';

describe('adminResponse', () => {
  const cases: TriggerCase[] = [
    {
      name: 'When a scan is announced then should answer accepted and wake the dashboard',
      path: '/admin/trigger/log-review',
      announcement: { announced: ['acme/web.app:production'], unknownRepositories: [] },
      wantStatus: 202,
      wantNotified: 1,
      wantScope: { repo: undefined, namespace: undefined },
    },
    {
      // A trigger that announced nothing is not accepted, and the repositories it
      // could not reach travel back so the gap is fixable.
      name: 'When nothing is announced then should answer the repositories it could not reach',
      path: '/admin/trigger/log-review',
      announcement: { announced: [], unknownRepositories: ['acme/web.app'] },
      wantStatus: 200,
      wantNotified: 0,
      wantScope: { repo: undefined, namespace: undefined },
    },
    {
      name: 'When the query names a repository and namespace then should pass both on',
      path: '/admin/trigger/log-review?repo=acme/webapp&namespace=billing',
      announcement: { announced: ['acme/webapp:billing'], unknownRepositories: [] },
      wantStatus: 202,
      wantNotified: 1,
      wantScope: { repo: 'acme/webapp', namespace: 'billing' },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const fixture = createFixture(testCase.announcement);

      const response = await adminResponse(fixture.context, {
        method: 'POST',
        url: new URL(`http://localhost${testCase.path}`),
      });

      assert.equal(response?.status, testCase.wantStatus);
      assert.deepEqual(response?.body, {
        accepted: testCase.wantStatus === 202,
        announced: testCase.announcement.announced,
        unknown_repositories: testCase.announcement.unknownRepositories,
      });
      assert.deepEqual(fixture.scopes, [testCase.wantScope]);
      assert.equal(fixture.notified(), testCase.wantNotified);
    });
  }

  test('When preflight is asked for then should answer its report', async () => {
    const response = await adminResponse(createFixture().context, {
      method: 'GET',
      url: new URL('http://localhost/admin/preflight'),
    });

    assert.ok(response);
    assert.equal(response.status, 200);
    assert.equal((response.body as { status?: string }).status, 'error');
  });

  test('When the route is not one of ours then should answer nothing', async () => {
    const response = await adminResponse(createFixture().context, {
      method: 'POST',
      url: new URL('http://localhost/admin/runs/run-1/retry'),
    });

    assert.equal(response, undefined);
  });
});

interface TriggerCase {
  name: string;
  path: string;
  announcement: LogReviewAnnouncement;
  wantStatus: number;
  wantNotified: number;
  wantScope: LogReviewScope;
}

function createFixture(
  announcement: LogReviewAnnouncement = { announced: [], unknownRepositories: [] },
): { context: AdminContext; scopes: LogReviewScope[]; notified(): number } {
  const scopes: LogReviewScope[] = [];
  let notified = 0;

  return {
    context: {
      config: loadConfig(),
      announceLogReview: (scope) => {
        scopes.push(scope);
        return Promise.resolve(announcement);
      },
      notifyChanged: () => {
        notified += 1;
      },
    },
    scopes,
    notified: () => notified,
  };
}
