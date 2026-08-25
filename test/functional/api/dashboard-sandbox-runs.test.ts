import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type {
  OperatorCommandResponse,
  SandboxRunDetailResponse,
} from '../../../src/transport/dashboard/dashboard-api-types.js';
import { createHttpFixture } from '../../../src/testing/http.js';
import type { Store } from '../../../src/store/store.js';

describe('GET /dashboard/api/sandbox-runs/{id}', () => {
  test('When the run is known then should answer it with what its sandbox reported', async () => {
    const fixture = await createHttpFixture();
    try {
      const seeded = seedStuckPullRequest(fixture.store);
      fixture.store.appendEvent({
        eventType: 'sandbox.ready',
        workflowType: 'pr_maintainer',
        workflowInstanceId: seeded.instanceId,
        sandboxRunId: seeded.sandboxRunId,
        metadata: { sandbox_session_id: 'session-1' },
      });
      fixture.store.writeSandboxRunArtifact(seeded.sandboxRunId, 'summary.md', 'done');

      const response = await fetch(
        `${fixture.baseUrl}/dashboard/api/sandbox-runs/${seeded.sandboxRunId}`,
      );
      const body = (await response.json()) as SandboxRunDetailResponse;

      assert.equal(response.status, 200);
      assert.equal(body.run.agent_name, 'PrMaintainer');
      assert.deepEqual(
        body.events.map((event) => event.event_type),
        ['sandbox.ready'],
      );
      assert.deepEqual(
        body.artifacts.map((artifact) => artifact.name),
        ['summary.md'],
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the run is unknown then should answer not found', async () => {
    const fixture = await createHttpFixture();
    try {
      const response = await fetch(`${fixture.baseUrl}/dashboard/api/sandbox-runs/missing`);

      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: 'sandbox_run_not_found' });
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('GET /dashboard/api/sandbox-runs/{id}/artifacts/{name}', () => {
  test('When the artifact exists then should serve its content', async () => {
    const fixture = await createHttpFixture();
    try {
      const seeded = seedStuckPullRequest(fixture.store);
      fixture.store.writeSandboxRunArtifact(seeded.sandboxRunId, 'summary.md', 'what happened');

      const response = await fetch(
        `${fixture.baseUrl}/dashboard/api/sandbox-runs/${seeded.sandboxRunId}/artifacts/summary.md`,
      );

      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'what happened');
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('POST /dashboard/api/sandbox-runs/{id}/kill', () => {
  test('When no sandbox is executing then should refuse the order', async () => {
    const fixture = await createHttpFixture();
    try {
      const seeded = seedStuckPullRequest(fixture.store);

      const response = await fetch(
        `${fixture.baseUrl}/dashboard/api/sandbox-runs/${seeded.sandboxRunId}/kill`,
        { method: 'POST' },
      );
      const body = (await response.json()) as OperatorCommandResponse;

      assert.equal(response.status, 409);
      assert.equal(body.reason, 'sandbox_run_not_executing');
    } finally {
      await fixture.cleanup();
    }
  });
});

function seedStuckPullRequest(store: Store): { instanceId: string; sandboxRunId: string } {
  const repositoryId = store.upsertRepository('acme/orchestrator').id;
  const instance = store.openPrMaintainer({ repositoryId, pullRequestNumber: 7 });
  const run = store.startSandboxRun({
    agentName: 'PrMaintainer',
    workflowType: 'pr_maintainer',
    workflowInstanceId: instance.id,
  });
  store.finishSandboxRun(run.id, { runState: 'failed', errorMessage: 'the pass failed' });
  store.setPrMaintainerState(instance.id, 'prm_attempts_exhausted', {
    needsHumanReason: 'attempts_exhausted',
  });
  return { instanceId: instance.id, sandboxRunId: run.id };
}
