import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from './store.js';
import type {
  EventLogFilter,
  PageRequest,
  RequestFilter,
  WorkflowInstanceFilter,
  WorkflowType,
} from './types.js';
import { type StoreFixture, createTestStore } from '../testing/store.js';

// The tables are built once when the module loads, so a window measured from that moment
// goes stale on a slow run and starts letting rows in; 2100 never does.
const WINDOW_AFTER_EVERY_SEED = 4_102_444_800_000;

let fixture: StoreFixture;
let store: Store;
let repositoryId: string;
let otherRepositoryId: string;

beforeEach(() => {
  fixture = createTestStore();
  store = fixture.store;
  repositoryId = store.upsertRepository('acme/orchestrator').id;
  otherRepositoryId = store.upsertRepository('acme/webapp').id;
});

afterEach(() => {
  fixture.cleanup();
});

describe('Store.listWorkflowInstances', () => {
  const cases: Array<{
    name: string;
    filter: WorkflowInstanceFilter;
    page?: PageRequest;
    want: string[];
  }> = [
    {
      name: 'When nothing is filtered then should return every machine, last moved first',
      filter: {},
      want: [
        'webapp @ production',
        'a finding',
        'JAR-61',
        'acme/orchestrator#7',
        'discord · someone',
      ],
    },
    {
      name: 'When a machine is filtered then should return only its instances',
      filter: { workflowType: 'pr_maintainer' },
      want: ['acme/orchestrator#7'],
    },
    {
      name: 'When several machines are filtered then should return the instances of those machines',
      filter: { workflowTypes: ['linear_implementer', 'pr_maintainer'] },
      want: ['JAR-61', 'acme/orchestrator#7'],
    },
    {
      name: 'When no machine is filtered in then should return nothing',
      filter: { workflowTypes: [] },
      want: [],
    },
    {
      name: 'When an instance id is filtered then should return only that instance',
      filter: { workflowInstanceId: 'seeded' },
      want: ['acme/orchestrator#7'],
    },
    {
      name: 'When a state is filtered then should return only the instances in it',
      filter: { workflowState: 'li_needs_human' },
      want: ['JAR-61'],
    },
    {
      name: 'When a repository is filtered then should leave the other repositories out',
      filter: { repositoryId: 'other' },
      want: ['webapp @ production'],
    },
    {
      name: 'When the subject is searched then should match part of it, ignoring case',
      filter: { subjectSearch: 'jar-6' },
      want: ['JAR-61'],
    },
    {
      name: 'When only what awaits a person is asked then should return the instances one can move',
      filter: { awaitingAPerson: true },
      want: ['a finding', 'JAR-61'],
    },
    {
      name: 'When what awaits a person is excluded then should return only what the machines move',
      filter: { awaitingAPerson: false },
      want: ['webapp @ production', 'acme/orchestrator#7', 'discord · someone'],
    },
    {
      name: 'When only what is open is asked then should return every instance that has not ended',
      filter: { open: true },
      want: [
        'webapp @ production',
        'a finding',
        'JAR-61',
        'acme/orchestrator#7',
        'discord · someone',
      ],
    },
    {
      name: 'When a window is given then should leave out what has not moved since',
      filter: { changedSince: 3_000 },
      want: ['webapp @ production', 'a finding', 'JAR-61'],
    },
    {
      name: 'When the window is in the future then should return nothing',
      filter: { changedSince: WINDOW_AFTER_EVERY_SEED },
      want: [],
    },
    {
      name: 'When the cursor is unreadable then should answer the first page',
      filter: {},
      page: { limit: 2, cursor: 'not-a-cursor' },
      want: ['webapp @ production', 'a finding'],
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      seedOneInstancePerMachine();

      const page = store.listWorkflowInstances(
        seededFilter(testCase.filter),
        testCase.page ?? { limit: 50 },
      );

      assert.deepEqual(
        page.rows.map((row) => row.subjectLabel),
        testCase.want,
      );
    });
  }

  test('When an instance has ended then should leave it out of what is open', () => {
    seedOneInstancePerMachine();
    const ended = store.listWorkflowInstances({ workflowType: 'pr_maintainer' }).rows[0];
    store.setPrMaintainerState(ended?.workflowInstanceId ?? '', 'prm_merged');

    const page = store.listWorkflowInstances({ open: true }, { limit: 50 });

    assert.deepEqual(
      page.rows.map((row) => row.subjectLabel),
      ['webapp @ production', 'a finding', 'JAR-61', 'discord · someone'],
    );
  });

  test('When there are more instances than the page then should hand back a cursor', () => {
    seedOneInstancePerMachine();

    const first = store.listWorkflowInstances({}, { limit: 2 });
    const second = store.listWorkflowInstances({}, { limit: 2, cursor: first.nextCursor ?? '' });

    assert.equal(first.rows.length, 2);
    assert.ok(first.nextCursor);
    assert.deepEqual(
      second.rows.map((row) => row.subjectLabel),
      ['JAR-61', 'acme/orchestrator#7'],
    );
  });
});

describe('Store.getWorkflowInstance', () => {
  const cases: Array<{
    name: string;
    open(): { workflowType: WorkflowType; id: string };
    wantSubjectKind: string;
    wantSubjectLabel: string;
    wantPullRequestNumber: number | null;
    wantAttemptCount: number | null;
    wantIterationNumber?: number | null;
  }> = [
    {
      name: 'When it is a request then should name who asked and through which door',
      open: () => ({
        workflowType: 'request_router',
        id: store.createRequest({
          requestSource: 'discord',
          requestText: 'do a thing',
          requesterExternalId: 'someone',
        }).id,
      }),
      wantSubjectKind: 'request',
      wantSubjectLabel: 'discord · someone',
      wantPullRequestNumber: null,
      wantAttemptCount: null,
    },
    {
      name: 'When it is a ticket then should name its identifier and count its iterations',
      open: () => ({
        workflowType: 'linear_implementer',
        id: store.openLinearImplementer({
          repositoryId,
          linearIssueId: 'iss-1',
          linearIssueIdentifier: 'JAR-61',
        }).id,
      }),
      wantSubjectKind: 'linear_issue',
      wantSubjectLabel: 'JAR-61',
      wantPullRequestNumber: null,
      wantAttemptCount: null,
      wantIterationNumber: 0,
    },
    {
      name: 'When it is a finding then should name its fingerprint',
      open: () => ({
        workflowType: 'fix_implementer',
        id: store.openFixImplementer({ repositoryId, findingFingerprint: 'a finding' }).id,
      }),
      wantSubjectKind: 'finding',
      wantSubjectLabel: 'a finding',
      wantPullRequestNumber: null,
      wantAttemptCount: null,
    },
    {
      name: 'When it is a scan then should name the service and the environment',
      open: () => ({
        workflowType: 'log_reviewer',
        id: store.openLogReviewer({
          repositoryId,
          serviceName: 'webapp',
          environmentName: 'production',
        }).id,
      }),
      wantSubjectKind: 'log_target',
      wantSubjectLabel: 'webapp @ production',
      wantPullRequestNumber: null,
      wantAttemptCount: null,
    },
    {
      name: 'When it is a scan of a whole repository then should name the repository',
      open: () => ({
        workflowType: 'log_reviewer',
        id: store.openLogReviewer({ repositoryId }).id,
      }),
      wantSubjectKind: 'log_target',
      wantSubjectLabel: 'acme/orchestrator',
      wantPullRequestNumber: null,
      wantAttemptCount: null,
    },
    {
      name: 'When it is a pull request then should name repository and number and count attempts',
      open: () => ({
        workflowType: 'pr_maintainer',
        id: store.openPrMaintainer({ repositoryId, pullRequestNumber: 7 }).id,
      }),
      wantSubjectKind: 'pull_request',
      wantSubjectLabel: 'acme/orchestrator#7',
      wantPullRequestNumber: 7,
      wantAttemptCount: 0,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const opened = testCase.open();

      const found = store.getWorkflowInstance(opened.workflowType, opened.id);

      assert.equal(found?.subjectKind, testCase.wantSubjectKind);
      assert.equal(found?.subjectLabel, testCase.wantSubjectLabel);
      assert.equal(found?.pullRequestNumber, testCase.wantPullRequestNumber);
      assert.equal(found?.attemptCount, testCase.wantAttemptCount);
      assert.equal(found?.iterationNumber, testCase.wantIterationNumber ?? null);
    });
  }

  test('When the instance is unknown then should return nothing', () => {
    assert.equal(store.getWorkflowInstance('pr_maintainer', 'missing'), undefined);
  });

  test('When the instance has runs then should say how many and which one is live', () => {
    const instance = store.openPrMaintainer({ repositoryId, pullRequestNumber: 7 });
    const first = startRun('pr_maintainer', instance.id);
    store.finishSandboxRun(first.id, { runState: 'failed' });
    const second = startRun('pr_maintainer', instance.id);
    store.setPrMaintainerState(instance.id, 'prm_working', { sandboxRunId: second.id });

    const found = store.getWorkflowInstance('pr_maintainer', instance.id);

    assert.equal(found?.sandboxRunCount, 2);
    assert.equal(found?.sandboxRunId, second.id);
  });
});

describe('Store.countWorkflowInstancesByState', () => {
  test('When instances are open then should count them per machine and state', () => {
    store.openPrMaintainer({ repositoryId, pullRequestNumber: 7 });
    store.openPrMaintainer({ repositoryId, pullRequestNumber: 8 });
    const closed = store.openPrMaintainer({ repositoryId, pullRequestNumber: 9 });
    store.openLogReviewer({ repositoryId, serviceName: 'webapp' });

    store.setPrMaintainerState(closed.id, 'prm_merged');

    assert.deepEqual(store.countWorkflowInstancesByState(), [
      { workflowType: 'log_reviewer', workflowState: 'lr_pending', instanceCount: 1 },
      { workflowType: 'pr_maintainer', workflowState: 'prm_pending', instanceCount: 2 },
    ]);
  });
});

describe('Store.listFailedSandboxRuns', () => {
  const cases: Array<{
    name: string;
    runState: 'succeeded' | 'failed' | 'aborted' | 'orphaned';
    // The window is relative to when the run ended, which only the store knows.
    endedSince?: (endedAt: number) => number;
    wantReturned: boolean;
  }> = [
    {
      name: 'When a run succeeded then should leave it out',
      runState: 'succeeded',
      wantReturned: false,
    },
    { name: 'When a run failed then should return it', runState: 'failed', wantReturned: true },
    {
      name: 'When a run was aborted then should return it',
      runState: 'aborted',
      wantReturned: true,
    },
    {
      name: 'When a run was left by a dead process then should return it',
      runState: 'orphaned',
      wantReturned: true,
    },
    {
      name: 'When the window opens when the run ended then should return it',
      runState: 'failed',
      endedSince: (endedAt) => endedAt,
      wantReturned: true,
    },
    {
      name: 'When the window opens after the run ended then should leave it out',
      runState: 'failed',
      endedSince: (endedAt) => endedAt + 1,
      wantReturned: false,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const run = startRun('pr_maintainer', 'instance-1');
      store.finishSandboxRun(run.id, { runState: testCase.runState });
      const endedAt = store.getSandboxRun(run.id)?.endedAt ?? 0;

      const failed = store.listFailedSandboxRuns(10, testCase.endedSince?.(endedAt));

      assert.deepEqual(
        failed.map((entry) => entry.id),
        testCase.wantReturned ? [run.id] : [],
      );
    });
  }
});

describe('Store.countStateArrivals', () => {
  const cases: Array<{
    name: string;
    toStates: string[];
    since: number;
    want: Array<{ toState: string; arrivalCount: number }>;
  }> = [
    {
      name: 'When a state is asked for then should count how many instances entered it',
      toStates: ['prm_merged'],
      since: 0,
      want: [{ toState: 'prm_merged', arrivalCount: 2 }],
    },
    {
      name: 'When several states are asked for then should count each one',
      toStates: ['prm_merged', 'lr_done'],
      since: 0,
      want: [
        { toState: 'lr_done', arrivalCount: 1 },
        { toState: 'prm_merged', arrivalCount: 2 },
      ],
    },
    {
      name: 'When a state nobody entered is asked for then should count nothing',
      toStates: ['fi_done'],
      since: 0,
      want: [],
    },
    {
      name: 'When the window starts after the arrivals then should count nothing',
      toStates: ['prm_merged'],
      since: WINDOW_AFTER_EVERY_SEED,
      want: [],
    },
    {
      name: 'When no state is asked for then should count nothing',
      toStates: [],
      since: 0,
      want: [],
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      recordArrival('pr_maintainer', 'prm_waiting', 'prm_merged');
      recordArrival('pr_maintainer', 'prm_waiting', 'prm_merged');
      recordArrival('log_reviewer', 'lr_working', 'lr_done');

      const buckets = store.countStateArrivals(testCase.toStates, testCase.since, 60 * 60 * 1000);

      assert.deepEqual(
        buckets
          .map((bucket) => ({ toState: bucket.toState, arrivalCount: bucket.arrivalCount }))
          .sort((left, right) => left.toState.localeCompare(right.toState)),
        testCase.want,
      );
    });
  }

  test('When arrivals fall in different buckets then should keep them apart', () => {
    const hour = 60 * 60 * 1000;
    recordArrival('pr_maintainer', 'prm_waiting', 'prm_merged');
    stampLastEventAt(2 * hour);
    recordArrival('pr_maintainer', 'prm_waiting', 'prm_merged');
    stampLastEventAt(5 * hour);

    const buckets = store.countStateArrivals(['prm_merged'], 0, hour);

    assert.deepEqual(
      buckets.map((bucket) => [bucket.bucketStart, bucket.arrivalCount]),
      [
        [2 * hour, 1],
        [5 * hour, 1],
      ],
    );
  });
});

describe('Store.listEvents', () => {
  const cases: Array<{ name: string; filter: EventLogFilter; want: string[] }> = [
    {
      name: 'When nothing is filtered then should return every event, newest first',
      filter: {},
      want: ['orchestrator.started', 'sandbox.ready', 'workflow.state_changed'],
    },
    {
      name: 'When a machine is filtered then should return only its events',
      filter: { workflowType: 'pr_maintainer' },
      want: ['sandbox.ready', 'workflow.state_changed'],
    },
    {
      name: 'When an instance is filtered then should return only its events',
      filter: { workflowInstanceId: 'instance-1' },
      want: ['sandbox.ready', 'workflow.state_changed'],
    },
    {
      name: 'When a run is filtered then should return only what that run reported',
      filter: { sandboxRunId: 'seeded-run' },
      want: ['sandbox.ready'],
    },
    {
      name: 'When a repository is filtered then should return only its events',
      filter: { repositoryId: 'seeded-repository' },
      want: ['workflow.state_changed'],
    },
    {
      name: 'When a prefix is filtered then should return the family it names',
      filter: { eventTypePrefixes: ['sandbox.'] },
      want: ['sandbox.ready'],
    },
    {
      name: 'When several prefixes are filtered then should return all of them',
      filter: { eventTypePrefixes: ['sandbox.', 'orchestrator.'] },
      want: ['orchestrator.started', 'sandbox.ready'],
    },
    {
      name: 'When no prefix is filtered then should return every family',
      filter: { eventTypePrefixes: [] },
      want: ['orchestrator.started', 'sandbox.ready', 'workflow.state_changed'],
    },
    {
      name: 'When the window is in the future then should return nothing',
      filter: { since: WINDOW_AFTER_EVERY_SEED },
      want: [],
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const seededRunId = seedEvents();

      const page = store.listEvents(
        {
          ...testCase.filter,
          sandboxRunId: testCase.filter.sandboxRunId === undefined ? undefined : seededRunId,
          repositoryId: testCase.filter.repositoryId === undefined ? undefined : repositoryId,
        },
        { limit: 50 },
      );

      assert.deepEqual(page.rows.map((row) => row.eventType).sort(), [...testCase.want].sort());
    });
  }

  test('When there are more events than the page then should hand back a cursor', () => {
    seedEvents();

    const first = store.listEvents({}, { limit: 1 });
    const second = store.listEvents({}, { limit: 5, cursor: first.nextCursor ?? '' });

    assert.equal(first.rows.length, 1);
    assert.equal(second.rows.length, 2);
  });

  test('When an event carries multibyte large metadata then should return a bounded summary with states', () => {
    const metadata = JSON.stringify({
      stdout: '🙂'.repeat(1_500),
      from_state: 'prm_pending',
      to_state: 'prm_working',
    });

    store.db
      .prepare(
        `INSERT INTO event_log (
          id, event_type, workflow_type, workflow_instance_id, sandbox_run_id,
          repository_id, metadata, created_at
        ) VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run('large-event', 'agent.finished', metadata, 1);

    const [event] = store.listEvents({}, { limit: 1 }).rows;

    assert.equal(event?.fromState, 'prm_pending');
    assert.equal(event?.toState, 'prm_working');
    assert.deepEqual(JSON.parse(event?.metadata ?? '{}'), {
      truncated: true,
      original_size_bytes: Buffer.byteLength(metadata),
    });
  });
});

describe('Store.listRequests', () => {
  const cases: Array<{ name: string; filter: RequestFilter; want: number }> = [
    { name: 'When nothing is filtered then should return every ask', filter: {}, want: 2 },
    {
      name: 'When a source is filtered then should return only its asks',
      filter: { requestSource: 'github' },
      want: 1,
    },
    {
      name: 'When the window is in the future then should return nothing',
      filter: { since: WINDOW_AFTER_EVERY_SEED },
      want: 0,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      seedRequests();

      const page = store.listRequests(testCase.filter, { limit: 50 });

      assert.equal(page.rows.length, testCase.want);
    });
  }

  test('When the asker is known then should name them and their repository', () => {
    seedRequests();

    const page = store.listRequests({ requestSource: 'github' }, { limit: 50 });

    assert.equal(page.rows[0]?.repositoryFullName, 'acme/orchestrator');
    assert.equal(page.rows[0]?.requesterExternalId, 'someone');
  });

  test('When there are more asks than the page then should hand back a cursor', () => {
    seedRequests();

    const first = store.listRequests({}, { limit: 1 });

    assert.equal(first.rows.length, 1);
    assert.ok(first.nextCursor);
  });
});

describe('Store.listOurPullRequests', () => {
  test('When we opened a pull request and follow it then should be one row', () => {
    const implementer = store.openLinearImplementer({
      repositoryId,
      linearIssueId: 'iss-1',
      linearIssueIdentifier: 'JAR-61',
    });
    store.setLinearImplementerState(implementer.id, 'li_waiting_pr', { pullRequestNumber: 7 });
    const maintainer = store.openPrMaintainer({ repositoryId, pullRequestNumber: 7 });
    store.setPrMaintainerState(maintainer.id, 'prm_merged');

    const pullRequests = store.listOurPullRequests(0);

    assert.equal(pullRequests.length, 1);
    assert.equal(pullRequests[0]?.pullRequestNumber, 7);
    assert.equal(pullRequests[0]?.repositoryFullName, 'acme/orchestrator');
    assert.equal(pullRequests[0]?.workflowState, 'prm_merged');
    assert.equal(pullRequests[0]?.openedByWorkflowType, 'linear_implementer');
    assert.equal(pullRequests[0]?.openedByWorkflowInstanceId, implementer.id);
  });

  test('When two pull requests share a timestamp then should order them by number', () => {
    store.openPrMaintainer({ repositoryId, pullRequestNumber: 7 });
    store.openPrMaintainer({ repositoryId, pullRequestNumber: 11 });

    assert.deepEqual(
      store.listOurPullRequests(0).map((pullRequest) => pullRequest.pullRequestNumber),
      [11, 7],
    );
  });

  const cases: Array<{ name: string; seed(): void; since?: number; want: number }> = [
    {
      name: 'When a pull request is only followed then should return it as not opened by us',
      seed: () => {
        store.openPrMaintainer({ repositoryId, pullRequestNumber: 7 });
      },
      want: 1,
    },
    {
      name: 'When an instance has no pull request yet then should return nothing',
      seed: () => {
        store.openLinearImplementer({
          repositoryId,
          linearIssueId: 'iss-1',
          linearIssueIdentifier: 'JAR-61',
        });
      },
      want: 0,
    },
    {
      name: 'When a fix opened one then should return it',
      seed: () => {
        const fix = store.openFixImplementer({ repositoryId, findingFingerprint: 'a finding' });
        store.setFixImplementerState(fix.id, 'fi_waiting_pr', { pullRequestNumber: 9 });
      },
      want: 1,
    },
    {
      name: 'When the same number belongs to another repository then should be two rows',
      seed: () => {
        store.openPrMaintainer({ repositoryId, pullRequestNumber: 7 });
        store.openPrMaintainer({ repositoryId: otherRepositoryId, pullRequestNumber: 7 });
      },
      want: 2,
    },
    {
      name: 'When the window starts after the instance then should leave it out',
      seed: () => {
        store.openPrMaintainer({ repositoryId, pullRequestNumber: 7 });
      },
      since: WINDOW_AFTER_EVERY_SEED,
      want: 0,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      testCase.seed();

      assert.equal(store.listOurPullRequests(testCase.since ?? 0).length, testCase.want);
    });
  }
});

describe('Store.operatorSurfaceVersion', () => {
  const cases: Array<{ name: string; change(): void }> = [
    {
      name: 'When an instance moves then should change',
      change: () => {
        const instance = store.openPrMaintainer({ repositoryId, pullRequestNumber: 7 });
        store.setPrMaintainerState(instance.id, 'prm_working');
      },
    },
    {
      name: 'When a run is written then should change',
      change: () => {
        startRun('pr_maintainer', 'instance-1');
      },
    },
    {
      name: 'When an event lands then should change',
      change: () => {
        store.appendEvent({ eventType: 'orchestrator.started' });
      },
    },
    {
      name: 'When a prompt is saved then should change',
      change: () => {
        store.upsertPrompt({
          repo: '*',
          agent: 'pr_maintainer',
          instructions: 'be brief',
        });
      },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const before = store.operatorSurfaceVersion();

      testCase.change();

      assert.notEqual(store.operatorSurfaceVersion(), before);
    });
  }

  test('When nothing changed then should stay the same', () => {
    const before = store.operatorSurfaceVersion();

    assert.equal(store.operatorSurfaceVersion(), before);
  });
});

// seedOneInstancePerMachine stamps them a second apart, because the list is ordered
// by the last movement.
function seedOneInstancePerMachine(): void {
  const request = store.createRequest({
    requestSource: 'discord',
    requestText: 'do a thing',
    requesterExternalId: 'someone',
  });
  stampMovement('request_router', request.id, 1_000);

  const maintainer = store.openPrMaintainer({ repositoryId, pullRequestNumber: 7 });
  stampMovement('pr_maintainer', maintainer.id, 2_000);

  const implementer = store.openLinearImplementer({
    repositoryId,
    linearIssueId: 'iss-1',
    linearIssueIdentifier: 'JAR-61',
  });
  store.setLinearImplementerState(implementer.id, 'li_needs_human', {
    needsHumanReason: 'release_failed',
  });
  stampMovement('linear_implementer', implementer.id, 3_000);

  const fix = store.openFixImplementer({ repositoryId, findingFingerprint: 'a finding' });
  store.setFixImplementerState(fix.id, 'fi_needs_human', { needsHumanReason: 'no verdict' });
  stampMovement('fix_implementer', fix.id, 4_000);

  const scan = store.openLogReviewer({
    repositoryId: otherRepositoryId,
    serviceName: 'webapp',
    environmentName: 'production',
  });
  stampMovement('log_reviewer', scan.id, 5_000);
}

// seededFilter swaps the placeholder a case can write for the id the seed made, which
// a case cannot name: the table is built before anything is seeded.
function seededFilter(filter: WorkflowInstanceFilter): WorkflowInstanceFilter {
  return {
    ...filter,
    ...(filter.repositoryId === 'other' ? { repositoryId: otherRepositoryId } : {}),
    ...(filter.workflowInstanceId === 'seeded'
      ? {
          workflowInstanceId: store.listWorkflowInstances({ workflowType: 'pr_maintainer' }).rows[0]
            ?.workflowInstanceId,
        }
      : {}),
  };
}

function stampMovement(table: string, id: string, stateChangedAt: number): void {
  store.db.prepare(`UPDATE ${table} SET state_changed_at = ? WHERE id = ?`).run(stateChangedAt, id);
}

// seedEvents references real rows: event_log has foreign keys, so an event naming an
// unknown run or repository is dropped.
function seedEvents(): string {
  const run = startRun('pr_maintainer', 'instance-1');
  store.appendEvent({
    eventType: 'workflow.state_changed',
    workflowType: 'pr_maintainer',
    workflowInstanceId: 'instance-1',
    repositoryId,
    fromState: 'prm_pending',
    toState: 'prm_working',
  });
  store.appendEvent({
    eventType: 'sandbox.ready',
    workflowType: 'pr_maintainer',
    workflowInstanceId: 'instance-1',
    sandboxRunId: run.id,
  });
  store.appendEvent({ eventType: 'orchestrator.started' });
  return run.id;
}

function seedRequests(): void {
  store.createRequest({
    requestSource: 'github',
    requestText: 'please fix this',
    requesterExternalId: 'someone',
    repositoryId,
    subjectType: 'pull_request',
    subjectExternalId: '7',
  });
  store.createRequest({ requestSource: 'cron', repositoryId, subjectType: 'log_target' });
}

function stampLastEventAt(createdAt: number): void {
  store.db
    .prepare(
      'UPDATE event_log SET created_at = ? WHERE id = (SELECT id FROM event_log ORDER BY rowid DESC LIMIT 1)',
    )
    .run(createdAt);
}

function recordArrival(workflowType: WorkflowType, fromState: string, toState: string): void {
  store.appendEvent({
    eventType: 'workflow.state_changed',
    workflowType,
    workflowInstanceId: 'instance-1',
    fromState,
    toState,
  });
}

function startRun(workflowType: WorkflowType, workflowInstanceId: string) {
  return store.startSandboxRun({ agentName: 'PrMaintainer', workflowType, workflowInstanceId });
}
