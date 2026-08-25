import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from '../../../store/store.js';
import type { LinearImplementer, PrMaintainer, PrMaintainerState } from '../../../store/types.js';
import {
  FakeGitHub,
  FakeLocker,
  FakeSandboxPool,
  type RecordingAnnouncer,
  createRecordingAnnouncer,
} from '../../../testing/state-machines.js';
import { createTestStore } from '../../../testing/store.js';
import { retrievePullRequestConversation, runPrMaintainerFSM, setState } from './engine.js';
import { PrMaintainerStateEngine } from './service.js';

const MAX_ATTEMPTS = 2;
const MAX_REPLIES_PER_THREAD = 2;

let store: Store;
let cleanup: () => void;
let pool: FakeSandboxPool;
let engine: PrMaintainerStateEngine;
let repositoryId: string;
let announcer: RecordingAnnouncer;

beforeEach(() => {
  ({ store, cleanup } = createTestStore());
  pool = new FakeSandboxPool();
  repositoryId = store.upsertRepository('acme/web.app').id;
  announcer = createRecordingAnnouncer();
  engine = new PrMaintainerStateEngine(
    store,
    pool,
    new FakeGitHub(),
    new FakeLocker(),
    {
      maxAttempts: MAX_ATTEMPTS,
      maxRepliesPerThread: MAX_REPLIES_PER_THREAD,
      agentPullRequest: { branchPrefix: 'agent/' },
      checkWaitMs: {},
    },
    announcer,
  );
});

afterEach(() => {
  cleanup();
});

describe('runPrMaintainerFSM', () => {
  const cases: EngineCase[] = [
    {
      name: 'When the instance is pending then should dispatch and settle in `prm_working`',
      from: 'prm_pending',
      want: { state: 'prm_working', startedRuns: 1 },
    },
    {
      name: 'When the attempts are spent then should settle in `prm_attempts_exhausted`',
      from: 'prm_pending',
      arrange: (instance) => {
        instance.attemptCount = MAX_ATTEMPTS;
      },
      want: { state: 'prm_attempts_exhausted' },
    },
    {
      name: 'When waiting has an unconsumed request then should carry on to `prm_working`',
      from: 'prm_waiting',
      arrange: () => seedRequestForPullRequest(),
      want: { state: 'prm_working', startedRuns: 1 },
    },
    {
      name: 'When waiting has nothing to take then should stay in `prm_waiting`',
      from: 'prm_waiting',
      want: { state: 'prm_waiting' },
    },
    {
      name: 'When a sandbox run is in flight then should finish the loop in `prm_working`',
      from: 'prm_working',
      want: { state: 'prm_working' },
    },
    {
      name: 'When the attempts are exhausted then should finish the loop untouched',
      from: 'prm_attempts_exhausted',
      want: { state: 'prm_attempts_exhausted' },
    },
    {
      name: 'When the pull request merged then should finish the loop untouched',
      from: 'prm_merged',
      want: { state: 'prm_merged' },
    },
    {
      name: 'When the pull request closed then should finish the loop untouched',
      from: 'prm_closed',
      want: { state: 'prm_closed' },
    },
    {
      name: 'When the state is not one of the machine then should return an unsupported state error',
      from: 'prm_pending',
      arrange: (instance) => {
        instance.workflowState = 'nonsense' as PrMaintainerState;
      },
      want: { state: 'nonsense' as PrMaintainerState, errorName: 'UnsupportedStateError' },
    },
    {
      // The failure is reported and nothing claims work that did not start.
      name: 'When the handler fails then should report it and leave the instance pending',
      from: 'prm_pending',
      arrange: () => store.db.exec('DROP TABLE sandbox_run'),
      want: { state: 'prm_pending', errorName: 'Error' },
    },
    {
      name: 'When the transition cannot be persisted then should return the write failure',
      from: 'prm_pending',
      arrange: () => store.db.exec('DROP TABLE pr_maintainer'),
      want: { state: 'prm_pending', startedRuns: 1, errorName: 'Error' },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const instance = openInstance();
      setState(engine, instance, c.from);
      c.arrange?.(instance);

      const error = runPrMaintainerFSM(engine, instance);

      assert.equal(error?.constructor.name, c.want.errorName);
      assert.equal(instance.workflowState, c.want.state);
      assert.equal(pool.started.length, c.want.startedRuns ?? 0);
    });
  }
});

describe('setState', () => {
  const cases: SetStateCase[] = [
    {
      name: 'When the state changes then should write it and move `stateChangedAt`',
      nextState: 'prm_waiting',
      want: { storedState: 'prm_waiting', stampMoves: true },
    },
    {
      name: 'When the state is rewritten unchanged then should leave `stateChangedAt`',
      nextState: 'prm_pending',
      want: { storedState: 'prm_pending', stampMoves: false },
    },
    {
      name: 'When the instance carries changed fields then should write them alongside the state',
      arrange: (instance) => {
        instance.attemptCount = 3;
        instance.needsHumanReason = 'attempts_exhausted';
        instance.lastActedCommitSha = 'sha-1';
      },
      nextState: 'prm_attempts_exhausted',
      want: {
        storedState: 'prm_attempts_exhausted',
        stampMoves: true,
        attemptCount: 3,
        needsHumanReason: 'attempts_exhausted',
        lastActedCommitSha: 'sha-1',
      },
    },
    {
      // A state the column refuses is the cheapest way to make the write fail.
      name: 'When the write fails then should return the failure instead of throwing',
      nextState: 'nonsense' as PrMaintainerState,
      want: { storedState: 'prm_pending', stampMoves: false, errorName: 'Error' },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const instance = openInstance();
      instance.stateChangedAt = 0;
      c.arrange?.(instance);

      const error = setState(engine, instance, c.nextState);

      const stored = store.getPrMaintainer(instance.id);
      assert.equal(error?.constructor.name, c.want.errorName);
      assert.equal(stored?.workflowState, c.want.storedState);
      assert.equal(stored?.attemptCount, c.want.attemptCount ?? 0);
      assert.equal(stored?.needsHumanReason, c.want.needsHumanReason ?? null);
      assert.equal(stored?.lastActedCommitSha, c.want.lastActedCommitSha ?? null);
      assert.equal(instance.stateChangedAt > 0, c.want.stampMoves);
      assert.equal(
        store
          .listEventsForInstance('pr_maintainer', instance.id)
          .filter((event) => event.eventType === 'workflow.state_changed').length,
        c.want.stampMoves ? 1 : 0,
      );
    });
  }
});

describe('retrievePullRequestConversation', () => {
  const cases: Array<{
    name: string;
    withTicket: boolean;
    wantAskedBy?: { source: string; externalId: string };
  }> = [
    {
      // A ticket that opened the pull request is already being talked about somewhere, and
      // the maintainer joins that instead of starting a second conversation.
      name: 'When a ticket opened the pull request then should join the ticket conversation',
      withTicket: true,
      wantAskedBy: { source: 'discord', externalId: '1001' },
    },
    {
      name: 'When nothing opened it here then should talk about the pull request on its own',
      withTicket: false,
      wantAskedBy: { source: 'github', externalId: 'lucio' },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const askedOnGithub = store.createRequest({
        requestSource: 'github',
        repositoryId,
        requesterExternalId: 'lucio',
      });
      const instance = store.openPrMaintainer({
        repositoryId,
        pullRequestNumber: 4688,
        requestRouterId: askedOnGithub.id,
      });
      const ticket = testCase.withTicket ? seedTicketForPullRequest() : undefined;

      const conversation = retrievePullRequestConversation(engine, instance);

      assert.deepEqual(conversation, {
        key: ticket
          ? 'linear_issue:JAR-58'
          : `pull_request:${repositoryId}:${instance.pullRequestNumber}`,
        name: '#4688',
        repositoryId,
        workflowInstanceId: ticket?.id ?? instance.id,
        askedBy: testCase.wantAskedBy,
      });
    });
  }
});

// The ticket owns the pull request once it releases it, which is what the maintainer reads
// to find where the work is already being talked about.
function seedTicketForPullRequest(): LinearImplementer {
  const askedOnDiscord = store.createRequest({
    requestSource: 'discord',
    repositoryId,
    requesterExternalId: '1001',
  });
  const ticket = store.openLinearImplementer({
    repositoryId,
    linearIssueId: 'issue-1',
    linearIssueIdentifier: 'JAR-58',
    requestRouterId: askedOnDiscord.id,
  });
  store.setLinearImplementerState(ticket.id, 'li_waiting_pr', { pullRequestNumber: 4688 });
  return ticket;
}

function openInstance(): PrMaintainer {
  return store.openPrMaintainer({ repositoryId, pullRequestNumber: 4688 });
}

function seedRequestForPullRequest(): void {
  store.createRequest({
    requestSource: 'github',
    subjectType: 'pull_request',
    subjectExternalId: '4688',
    repositoryId,
  });
}

interface EngineCase {
  name: string;
  from: PrMaintainerState;
  arrange?: (instance: PrMaintainer) => void;
  want: {
    state: PrMaintainerState;
    startedRuns?: number;
    errorName?: string;
  };
}

interface SetStateCase {
  name: string;
  nextState: PrMaintainerState;
  arrange?: (instance: PrMaintainer) => void;
  want: {
    storedState: PrMaintainerState;
    stampMoves: boolean;
    attemptCount?: number;
    needsHumanReason?: string;
    lastActedCommitSha?: string;
    errorName?: string;
  };
}

describe('The moments a maintained pull request announces', () => {
  const cases: Array<{
    name: string;
    from: PrMaintainerState;
    to: PrMaintainerState;
    wantMoments: string[];
  }> = [
    {
      name: 'When the passes run out then should announce that it needs a person',
      from: 'prm_working',
      to: 'prm_attempts_exhausted',
      wantMoments: ['pullRequestMaintenanceParked'],
    },
    {
      name: 'When it merges then should announce that',
      from: 'prm_waiting',
      to: 'prm_merged',
      wantMoments: ['pullRequestMerged'],
    },
    {
      name: 'When it closes unmerged then should announce that',
      from: 'prm_waiting',
      to: 'prm_closed',
      wantMoments: ['pullRequestClosed'],
    },
    {
      // A pass starting and finishing is the machine breathing, not news.
      name: 'When a pass starts then should announce nothing',
      from: 'prm_pending',
      to: 'prm_working',
      wantMoments: [],
    },
    {
      name: 'When a pass leaves it waiting then should announce nothing',
      from: 'prm_working',
      to: 'prm_waiting',
      wantMoments: [],
    },
    {
      name: 'When the state does not change then should announce nothing',
      from: 'prm_working',
      to: 'prm_working',
      wantMoments: [],
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    test(testCase.name, () => {
      const instance = store.openPrMaintainer({ repositoryId, pullRequestNumber: 4000 + index });
      store.setPrMaintainerState(instance.id, testCase.from);
      instance.workflowState = testCase.from;

      setState(engine, instance, testCase.to);

      assert.deepEqual(announcer.moments, testCase.wantMoments);
    });
  }
});
