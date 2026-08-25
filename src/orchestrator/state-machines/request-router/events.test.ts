import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { CreateRequestInput, Store } from '../../../store/store.js';
import type { RequestRouter, RequestRouterState, SandboxRunState } from '../../../store/types.js';
import { FakeLocker, FakeSandboxPool } from '../../../testing/state-machines.js';
import { createTestStore } from '../../../testing/store.js';
import { setState } from './engine.js';
import {
  onPeriodicCheck,
  onRequestReceived,
  onSandboxRunFailed,
  onSandboxRunSucceeded,
  onSystemRecovery,
  type RoutingOutcome,
} from './events.js';
import { RequestRouterStateEngine } from './service.js';

let store: Store;
let cleanup: () => void;
let pool: FakeSandboxPool;
let locker: FakeLocker;
let engine: RequestRouterStateEngine;

beforeEach(() => {
  ({ store, cleanup } = createTestStore());
  pool = new FakeSandboxPool();
  locker = new FakeLocker();
  engine = new RequestRouterStateEngine(store, pool, locker, {
    checkWaitMs: { rr_pending: 0, rr_routing: 0 },
  });
});

afterEach(() => {
  cleanup();
});

describe('onRequestReceived', () => {
  const cases: ReceivedCase[] = [
    {
      // Free text is the only thing that costs an agent.
      name: 'When the request is free text then should dispatch the router agent',
      input: { requestSource: 'discord', requestText: 'fix this' },
      want: { state: 'rr_routing', startedRuns: 1 },
    },
    {
      name: 'When the event carries its subject then should resolve it with no agent',
      input: {
        requestSource: 'github',
        subjectType: 'pull_request',
        subjectExternalId: '4688',
      },
      want: { state: 'rr_resolved' },
    },
    {
      // A request nobody will act on is still written, or a discarded ask is
      // one we can never look at afterwards.
      name: 'When the request comes from cron then should still record it',
      input: { requestSource: 'cron' },
      want: { state: 'rr_routing', startedRuns: 1 },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const error = await onRequestReceived(engine, c.input);

      assert.equal(error?.constructor.name, c.want.errorName);
      const [stored] = store.db.prepare('SELECT * FROM request_router').all() as Array<{
        workflow_state: string;
      }>;
      assert.equal(stored.workflow_state, c.want.state);
      assert.equal(pool.started.length, c.want.startedRuns ?? 0);
    });
  }
});

describe('onSandboxRunSucceeded', () => {
  const cases: RunOutcomeCase[] = [
    {
      name: 'When the agent placed the request then should resolve it with its subject',
      from: 'rr_routing',
      outcome: {
        subjectType: 'linear_issue',
        subjectExternalId: 'JAR-58',
      },
      want: { state: 'rr_resolved', subjectExternalId: 'JAR-58' },
    },
    {
      // The questions the agent produced are the answer we give the asker.
      name: 'When the agent found no subject then should end it unresolvable with its note',
      from: 'rr_routing',
      outcome: { resolutionNote: 'which repository?' },
      want: { state: 'rr_unresolvable', resolutionNote: 'which repository?' },
    },
    {
      name: 'When the agent answered nothing at all then should end it unresolvable',
      from: 'rr_routing',
      outcome: {},
      want: { state: 'rr_unresolvable', resolutionNote: 'no_subject_found' },
    },
    {
      name: 'When the instance moved on from that run then should ignore it',
      from: 'rr_routing',
      detachRun: true,
      outcome: { subjectType: 'linear_issue', subjectExternalId: 'JAR-58' },
      want: { state: 'rr_routing' },
    },
    {
      name: 'When the instance is not routing then should ignore it',
      from: 'rr_pending',
      outcome: { subjectType: 'linear_issue', subjectExternalId: 'JAR-58' },
      want: { state: 'rr_pending' },
    },
    {
      name: 'When the run belongs to another workflow then should ignore it',
      from: 'rr_routing',
      foreignRun: true,
      outcome: {},
      want: { state: 'rr_routing' },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = openInstanceIn(c.from);
      const runId = attachRun(instance, c);

      const error = await onSandboxRunSucceeded(engine, runId, c.outcome ?? {});

      assertOutcome(c.want, instance, error);
    });
  }
});

describe('onSandboxRunFailed', () => {
  const cases: RunOutcomeCase[] = [
    {
      name: 'When the router agent failed then should end it unresolvable',
      from: 'rr_routing',
      want: { state: 'rr_unresolvable', resolutionNote: 'routing_run_failed' },
    },
    {
      name: 'When the instance moved on from that run then should ignore it',
      from: 'rr_routing',
      detachRun: true,
      want: { state: 'rr_routing' },
    },
    {
      name: 'When the instance is not routing then should ignore it',
      from: 'rr_pending',
      want: { state: 'rr_pending' },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = openInstanceIn(c.from);
      const runId = attachRun(instance, c);

      const error = await onSandboxRunFailed(engine, runId);

      assertOutcome(c.want, instance, error);
    });
  }
});

describe('onPeriodicCheck', () => {
  const cases: PeriodicCase[] = [
    {
      name: 'When the state has no cadence then should never look at it',
      from: 'rr_resolved',
      want: { state: 'rr_resolved' },
    },
    {
      name: 'When the wait has not elapsed then should leave it alone',
      from: 'rr_pending',
      arrange: (instance) => {
        engine.config.checkWaitMs.rr_pending = 60_000;
        store.markRequestChecked(instance.id);
      },
      want: { state: 'rr_pending' },
    },
    {
      name: 'When the dispatch is still owed then should retry it',
      from: 'rr_pending',
      want: { state: 'rr_routing', startedRuns: 1 },
    },
    {
      name: 'When the run is still in the pool then should leave it routing',
      from: 'rr_routing',
      attachLiveRun: true,
      want: { state: 'rr_routing' },
    },
    {
      // Routing is cheap and reads nothing it wrote, so asking again beats
      // answering a person with a question we could still resolve.
      name: 'When the run died with the process then should route again',
      from: 'rr_routing',
      attachLostRun: true,
      want: { state: 'rr_routing', startedRuns: 1 },
    },
    {
      name: 'When the run finished without telling us then should end it unresolvable',
      from: 'rr_routing',
      attachFinishedRun: 'succeeded',
      want: { state: 'rr_unresolvable', resolutionNote: 'routing_outcome_lost' },
    },
    {
      name: 'When the outcome is still on its way then should leave it routing',
      from: 'rr_routing',
      attachFinishedRun: 'succeeded',
      keepInPool: true,
      want: { state: 'rr_routing' },
    },
    {
      name: 'When the instance is unknown then should ignore it',
      unknownInstance: true,
      want: {},
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.unknownInstance ? undefined : openInstanceIn(c.from as RequestRouterState);
      if (instance) arrangePeriodic(instance, c);

      const error = await onPeriodicCheck(engine, instance?.id ?? 'missing');

      assertOutcome(c.want, instance, error);
    });
  }
});

describe('onSystemRecovery', () => {
  const cases: PeriodicCase[] = [
    {
      name: 'When the dispatch never happened then should dispatch it',
      from: 'rr_pending',
      want: { state: 'rr_routing', startedRuns: 1 },
    },
    {
      name: 'When the run survived the restart then should leave it routing',
      from: 'rr_routing',
      attachLiveRun: true,
      want: { state: 'rr_routing' },
    },
    {
      name: 'When the run died with the process then should route again',
      from: 'rr_routing',
      attachLostRun: true,
      want: { state: 'rr_routing', startedRuns: 1 },
    },
    {
      name: 'When the request already resolved then should return an unsupported state error',
      from: 'rr_resolved',
      want: { state: 'rr_resolved', errorName: 'UnsupportedStateError' },
    },
    {
      name: 'When the instance is unknown then should ignore it',
      unknownInstance: true,
      want: {},
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.unknownInstance ? undefined : openInstanceIn(c.from as RequestRouterState);
      if (instance) arrangePeriodic(instance, c);

      const error = await onSystemRecovery(engine, instance?.id ?? 'missing');

      assertOutcome(c.want, instance, error);
    });
  }
});

// Every entry point has to hand back the instance lock it took, whatever it
// decided, or a second event for the same request would hang.
describe('RequestRouter entry points release the instance lock', () => {
  const cases: LockCase[] = [
    {
      name: 'When `onRequestReceived` runs then should release the lock',
      act: () => onRequestReceived(engine, { requestSource: 'discord', requestText: 'x' }),
    },
    {
      name: 'When `onPeriodicCheck` runs then should release the lock',
      act: (id) => onPeriodicCheck(engine, id),
    },
    {
      name: 'When `onSystemRecovery` runs then should release the lock',
      act: (id) => onSystemRecovery(engine, id),
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = openInstanceIn('rr_pending');

      await c.act(instance.id);

      assert.equal(locker.isBalanced, true);
      assert.ok(locker.acquired.length > 0);
    });
  }
});

function openInstanceIn(state: RequestRouterState): RequestRouter {
  const instance = store.createRequest({ requestSource: 'discord', requestText: 'fix this' });
  setState(engine, instance, state);
  return instance;
}

function attachRun(instance: RequestRouter, c: RunOutcomeCase): string {
  const runId = store.startSandboxRun({
    agentName: 'RequestRouter',
    workflowType: c.foreignRun ? 'pr_maintainer' : 'request_router',
    workflowInstanceId: instance.id,
  }).id;
  if (!c.detachRun && !c.foreignRun) {
    instance.sandboxRunId = runId;
    setState(engine, instance, instance.workflowState);
  }
  return runId;
}

function arrangePeriodic(instance: RequestRouter, c: PeriodicCase): void {
  if (c.attachLiveRun || c.attachLostRun || c.attachFinishedRun) {
    const runId = store.startSandboxRun({
      agentName: 'RequestRouter',
      workflowType: 'request_router',
      workflowInstanceId: instance.id,
    }).id;
    instance.sandboxRunId = runId;
    setState(engine, instance, instance.workflowState);
    pool.startSandbox(runId);
    pool.started.length = 0;
    if (c.attachLostRun) pool.loseFromPool(runId);
    if (c.attachFinishedRun) {
      store.finishSandboxRun(runId, { runState: c.attachFinishedRun });
      if (!c.keepInPool) pool.loseFromPool(runId);
    }
  }
  c.arrange?.(instance);
}

function assertOutcome(
  want: Want,
  instance: RequestRouter | undefined,
  error: Error | undefined,
): void {
  assert.equal(error?.constructor.name, want.errorName);
  assert.equal(pool.started.length, want.startedRuns ?? 0);
  if (!instance) return;
  const stored = store.getRequest(instance.id);
  assert.equal(stored?.workflowState, want.state);
  assert.equal(stored?.subjectExternalId, want.subjectExternalId ?? null);
  assert.equal(stored?.resolutionNote, want.resolutionNote ?? null);
}

interface Want {
  state?: RequestRouterState;
  startedRuns?: number;
  subjectExternalId?: string;
  resolutionNote?: string;
  errorName?: string;
}

interface ReceivedCase {
  name: string;
  input: CreateRequestInput;
  want: Want;
}

interface RunOutcomeCase {
  name: string;
  from: RequestRouterState;
  outcome?: RoutingOutcome;
  detachRun?: boolean;
  foreignRun?: boolean;
  want: Want;
}

interface PeriodicCase {
  name: string;
  from?: RequestRouterState;
  unknownInstance?: boolean;
  attachLiveRun?: boolean;
  attachLostRun?: boolean;
  attachFinishedRun?: Exclude<SandboxRunState, 'pending' | 'running'>;
  keepInPool?: boolean;
  arrange?: (instance: RequestRouter) => void;
  want: Want;
}

interface LockCase {
  name: string;
  act: (requestRouterId: string) => Promise<Error | undefined>;
}
