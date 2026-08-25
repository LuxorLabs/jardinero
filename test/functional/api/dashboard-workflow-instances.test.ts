import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type {
  OperatorCommandResponse,
  WorkflowInstanceDetailResponse,
  WorkflowInstanceListResponse,
} from '../../../src/transport/dashboard/dashboard-api-types.js';
import { createHttpFixture } from '../../../src/testing/http.js';
import type { Store } from '../../../src/store/store.js';

describe('GET /dashboard/api/workflow-instances', () => {
  test('When instances are open then should list them across machines', async () => {
    const fixture = await createHttpFixture();
    try {
      seedStuckPullRequest(fixture.store);

      const response = await fetch(`${fixture.baseUrl}/dashboard/api/workflow-instances`);
      const body = (await response.json()) as WorkflowInstanceListResponse;

      assert.equal(response.status, 200);
      assert.equal(body.instances.length, 1);
      assert.equal(body.instances[0]?.subject.label, 'acme/orchestrator#7');
      assert.equal(body.instances[0]?.state_label, 'gave up');
      assert.equal(body.instances[0]?.requires_attention, true);
      assert.equal(body.page.next_cursor, null);
    } finally {
      await fixture.cleanup();
    }
  });

  test('When one instance id is asked for then should answer only that instance', async () => {
    const fixture = await createHttpFixture();
    try {
      const seeded = seedStuckPullRequest(fixture.store);
      seedScan(fixture.store);

      const response = await fetch(
        `${fixture.baseUrl}/dashboard/api/workflow-instances?workflow_instance_id=${seeded.instanceId}`,
      );
      const body = (await response.json()) as WorkflowInstanceListResponse;

      assert.equal(response.status, 200);
      assert.deepEqual(
        body.instances.map((instance) => instance.workflow_instance_id),
        [seeded.instanceId],
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('GET /dashboard/api/workflow-instances/{workflowType}/{id}', () => {
  test('When the instance is known then should answer it with its runs', async () => {
    const fixture = await createHttpFixture();
    try {
      const seeded = seedStuckPullRequest(fixture.store);

      const response = await fetch(
        `${fixture.baseUrl}/dashboard/api/workflow-instances/pr_maintainer/${seeded.instanceId}`,
      );
      const body = (await response.json()) as WorkflowInstanceDetailResponse;

      assert.equal(response.status, 200);
      assert.equal(body.instance.workflow_instance_id, seeded.instanceId);
      assert.deepEqual(
        body.sandbox_runs.map((run) => run.sandbox_run_id),
        [seeded.sandboxRunId],
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the instance is unknown then should answer not found', async () => {
    const fixture = await createHttpFixture();
    try {
      const response = await fetch(
        `${fixture.baseUrl}/dashboard/api/workflow-instances/pr_maintainer/missing`,
      );

      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: 'workflow_instance_not_found' });
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('POST /dashboard/api/workflow-instances/{workflowType}/{id}/retry', () => {
  const cases: Array<{
    name: string;
    retryable: boolean;
    wantStatus: number;
    wantReason?: string;
  }> = [
    {
      name: 'When the machine models a retry then should accept the order',
      retryable: true,
      wantStatus: 202,
    },
    {
      name: 'When the machine models no retry then should refuse it',
      retryable: false,
      wantStatus: 409,
      wantReason: 'workflow_cannot_be_retried',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const fixture = await createHttpFixture();
      try {
        const target = testCase.retryable
          ? { workflowType: 'pr_maintainer', id: seedStuckPullRequest(fixture.store).instanceId }
          : { workflowType: 'log_reviewer', id: seedScan(fixture.store) };

        const response = await fetch(
          `${fixture.baseUrl}/dashboard/api/workflow-instances/${target.workflowType}/${target.id}/retry`,
          { method: 'POST' },
        );
        const body = (await response.json()) as OperatorCommandResponse;

        assert.equal(response.status, testCase.wantStatus);
        assert.equal(body.reason, testCase.wantReason);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

describe('POST /dashboard/api/workflow-instances/{workflowType}/{id}/retry-verification', () => {
  test('When the workflow does not verify then should refuse the order', async () => {
    const fixture = await createHttpFixture();
    try {
      const { instanceId } = seedStuckPullRequest(fixture.store);

      const response = await fetch(
        `${fixture.baseUrl}/dashboard/api/workflow-instances/pr_maintainer/${instanceId}/retry-verification`,
        { method: 'POST' },
      );
      const body = (await response.json()) as OperatorCommandResponse;

      assert.equal(response.status, 409);
      assert.equal(body.reason, 'workflow_has_no_verification');
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('POST /dashboard/api/workflow-instances/{workflowType}/{id}/dismiss', () => {
  test('When a parked instance is dismissed then should end it and leave the queue', async () => {
    const fixture = await createHttpFixture();
    try {
      const { instanceId } = seedStuckPullRequest(fixture.store);

      const response = await fetch(
        `${fixture.baseUrl}/dashboard/api/workflow-instances/pr_maintainer/${instanceId}/dismiss`,
        { method: 'POST' },
      );
      const overview = (await (
        await fetch(`${fixture.baseUrl}/dashboard/api/overview`)
      ).json()) as { attention: Array<{ workflow_instance_id: string }> };

      assert.equal(response.status, 202);
      assert.deepEqual(overview.attention, []);
      assert.equal(
        fixture.store.getWorkflowInstance('pr_maintainer', instanceId)?.workflowState,
        'prm_dismissed',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the instance is unknown then should refuse it', async () => {
    const fixture = await createHttpFixture();
    try {
      const response = await fetch(
        `${fixture.baseUrl}/dashboard/api/workflow-instances/pr_maintainer/gone/dismiss`,
        { method: 'POST' },
      );
      const body = (await response.json()) as OperatorCommandResponse;

      assert.equal(response.status, 409);
      assert.equal(body.reason, 'unknown_workflow_instance');
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

function seedScan(store: Store): string {
  const repositoryId = store.upsertRepository('acme/webapp').id;
  return store.openLogReviewer({ repositoryId, serviceName: 'webapp' }).id;
}
