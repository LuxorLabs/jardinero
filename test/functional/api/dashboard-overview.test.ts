import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type {
  OverviewResponse,
  OverviewWindowKey,
} from '../../../src/transport/dashboard/dashboard-api-types.js';
import { recordWorkflowStateChange } from '../../../src/orchestrator/state-machines/execution.js';
import { createHttpFixture } from '../../../src/testing/http.js';
import type { Store } from '../../../src/store/store.js';

describe('GET /dashboard/api/overview', () => {
  test('When the factory has history then should answer what each machine holds and produced', async () => {
    const fixture = await createHttpFixture();
    try {
      seedFactory(fixture.store);

      const response = await fetch(`${fixture.baseUrl}/dashboard/api/overview`);
      const body = (await response.json()) as OverviewResponse;

      assert.equal(response.status, 200);
      assert.equal(body.selected_window, '24h');
      assert.deepEqual(body.supported_windows, ['24h', '7d', '30d']);

      const byWorkflow = new Map(body.machines.map((machine) => [machine.workflow_type, machine]));
      assert.deepEqual(
        body.machines.map((machine) => machine.workflow_type),
        [
          'request_router',
          'linear_implementer',
          'fix_implementer',
          'log_reviewer',
          'pr_maintainer',
        ],
      );
      assert.equal(byWorkflow.get('pr_maintainer')?.label, 'PrMaintainer');
      assert.equal(byWorkflow.get('pr_maintainer')?.open_instances, 1);
      assert.deepEqual(byWorkflow.get('pr_maintainer')?.states, [
        {
          workflow_state: 'prm_attempts_exhausted',
          state_label: 'gave up',
          tone: 'attention',
          instance_count: 1,
        },
      ]);

      // The queue is what a person can move: the router is not in it, and neither is a
      // failed scan, which nobody can move at all.
      assert.deepEqual(
        body.attention.map((instance) => [instance.subject.label, instance.state_label]),
        [['acme/orchestrator#7', 'gave up']],
      );
      // What is in flight is the rest of what is alive: not the queue above, not what
      // ended, and not the router.
      assert.deepEqual(
        body.in_progress.map((instance) => [instance.subject.label, instance.state_label]),
        [['JAR-9', 'writing changes']],
      );
      assert.deepEqual(
        body.recent_failures.map((run) => [run.agent_name, run.run_state]),
        [['PrMaintainer', 'failed']],
      );
      assert.deepEqual(
        body.recent_pull_requests.map((pullRequest) => [
          pullRequest.pull_request_number,
          pullRequest.workflow_state,
        ]),
        [
          [11, 'li_done'],
          [7, 'prm_attempts_exhausted'],
        ],
      );

      // The same pull request the view lists is what the counters count.
      assert.equal(body.metrics['24h'].totals.prs_opened, 1);
      assert.equal(body.metrics['24h'].totals.items_triaged, 1);
      assert.equal(body.metrics['24h'].bucket_ms, 60 * 60 * 1000);
      assert.equal(body.metrics['24h'].series.items_triaged.length, 24);
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the window holds dozens of recent rows then should list every one of them', async () => {
    const fixture = await createHttpFixture();
    try {
      seedFailedMaintenances(fixture.store, 25);

      const response = await fetch(`${fixture.baseUrl}/dashboard/api/overview`);
      const body = (await response.json()) as OverviewResponse;

      assert.equal(body.recent_failures.length, 25);
      assert.equal(body.recent_pull_requests.length, 25);
    } finally {
      await fixture.cleanup();
    }
  });

  // Every window over one server boot, because each of them reads the same database.
  test('When a window is asked for then should select it and bucket by it', async () => {
    const fixture = await createHttpFixture();
    try {
      const cases: Array<[string, OverviewWindowKey, number, number]> = [
        ['?window=7d', '7d', 24 * 60 * 60 * 1000, 7],
        ['?window=30d', '30d', 24 * 60 * 60 * 1000, 30],
        // An unsupported or absent window reads as the day.
        ['?window=90d', '24h', 60 * 60 * 1000, 24],
        ['', '24h', 60 * 60 * 1000, 24],
      ];

      for (const [query, window, bucketMs, buckets] of cases) {
        const response = await fetch(`${fixture.baseUrl}/dashboard/api/overview${query}`);
        const body = (await response.json()) as OverviewResponse;

        assert.equal(body.selected_window, window, query);
        assert.equal(body.metrics[window].bucket_ms, bucketMs, query);
        assert.equal(body.metrics[window].series.prs_merged.length, buckets, query);
      }
    } finally {
      await fixture.cleanup();
    }
  });
});

// A factory with one of everything the Overview reads: a ticket that opened a pull
// request, a scan that finished, and a maintenance that ran out of passes.
function seedFactory(store: Store): void {
  const repositoryId = store.upsertRepository('acme/orchestrator').id;

  const stuck = store.openPrMaintainer({ repositoryId, pullRequestNumber: 7 });
  const failed = store.startSandboxRun({
    agentName: 'PrMaintainer',
    workflowType: 'pr_maintainer',
    workflowInstanceId: stuck.id,
  });
  store.finishSandboxRun(failed.id, { runState: 'failed', errorMessage: 'the pass failed' });
  store.setPrMaintainerState(stuck.id, 'prm_attempts_exhausted', {
    needsHumanReason: 'attempts_exhausted',
  });

  const ticket = store.openLinearImplementer({
    repositoryId,
    linearIssueId: 'iss-1',
    linearIssueIdentifier: 'JAR-7',
  });
  store.setLinearImplementerState(ticket.id, 'li_done', { pullRequestNumber: 11 });

  const running = store.openLinearImplementer({
    repositoryId,
    linearIssueId: 'iss-2',
    linearIssueIdentifier: 'JAR-9',
  });
  store.setLinearImplementerState(running.id, 'li_implementing');

  // An ask still being routed: alive, and never listed as work an operator holds.
  store.createRequest({
    requestSource: 'discord',
    requestText: 'do a thing',
    requesterExternalId: 'someone',
  });

  const scan = store.openLogReviewer({ repositoryId, serviceName: 'jardinero' });
  // The counters read arrivals from the event log, which only the engine writes; the
  // seeder writes them through the same helper so the metadata cannot drift.
  recordWorkflowStateChange(store, 'log_reviewer', scan, 'lr_done');
  store.setLogReviewerState(scan.id, 'lr_done', { findingCount: 1 });

  // A scan nobody can move: it must read as a failure without joining the queue.
  const failedScan = store.openLogReviewer({ repositoryId, serviceName: 'jardinero-old' });
  store.setLogReviewerState(failedScan.id, 'lr_failed');
}

// One maintenance per pull request, each with a run that failed, which is what the two
// recent sections read.
function seedFailedMaintenances(store: Store, count: number): void {
  const repositoryId = store.upsertRepository('acme/orchestrator').id;

  for (let pullRequestNumber = 1; pullRequestNumber <= count; pullRequestNumber += 1) {
    const maintenance = store.openPrMaintainer({ repositoryId, pullRequestNumber });
    const run = store.startSandboxRun({
      agentName: 'PrMaintainer',
      workflowType: 'pr_maintainer',
      workflowInstanceId: maintenance.id,
    });
    store.finishSandboxRun(run.id, { runState: 'failed', errorMessage: 'the pass failed' });
  }
}
