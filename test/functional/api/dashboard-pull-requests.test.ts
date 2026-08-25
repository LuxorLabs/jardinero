import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { PullRequestListResponse } from '../../../src/transport/dashboard/dashboard-api-types.js';
import { createHttpFixture } from '../../../src/testing/http.js';

describe('GET /dashboard/api/pull-requests', () => {
  test('When we opened and merged one then should count it as accepted', async () => {
    const fixture = await createHttpFixture();
    try {
      const repositoryId = fixture.store.upsertRepository('acme/orchestrator').id;
      const implementer = fixture.store.openLinearImplementer({
        repositoryId,
        linearIssueId: 'iss-1',
        linearIssueIdentifier: 'JAR-61',
      });
      fixture.store.setLinearImplementerState(implementer.id, 'li_waiting_pr', {
        pullRequestNumber: 7,
      });
      const maintainer = fixture.store.openPrMaintainer({ repositoryId, pullRequestNumber: 7 });
      fixture.store.setPrMaintainerState(maintainer.id, 'prm_merged');

      const response = await fetch(`${fixture.baseUrl}/dashboard/api/pull-requests`);
      const body = (await response.json()) as PullRequestListResponse;

      assert.equal(response.status, 200);
      assert.equal(body.pull_requests.length, 1);
      assert.equal(body.pull_requests[0]?.url, 'https://github.com/acme/orchestrator/pull/7');
      assert.equal(body.pull_requests[0]?.opened_by_workflow_type, 'linear_implementer');
      assert.equal(body.kpis.created, 1);
      assert.equal(body.kpis.merged, 1);
      assert.equal(body.kpis.accepted_rate, 1);
      assert.deepEqual(body.repositories, ['acme/orchestrator']);
    } finally {
      await fixture.cleanup();
    }
  });
});
