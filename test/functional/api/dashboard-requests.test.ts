import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { RequestListResponse } from '../../../src/transport/dashboard/dashboard-api-types.js';
import { createHttpFixture } from '../../../src/testing/http.js';

describe('GET /dashboard/api/requests', () => {
  test('When asks arrived then should say what became of each one', async () => {
    const fixture = await createHttpFixture();
    try {
      const repositoryId = fixture.store.upsertRepository('acme/orchestrator').id;
      const taken = fixture.store.createRequest({
        requestSource: 'github',
        requestText: 'please fix this',
        requesterExternalId: 'someone',
        repositoryId,
        subjectType: 'pull_request',
        subjectExternalId: '7',
      });
      fixture.store.markRequestConsumed(
        taken.id,
        'pr_maintainer',
        'instance-1',
        fixture.store.upsertRepository('acme/orchestrator').id,
      );
      fixture.store.createRequest({ requestSource: 'discord', requestText: 'do a thing' });

      const response = await fetch(`${fixture.baseUrl}/dashboard/api/requests`);
      const body = (await response.json()) as RequestListResponse;

      assert.equal(response.status, 200);
      const bySource = new Map(body.requests.map((request) => [request.request_source, request]));
      assert.equal(bySource.get('github')?.outcome, 'taken');
      assert.equal(bySource.get('github')?.requester, 'someone');
      assert.equal(bySource.get('discord')?.outcome, 'routing');
    } finally {
      await fixture.cleanup();
    }
  });

  test('When asks ended in every way then should say each one in words', async () => {
    const fixture = await createHttpFixture();
    try {
      const taken = fixture.store.createRequest({ requestSource: 'github', requestText: 'fix it' });
      fixture.store.markRequestConsumed(
        taken.id,
        'pr_maintainer',
        'instance-1',
        fixture.store.upsertRepository('acme/orchestrator').id,
      );
      fixture.store.createRequest({ requestSource: 'discord', requestText: 'do a thing' });
      const unresolvable = fixture.store.createRequest({
        requestSource: 'linear',
        requestText: 'fix that',
      });
      fixture.store.setRequestState(unresolvable.id, 'rr_unresolvable', {
        resolutionNote: 'which repository?',
      });
      const silenced = fixture.store.createRequest({
        requestSource: 'cron',
        requestText: 'answered enough',
      });
      fixture.store.setRequestState(silenced.id, 'rr_resolved', {
        resolutionNote: 'reply_cap_reached',
      });
      const routed = fixture.store.createRequest({
        requestSource: 'operator',
        requestText: 'take this',
      });
      fixture.store.setRequestState(routed.id, 'rr_resolved');

      const response = await fetch(`${fixture.baseUrl}/dashboard/api/requests`);
      const body = (await response.json()) as RequestListResponse;

      const bySource = new Map(body.requests.map((request) => [request.request_source, request]));
      assert.equal(bySource.get('github')?.outcome_label, 'Delivered to PrMaintainer');
      assert.equal(bySource.get('discord')?.outcome_label, 'Delivered to RequestRouter');
      assert.equal(
        bySource.get('linear')?.outcome_label,
        'Impossible to route; needs a person: which repository?',
      );
      assert.equal(
        bySource.get('cron')?.outcome_label,
        'Not answered; the reply cap for that thread was reached',
      );
      assert.equal(bySource.get('operator')?.outcome_label, 'Routed; no workflow has taken it yet');
    } finally {
      await fixture.cleanup();
    }
  });

  test('When a source is asked for then should leave the others out', async () => {
    const fixture = await createHttpFixture();
    try {
      fixture.store.createRequest({ requestSource: 'discord', requestText: 'do a thing' });
      fixture.store.createRequest({ requestSource: 'cron', requestText: 'scan' });

      const response = await fetch(`${fixture.baseUrl}/dashboard/api/requests?source=cron`);
      const body = (await response.json()) as RequestListResponse;

      assert.equal(body.requests.length, 1);
      assert.equal(body.requests[0]?.request_source, 'cron');
    } finally {
      await fixture.cleanup();
    }
  });
});
