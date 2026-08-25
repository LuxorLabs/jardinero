import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { EventListResponse } from '../../../src/transport/dashboard/dashboard-api-types.js';
import { createHttpFixture } from '../../../src/testing/http.js';

describe('GET /dashboard/api/events', () => {
  test('When a transition was recorded then should carry its ids and its states', async () => {
    const fixture = await createHttpFixture();
    try {
      fixture.store.appendEvent({
        eventType: 'workflow.state_changed',
        workflowType: 'pr_maintainer',
        workflowInstanceId: 'instance-1',
        fromState: 'prm_pending',
        toState: 'prm_working',
      });

      const response = await fetch(`${fixture.baseUrl}/dashboard/api/events`);
      const body = (await response.json()) as EventListResponse;

      assert.equal(response.status, 200);
      const transition = body.events.find((event) => event.workflow_instance_id === 'instance-1');
      assert.equal(transition?.family, 'workflow');
      assert.equal(transition?.workflow_type, 'pr_maintainer');
      assert.equal(transition?.from_state, 'prm_pending');
      assert.equal(transition?.to_state, 'prm_working');
    } finally {
      await fixture.cleanup();
    }
  });

  test('When a family is asked for then should leave the others out', async () => {
    const fixture = await createHttpFixture();
    try {
      fixture.store.appendEvent({ eventType: 'sandbox.ready' });

      const response = await fetch(`${fixture.baseUrl}/dashboard/api/events?family=sandbox`);
      const body = (await response.json()) as EventListResponse;

      assert.deepEqual(
        body.events.map((event) => event.event_type),
        ['sandbox.ready'],
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test('When no limit is asked for then should page at the shared limit', async () => {
    const fixture = await createHttpFixture();
    try {
      const [byDefault, clamped] = await Promise.all([
        fetch(`${fixture.baseUrl}/dashboard/api/events`),
        fetch(`${fixture.baseUrl}/dashboard/api/events?limit=5000`),
      ]);

      assert.equal(((await byDefault.json()) as EventListResponse).page.limit, 500);
      assert.equal(((await clamped.json()) as EventListResponse).page.limit, 500);
    } finally {
      await fixture.cleanup();
    }
  });

  test('When events have large metadata then should return bounded rows', async () => {
    const fixture = await createHttpFixture();
    try {
      const metadata = JSON.stringify({
        stdout: '🙂'.repeat(5_000),
        from_state: 'prm_pending',
        to_state: 'prm_working',
      });
      fixture.store.db
        .prepare(
          `INSERT INTO event_log (
            id, event_type, workflow_type, workflow_instance_id, sandbox_run_id,
            repository_id, metadata, created_at
          ) VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run('large-event', 'agent.finished', metadata, Date.now());

      const response = await fetch(`${fixture.baseUrl}/dashboard/api/events?limit=1`);
      const text = await response.text();
      const body = JSON.parse(text) as EventListResponse;

      assert.equal(response.status, 200);
      assert.ok(text.length < 1_000);
      assert.equal(body.events[0]?.from_state, 'prm_pending');
      assert.equal(body.events[0]?.to_state, 'prm_working');
      assert.deepEqual(body.events[0]?.metadata, {
        truncated: true,
        original_size_bytes: Buffer.byteLength(metadata),
      });
    } finally {
      await fixture.cleanup();
    }
  });
});
