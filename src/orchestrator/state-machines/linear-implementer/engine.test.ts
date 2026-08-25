import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from '../../../store/store.js';
import type { LinearImplementer, LinearImplementerState } from '../../../store/types.js';
import {
  FakeGitHub,
  FakeLocker,
  FakeSandboxPool,
  type RecordingAnnouncer,
  createRecordingAnnouncer,
} from '../../../testing/state-machines.js';
import { createTestStore } from '../../../testing/store.js';
import { runLinearImplementerFSM, setState } from './engine.js';
import { LinearImplementerStateEngine } from './service.js';

let store: Store;
let cleanup: () => void;
let pool: FakeSandboxPool;
let github: FakeGitHub;
let engine: LinearImplementerStateEngine;
let repositoryId: string;
let announcer: RecordingAnnouncer;

beforeEach(() => {
  ({ store, cleanup } = createTestStore());
  pool = new FakeSandboxPool();
  github = new FakeGitHub();
  repositoryId = store.upsertRepository('acme/web.app').id;
  announcer = createRecordingAnnouncer();
  engine = new LinearImplementerStateEngine(
    store,
    pool,
    github,
    new FakeLocker(),
    { maxIterations: 2, checkWaitMs: {} },
    announcer,
  );
});

afterEach(() => {
  cleanup();
});

describe('runLinearImplementerFSM', () => {
  const cases: EngineCase[] = [
    {
      // li_pending owns no agent, so the loop carries it straight into the
      // state that does and dispatches there.
      name: 'When the ticket is pending then should carry on and dispatch the implementer',
      from: 'li_pending',
      want: { state: 'li_implementing', startedRuns: 1 },
    },
    {
      name: 'When implementing has nothing in flight then should dispatch and stay',
      from: 'li_implementing',
      want: { state: 'li_implementing', startedRuns: 1 },
    },
    {
      name: 'When verifying has nothing in flight then should dispatch and stay',
      from: 'li_verifying',
      want: { state: 'li_verifying', startedRuns: 1 },
    },
    {
      name: 'When a person has to look at it then should finish the loop untouched',
      from: 'li_needs_human',
      want: { state: 'li_needs_human' },
    },
    {
      name: 'When the pull request is being waited on then should finish the loop untouched',
      from: 'li_waiting_pr',
      want: { state: 'li_waiting_pr' },
    },
    {
      name: 'When the ticket is done then should finish the loop untouched',
      from: 'li_done',
      want: { state: 'li_done' },
    },
    {
      name: 'When the ticket was abandoned then should finish the loop untouched',
      from: 'li_abandoned',
      want: { state: 'li_abandoned' },
    },
    {
      name: 'When the state is not one of the machine then should return an unsupported state error',
      from: 'li_pending',
      arrange: (instance) => {
        instance.workflowState = 'nonsense' as LinearImplementerState;
      },
      want: { state: 'nonsense' as LinearImplementerState, errorName: 'UnsupportedStateError' },
    },
    {
      name: 'When the dispatch cannot be recorded then should report it and stay implementing',
      from: 'li_implementing',
      arrange: () => store.db.exec('DROP TABLE sandbox_run'),
      want: { state: 'li_implementing', errorName: 'Error' },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const instance = openInstance();
      setState(engine, instance, c.from);
      c.arrange?.(instance);

      const error = runLinearImplementerFSM(engine, instance);

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
      nextState: 'li_implementing',
      want: { storedState: 'li_implementing', stampMoves: true },
    },
    {
      name: 'When the state is rewritten unchanged then should leave `stateChangedAt`',
      nextState: 'li_pending',
      want: { storedState: 'li_pending', stampMoves: false },
    },
    {
      name: 'When the instance carries what the pass produced then should write it alongside the state',
      arrange: (instance) => {
        instance.pullRequestNumber = 4688;
        instance.iterationNumber = 2;
        instance.promptContext = '<issue identifier="JAR-58"/>';
      },
      nextState: 'li_verifying',
      want: {
        storedState: 'li_verifying',
        stampMoves: true,
        pullRequestNumber: 4688,
        iterationNumber: 2,
        promptContext: '<issue identifier="JAR-58"/>',
      },
    },
    {
      // A state the column refuses is the cheapest way to make the write fail.
      name: 'When the write fails then should return the failure instead of throwing',
      nextState: 'nonsense' as LinearImplementerState,
      want: { storedState: 'li_pending', stampMoves: false, errorName: 'Error' },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const instance = openInstance();
      instance.stateChangedAt = 0;
      c.arrange?.(instance);

      const error = setState(engine, instance, c.nextState);

      const stored = store.getLinearImplementer(instance.id);
      assert.equal(error?.constructor.name, c.want.errorName);
      assert.equal(stored?.workflowState, c.want.storedState);
      assert.equal(stored?.pullRequestNumber, c.want.pullRequestNumber ?? null);
      assert.equal(stored?.iterationNumber, c.want.iterationNumber ?? 0);
      assert.equal(stored?.promptContext, c.want.promptContext ?? null);
      assert.equal(instance.stateChangedAt > 0, c.want.stampMoves);
      assert.equal(
        store
          .listEventsForInstance('linear_implementer', instance.id)
          .filter((event) => event.eventType === 'workflow.state_changed').length,
        c.want.stampMoves ? 1 : 0,
      );
    });
  }
});

function openInstance(): LinearImplementer {
  return store.openLinearImplementer({
    repositoryId,
    linearIssueId: 'iss-1',
    linearIssueIdentifier: 'JAR-58',
  });
}

interface EngineCase {
  name: string;
  from: LinearImplementerState;
  arrange?: (instance: LinearImplementer) => void;
  want: { state: LinearImplementerState; startedRuns?: number; errorName?: string };
}

interface SetStateCase {
  name: string;
  nextState: LinearImplementerState;
  arrange?: (instance: LinearImplementer) => void;
  want: {
    storedState: LinearImplementerState;
    stampMoves: boolean;
    pullRequestNumber?: number;
    iterationNumber?: number;
    promptContext?: string;
    errorName?: string;
  };
}

describe('The moments a ticket announces', () => {
  const cases: Array<{
    name: string;
    from: LinearImplementerState;
    to: LinearImplementerState;
    wantMoments: string[];
  }> = [
    {
      name: 'When it starts writing then should announce that',
      from: 'li_pending',
      to: 'li_implementing',
      wantMoments: ['ticketImplementationStarted'],
    },
    {
      name: 'When it comes back from verification then should announce the rejection',
      from: 'li_verifying',
      to: 'li_implementing',
      wantMoments: ['ticketRejectedByVerifier'],
    },
    {
      name: 'When it starts verifying then should announce that',
      from: 'li_implementing',
      to: 'li_verifying',
      wantMoments: ['ticketVerificationStarted'],
    },
    {
      // The maintainer adopts that pull request and announces it there.
      name: 'When the pull request is released then should announce nothing',
      from: 'li_verifying',
      to: 'li_waiting_pr',
      wantMoments: [],
    },
    {
      name: 'When it parks then should announce that',
      from: 'li_implementing',
      to: 'li_needs_human',
      wantMoments: ['ticketParked'],
    },
    {
      // How the pull request ended belongs to the maintainer, which owns it from the
      // moment this machine releases it.
      name: 'When the pull request merged then should announce nothing',
      from: 'li_waiting_pr',
      to: 'li_done',
      wantMoments: [],
    },
    {
      name: 'When the state does not change then should announce nothing',
      from: 'li_implementing',
      to: 'li_implementing',
      wantMoments: [],
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const instance = store.openLinearImplementer({
        repositoryId,
        linearIssueId: `issue-${testCase.to}-${testCase.from}`,
        linearIssueIdentifier: 'JAR-58',
      });
      store.setLinearImplementerState(instance.id, testCase.from);
      instance.workflowState = testCase.from;

      setState(engine, instance, testCase.to);

      assert.deepEqual(announcer.moments, testCase.wantMoments);
    });
  }
});
