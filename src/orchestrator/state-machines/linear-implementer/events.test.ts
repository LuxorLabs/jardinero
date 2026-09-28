import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from '../../../store/store.js';
import type {
  LinearImplementer,
  LinearImplementerState,
  SandboxRunState,
} from '../../../store/types.js';
import { FakeGitHub, FakeLocker, FakeSandboxPool } from '../../../testing/state-machines.js';
import { createTestStore } from '../../../testing/store.js';
import { setState } from './engine.js';
import {
  onIssueAssigned,
  onIssueCommented,
  onOperatorDismiss,
  onOperatorRetry,
  onOperatorRetryVerification,
  onPeriodicCheck,
  onPrClosed,
  onPrMerged,
  onSandboxRunFailed,
  onSandboxRunSucceeded,
  onSystemRecovery,
  type RunOutcome,
} from './events.js';
import { LinearImplementerStateEngine } from './service.js';

const MAX_ITERATIONS = 2;
const PULL_REQUEST_NUMBER = 4688;
const FINISHED_RUN_COST_USD = 1.25;

let store: Store;
let cleanup: () => void;
let pool: FakeSandboxPool;
let locker: FakeLocker;
let github: FakeGitHub;
let engine: LinearImplementerStateEngine;
let repositoryId: string;

beforeEach(() => {
  ({ store, cleanup } = createTestStore());
  pool = new FakeSandboxPool();
  github = new FakeGitHub();
  locker = new FakeLocker();
  repositoryId = store.upsertRepository('acme/web.app').id;
  engine = new LinearImplementerStateEngine(store, pool, github, locker, {
    maxIterations: MAX_ITERATIONS,
    checkWaitMs: { li_pending: 0, li_implementing: 0, li_verifying: 0, li_waiting_pr: 0 },
  });
});

afterEach(() => {
  cleanup();
});

describe('onIssueAssigned', () => {
  const cases: StateCase[] = [
    {
      name: 'When there is no instance yet then should open one and dispatch the implementer',
      want: { state: 'li_implementing', startedRuns: 1 },
    },
    {
      name: 'When the dispatch is still owed then should dispatch it',
      from: 'li_pending',
      want: { state: 'li_implementing', startedRuns: 1 },
    },
    ...['li_implementing', 'li_verifying', 'li_waiting_pr'].map((state) => ({
      name: `When the ticket is already being worked in \`${state}\` then should leave it alone`,
      from: state as LinearImplementerState,
      want: { state: state as LinearImplementerState },
    })),
    {
      // Re-assigning something we gave up on is a person asking again, and the
      // corrective budget starts over or it would bounce straight back.
      name: 'When we gave up on it then should start again with a fresh budget',
      from: 'li_needs_human',
      arrange: (instance) => {
        instance.iterationNumber = MAX_ITERATIONS;
        instance.needsHumanReason = 'iterations_exhausted';
        setState(engine, instance, 'li_needs_human');
      },
      want: { state: 'li_implementing', startedRuns: 1 },
    },
    {
      // The pull request was closed unmerged, so the ticket is still open work.
      name: 'When the ticket was abandoned then should start a second pass',
      from: 'li_abandoned',
      want: { state: 'li_implementing', startedRuns: 1 },
    },
    {
      name: 'When the ticket is already delivered then should refuse to start again',
      from: 'li_done',
      want: { state: 'li_done' },
      askStaysOpen: true,
    },
    {
      name: 'When the ticket was dismissed then should refuse to start again',
      from: 'li_dismissed',
      want: { state: 'li_dismissed' },
      askStaysOpen: true,
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.from ? openInstanceIn(c.from) : undefined;
      if (instance) c.arrange?.(instance);

      const error = await onIssueAssigned(engine, issueRef());

      assertOutcome(c.want, instance ?? store.findLinearImplementerByIssue('iss-1'), error);
    });
  }

  test('When a delegation carries an ask then should record which instance took it', async () => {
    const request = store.createRequest({
      requestSource: 'linear',
      repositoryId,
      subjectType: 'linear_issue',
      subjectExternalId: 'JAR-58',
    });

    await onIssueAssigned(engine, issueRef(), request.id);

    const stored = store.getRequest(request.id);
    assert.equal(stored?.workflowType, 'linear_implementer');
    assert.equal(stored?.workflowInstanceId, store.findLinearImplementerByIssue('iss-1')?.id);
    assert.notEqual(stored?.consumedAt, null);
  });
});

describe('onIssueCommented', () => {
  const cases: StateCase[] = [
    {
      name: 'When there is no instance then should ignore it',
      want: { instanceExists: false },
    },
    ...['li_pending', 'li_implementing', 'li_verifying', 'li_waiting_pr'].map((state) => ({
      // The comment is recorded as an unconsumed request either way, so a pass
      // in flight picks it up when it lands.
      name: `When the ticket is in \`${state}\` then should ignore it`,
      from: state as LinearImplementerState,
      want: { state: state as LinearImplementerState },
    })),
    {
      name: 'When we gave up on it then should start again with a fresh budget',
      from: 'li_needs_human',
      want: { state: 'li_implementing', startedRuns: 1 },
    },
    {
      name: 'When the ticket already ended then should ignore it',
      from: 'li_done',
      want: { state: 'li_done' },
    },
    {
      name: 'When the ticket was dismissed then should ignore it',
      from: 'li_dismissed',
      want: { state: 'li_dismissed' },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.from ? openInstanceIn(c.from) : undefined;

      const error = await onIssueCommented(engine, issueRef());

      assertOutcome(c.want, instance, error);
    });
  }
});

describe('onPrMerged', () => {
  const cases: ClosingCase[] = [
    {
      name: 'When there is no instance then should ignore it',
      want: { instanceExists: false },
    },
    {
      name: 'When the ticket was in `li_pending` then should close it as `li_done`',
      from: 'li_pending',
      want: { state: 'li_done', pullRequestNumber: PULL_REQUEST_NUMBER },
    },
    {
      name: 'When the ticket was in `li_needs_human` then should close it as `li_done`',
      from: 'li_needs_human',
      want: { state: 'li_done', pullRequestNumber: PULL_REQUEST_NUMBER },
    },
    {
      name: 'When the ticket was in `li_waiting_pr` then should close it as `li_done`',
      from: 'li_waiting_pr',
      want: { state: 'li_done', pullRequestNumber: PULL_REQUEST_NUMBER },
    },
    {
      name: 'When the ticket was in `li_implementing` with no sandbox run then should close it as `li_done`',
      from: 'li_implementing',
      want: { state: 'li_done', pullRequestNumber: PULL_REQUEST_NUMBER },
    },
    {
      name: 'When a sandbox run is in flight in `li_implementing` then should abort it and close as `li_done`',
      from: 'li_implementing',
      run: 'in_flight',
      want: {
        state: 'li_done',
        pullRequestNumber: PULL_REQUEST_NUMBER,
        abortedRuns: 1,
        sandboxRun: { runState: 'pending', costUsd: null },
      },
    },
    {
      name: 'When the sandbox run in `li_implementing` finished and its outcome is on its way then should keep its cost and close as `li_done`',
      from: 'li_implementing',
      run: 'reporting',
      want: {
        state: 'li_done',
        pullRequestNumber: PULL_REQUEST_NUMBER,
        abortedRuns: 1,
        sandboxRun: { runState: 'succeeded', costUsd: FINISHED_RUN_COST_USD },
      },
    },
    {
      name: 'When the pool lost the sandbox run in `li_implementing` then should record it aborted and close as `li_done`',
      from: 'li_implementing',
      run: 'lost',
      want: {
        state: 'li_done',
        pullRequestNumber: PULL_REQUEST_NUMBER,
        sandboxRun: { runState: 'aborted', costUsd: null },
      },
    },
    {
      name: 'When the sandbox run in `li_implementing` finished unreported then should keep its cost and close as `li_done`',
      from: 'li_implementing',
      run: 'finished',
      want: {
        state: 'li_done',
        pullRequestNumber: PULL_REQUEST_NUMBER,
        sandboxRun: { runState: 'succeeded', costUsd: FINISHED_RUN_COST_USD },
      },
    },
    {
      name: 'When a sandbox run is in flight in `li_verifying` then should abort it and close as `li_done`',
      from: 'li_verifying',
      run: 'in_flight',
      want: {
        state: 'li_done',
        pullRequestNumber: PULL_REQUEST_NUMBER,
        abortedRuns: 1,
        sandboxRun: { runState: 'pending', costUsd: null },
      },
    },
    {
      name: 'When the ticket was dismissed then should ignore it',
      from: 'li_dismissed',
      want: { state: 'li_dismissed', pullRequestNumber: PULL_REQUEST_NUMBER },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.from ? openInstanceWithPullRequest(c.from) : undefined;
      const sandboxRunId = instance ? arrangeClosing(instance, c) : undefined;

      const error = await onPrMerged(engine, pullRequestRef());

      assertClosing(c, instance, sandboxRunId, error);
    });
  }
});
describe('onPrClosed', () => {
  const cases: ClosingCase[] = [
    {
      name: 'When there is no instance then should ignore it',
      want: { instanceExists: false },
    },
    {
      name: 'When the ticket was in `li_pending` then should close it as `li_abandoned`',
      from: 'li_pending',
      want: { state: 'li_abandoned', pullRequestNumber: PULL_REQUEST_NUMBER },
    },
    {
      name: 'When the ticket was in `li_needs_human` then should close it as `li_abandoned`',
      from: 'li_needs_human',
      want: { state: 'li_abandoned', pullRequestNumber: PULL_REQUEST_NUMBER },
    },
    {
      name: 'When the ticket was in `li_waiting_pr` then should close it as `li_abandoned`',
      from: 'li_waiting_pr',
      want: { state: 'li_abandoned', pullRequestNumber: PULL_REQUEST_NUMBER },
    },
    {
      name: 'When the ticket was in `li_implementing` with no sandbox run then should close it as `li_abandoned`',
      from: 'li_implementing',
      want: { state: 'li_abandoned', pullRequestNumber: PULL_REQUEST_NUMBER },
    },
    {
      name: 'When a sandbox run is in flight in `li_implementing` then should abort it and close as `li_abandoned`',
      from: 'li_implementing',
      run: 'in_flight',
      want: {
        state: 'li_abandoned',
        pullRequestNumber: PULL_REQUEST_NUMBER,
        abortedRuns: 1,
        sandboxRun: { runState: 'pending', costUsd: null },
      },
    },
    {
      name: 'When the sandbox run in `li_implementing` finished and its outcome is on its way then should keep its cost and close as `li_abandoned`',
      from: 'li_implementing',
      run: 'reporting',
      want: {
        state: 'li_abandoned',
        pullRequestNumber: PULL_REQUEST_NUMBER,
        abortedRuns: 1,
        sandboxRun: { runState: 'succeeded', costUsd: FINISHED_RUN_COST_USD },
      },
    },
    {
      name: 'When the pool lost the sandbox run in `li_implementing` then should record it aborted and close as `li_abandoned`',
      from: 'li_implementing',
      run: 'lost',
      want: {
        state: 'li_abandoned',
        pullRequestNumber: PULL_REQUEST_NUMBER,
        sandboxRun: { runState: 'aborted', costUsd: null },
      },
    },
    {
      name: 'When the sandbox run in `li_implementing` finished unreported then should keep its cost and close as `li_abandoned`',
      from: 'li_implementing',
      run: 'finished',
      want: {
        state: 'li_abandoned',
        pullRequestNumber: PULL_REQUEST_NUMBER,
        sandboxRun: { runState: 'succeeded', costUsd: FINISHED_RUN_COST_USD },
      },
    },
    {
      name: 'When a sandbox run is in flight in `li_verifying` then should abort it and close as `li_abandoned`',
      from: 'li_verifying',
      run: 'in_flight',
      want: {
        state: 'li_abandoned',
        pullRequestNumber: PULL_REQUEST_NUMBER,
        abortedRuns: 1,
        sandboxRun: { runState: 'pending', costUsd: null },
      },
    },
    {
      name: 'When the ticket was dismissed then should ignore it',
      from: 'li_dismissed',
      want: { state: 'li_dismissed', pullRequestNumber: PULL_REQUEST_NUMBER },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.from ? openInstanceWithPullRequest(c.from) : undefined;
      const sandboxRunId = instance ? arrangeClosing(instance, c) : undefined;

      const error = await onPrClosed(engine, pullRequestRef());

      assertClosing(c, instance, sandboxRunId, error);
    });
  }
});
describe('onSandboxRunSucceeded', () => {
  const cases: RunOutcomeCase[] = [
    {
      name: 'When the implementer opened a pull request then should verify it',
      from: 'li_implementing',
      outcome: { pullRequestNumber: PULL_REQUEST_NUMBER },
      want: { state: 'li_verifying', startedRuns: 1, pullRequestNumber: PULL_REQUEST_NUMBER },
    },
    {
      // A pass that ends without a pull request produced nothing to verify.
      name: 'When the implementer opened no pull request then should ask a person',
      from: 'li_implementing',
      outcome: {},
      want: { state: 'li_needs_human', needsHumanReason: 'no_pull_request' },
    },
    {
      name: 'When the verifier accepted then should release the pull request',
      from: 'li_verifying',
      withPullRequest: true,
      outcome: { verdict: 'accept', verifiedCommitSha: 'sha-1' },
      want: {
        state: 'li_waiting_pr',
        verifierVerdict: 'accept',
        pullRequestNumber: PULL_REQUEST_NUMBER,
        released: [PULL_REQUEST_NUMBER],
      },
    },
    {
      // A draft nobody can release is a ticket that looks delivered and is not, so
      // it stops and asks instead.
      name: 'When the pull request cannot be released then should ask a person',
      from: 'li_verifying',
      withPullRequest: true,
      arrange: () => {
        github.refusal = new Error('github unreachable');
      },
      outcome: { verdict: 'accept', verifiedCommitSha: 'sha-1' },
      want: {
        state: 'li_needs_human',
        needsHumanReason: 'release_failed',
        pullRequestNumber: PULL_REQUEST_NUMBER,
        verifierVerdict: 'accept',
        released: [],
      },
    },
    {
      name: 'When the verifier rejected and iterations are left then should correct the same pull request',
      from: 'li_verifying',
      withPullRequest: true,
      outcome: { verdict: 'reject', verifierIssues: 'tests missing' },
      want: {
        state: 'li_implementing',
        startedRuns: 1,
        iterationNumber: 1,
        verifierVerdict: 'reject',
        pullRequestNumber: PULL_REQUEST_NUMBER,
      },
    },
    {
      name: 'When the verifier rejected and the iterations are spent then should ask a person',
      from: 'li_verifying',
      arrange: (instance) => {
        instance.iterationNumber = MAX_ITERATIONS;
        setState(engine, instance, 'li_verifying');
      },
      outcome: { verdict: 'reject' },
      want: {
        state: 'li_needs_human',
        needsHumanReason: 'iterations_exhausted',
        iterationNumber: MAX_ITERATIONS + 1,
        verifierVerdict: 'reject',
      },
    },
    {
      name: 'When the verifier produced no verdict and iterations are left then should verify again',
      from: 'li_verifying',
      outcome: { hasVerdict: false },
      want: { state: 'li_verifying', startedRuns: 1, iterationNumber: 1 },
    },
    {
      name: 'When the verifier produced no verdict and the iterations are spent then should ask a person',
      from: 'li_verifying',
      arrange: (instance) => {
        instance.iterationNumber = MAX_ITERATIONS;
        setState(engine, instance, 'li_verifying');
      },
      outcome: {},
      want: {
        state: 'li_needs_human',
        needsHumanReason: 'iterations_exhausted',
        iterationNumber: MAX_ITERATIONS + 1,
      },
    },
    {
      name: 'When the instance moved on from that run then should ignore it',
      from: 'li_implementing',
      detachRun: true,
      outcome: { pullRequestNumber: PULL_REQUEST_NUMBER },
      want: { state: 'li_implementing' },
    },
    {
      name: 'When the instance is not running an agent then should ignore it',
      from: 'li_waiting_pr',
      outcome: {},
      want: { state: 'li_waiting_pr' },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.withPullRequest
        ? openInstanceWithPullRequest(c.from)
        : openInstanceIn(c.from);
      const runId = attachRun(instance, c);
      c.arrange?.(instance);

      const error = await onSandboxRunSucceeded(engine, runId, c.outcome ?? {});

      assertOutcome(c.want, instance, error);
    });
  }
});

describe('onSandboxRunFailed', () => {
  const cases: RunOutcomeCase[] = [
    {
      name: 'When the first implementer run died then should run the same pass again',
      from: 'li_implementing',
      want: { state: 'li_implementing', startedRuns: 1, iterationNumber: 1 },
    },
    {
      name: 'When an implementer run failed after opening its pull request then should continue that pull request',
      from: 'li_implementing',
      outcome: { pullRequestNumber: 4700 },
      want: {
        state: 'li_implementing',
        startedRuns: 1,
        iterationNumber: 1,
        pullRequestNumber: 4700,
      },
    },
    {
      name: 'When a continuing implementer run failed without reporting it then should keep the pull request it continues',
      from: 'li_implementing',
      withPullRequest: true,
      outcome: {},
      want: {
        state: 'li_implementing',
        startedRuns: 1,
        iterationNumber: 1,
        pullRequestNumber: PULL_REQUEST_NUMBER,
      },
    },
    {
      name: 'When the first verifier run died then should verify again',
      from: 'li_verifying',
      want: { state: 'li_verifying', startedRuns: 1, iterationNumber: 1 },
    },
    {
      name: 'When the runs died through the last iteration then should ask a person',
      from: 'li_implementing',
      arrange: (instance) => {
        instance.iterationNumber = MAX_ITERATIONS;
        setState(engine, instance, 'li_implementing');
      },
      want: {
        state: 'li_needs_human',
        needsHumanReason: 'iterations_exhausted',
        iterationNumber: MAX_ITERATIONS + 1,
      },
    },
    {
      name: 'When the instance moved on from that run then should ignore it',
      from: 'li_implementing',
      detachRun: true,
      want: { state: 'li_implementing' },
    },
    {
      name: 'When the instance is not running an agent then should ignore it',
      from: 'li_waiting_pr',
      want: { state: 'li_waiting_pr' },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.withPullRequest
        ? openInstanceWithPullRequest(c.from)
        : openInstanceIn(c.from);
      c.arrange?.(instance);
      const runId = attachRun(instance, c);

      const error = await onSandboxRunFailed(engine, runId, c.outcome ?? {});

      assertOutcome(c.want, instance, error);
    });
  }
});

describe('onOperatorRetry', () => {
  const cases: StateCase[] = [
    {
      name: 'When a person retries what we gave up on then should start again with a fresh budget',
      from: 'li_needs_human',
      arrange: (instance) => {
        instance.iterationNumber = MAX_ITERATIONS;
        setState(engine, instance, 'li_needs_human');
      },
      want: { state: 'li_implementing', startedRuns: 1 },
    },
    ...['li_pending', 'li_implementing', 'li_verifying', 'li_waiting_pr'].map((state) => ({
      name: `When the ticket is in \`${state}\` then should ignore it`,
      from: state as LinearImplementerState,
      want: { state: state as LinearImplementerState },
    })),
    {
      name: 'When the ticket already ended then should ignore it',
      from: 'li_done',
      want: { state: 'li_done' },
    },
    {
      name: 'When the ticket was dismissed then should ignore it',
      from: 'li_dismissed',
      want: { state: 'li_dismissed' },
    },
    {
      name: 'When the instance is unknown then should ignore it',
      unknownInstance: true,
      want: {},
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.unknownInstance
        ? undefined
        : openInstanceIn(c.from as LinearImplementerState);
      if (instance) c.arrange?.(instance);

      const error = await onOperatorRetry(engine, instance?.id ?? 'missing');

      assertOutcome(c.want, instance, error);
    });
  }
});

describe('onOperatorRetryVerification', () => {
  const cases: StateCase[] = [
    {
      name: 'When a person judges again what we gave up on then should verify with a fresh budget',
      from: 'li_needs_human',
      arrange: (instance) => {
        instance.iterationNumber = MAX_ITERATIONS;
        instance.pullRequestNumber = PULL_REQUEST_NUMBER;
        setState(engine, instance, 'li_needs_human');
      },
      want: { state: 'li_verifying', startedRuns: 1, pullRequestNumber: PULL_REQUEST_NUMBER },
    },
    {
      name: 'When no pass opened a pull request then should ignore it',
      from: 'li_needs_human',
      want: { state: 'li_needs_human' },
    },
    ...['li_pending', 'li_implementing', 'li_verifying', 'li_waiting_pr'].map((state) => ({
      name: `When the ticket is in \`${state}\` then should ignore it`,
      from: state as LinearImplementerState,
      want: { state: state as LinearImplementerState },
    })),
    {
      name: 'When the ticket already ended then should ignore it',
      from: 'li_done',
      want: { state: 'li_done' },
    },
    {
      name: 'When the ticket was dismissed then should ignore it',
      from: 'li_dismissed',
      want: { state: 'li_dismissed' },
    },
    {
      name: 'When the instance is unknown then should ignore it',
      unknownInstance: true,
      want: {},
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.unknownInstance
        ? undefined
        : openInstanceIn(c.from as LinearImplementerState);
      if (instance) c.arrange?.(instance);

      const error = await onOperatorRetryVerification(engine, instance?.id ?? 'missing');

      assertOutcome(c.want, instance, error);
    });
  }
});

describe('onOperatorDismiss', () => {
  const cases: StateCase[] = [
    {
      name: 'When a person has to look at it then should end it as dismissed',
      from: 'li_needs_human',
      want: { state: 'li_dismissed' },
    },
    ...['li_pending', 'li_implementing', 'li_verifying', 'li_waiting_pr'].map((state) => ({
      name: `When the ticket is in \`${state}\` then should ignore it`,
      from: state as LinearImplementerState,
      want: { state: state as LinearImplementerState },
    })),
    {
      name: 'When the ticket already ended then should ignore it',
      from: 'li_done',
      want: { state: 'li_done' },
    },
    {
      name: 'When it was already dismissed then should ignore it',
      from: 'li_dismissed',
      want: { state: 'li_dismissed' },
    },
    {
      name: 'When the instance is unknown then should ignore it',
      unknownInstance: true,
      want: {},
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.unknownInstance
        ? undefined
        : openInstanceIn(c.from as LinearImplementerState);
      if (instance) c.arrange?.(instance);

      const error = await onOperatorDismiss(engine, instance?.id ?? 'missing');

      assertOutcome(c.want, instance, error);
    });
  }
});

describe('onPeriodicCheck', () => {
  const cases: PeriodicCase[] = [
    {
      name: 'When the state has no cadence then should never look at it',
      from: 'li_needs_human',
      want: { state: 'li_needs_human' },
    },
    {
      name: 'When the wait has not elapsed then should leave it alone',
      from: 'li_pending',
      arrange: (instance) => {
        engine.config.checkWaitMs.li_pending = 60_000;
        store.markLinearImplementerChecked(instance.id);
      },
      want: { state: 'li_pending' },
    },
    {
      name: 'When the dispatch is still owed then should retry it',
      from: 'li_pending',
      want: { state: 'li_implementing', startedRuns: 1 },
    },
    {
      name: 'When the run is still in the pool then should leave it implementing',
      from: 'li_implementing',
      attachLiveRun: true,
      want: { state: 'li_implementing' },
    },
    {
      name: 'When there is no run at all then should dispatch instead of asking a person',
      from: 'li_implementing',
      want: { state: 'li_implementing', startedRuns: 1 },
    },
    {
      name: 'When the run died with the process then should dispatch again',
      from: 'li_implementing',
      attachLostRun: true,
      want: { state: 'li_implementing', startedRuns: 1, iterationNumber: 1 },
    },
    {
      name: 'When the run finished without telling us then should ask a person',
      from: 'li_verifying',
      attachFinishedRun: 'succeeded',
      want: { state: 'li_needs_human', needsHumanReason: 'outcome_lost' },
    },
    {
      name: 'When the outcome is still on its way then should leave it verifying',
      from: 'li_verifying',
      attachFinishedRun: 'succeeded',
      keepInPool: true,
      want: { state: 'li_verifying' },
    },
    {
      name: 'When the run was killed then should ask a person instead of dispatching again',
      from: 'li_implementing',
      attachFinishedRun: 'aborted',
      want: { state: 'li_needs_human', needsHumanReason: 'run_killed' },
    },
    {
      name: 'When the run failed without telling us then should dispatch again',
      from: 'li_implementing',
      attachFinishedRun: 'failed',
      want: { state: 'li_implementing', startedRuns: 1, iterationNumber: 1 },
    },
    {
      name: 'When the pull request was merged then should deliver the ticket',
      from: 'li_waiting_pr',
      withPullRequest: true,
      arrange: () => {
        github.snapshot = { ...github.snapshot, state: 'merged' };
      },
      want: { state: 'li_done', pullRequestNumber: PULL_REQUEST_NUMBER },
    },
    {
      name: 'When the pull request was closed without merging then should abandon the ticket',
      from: 'li_waiting_pr',
      withPullRequest: true,
      arrange: () => {
        github.snapshot = { ...github.snapshot, state: 'closed' };
      },
      want: { state: 'li_abandoned', pullRequestNumber: PULL_REQUEST_NUMBER },
    },
    {
      name: 'When the pull request is still open then should keep waiting',
      from: 'li_waiting_pr',
      withPullRequest: true,
      want: { state: 'li_waiting_pr', pullRequestNumber: PULL_REQUEST_NUMBER },
    },
    {
      name: 'When there is no pull request to read then should keep waiting',
      from: 'li_waiting_pr',
      want: { state: 'li_waiting_pr' },
    },
    {
      name: 'When the instance is unknown then should ignore it',
      unknownInstance: true,
      want: {},
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.unknownInstance ? undefined : openPeriodicInstance(c);
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
      from: 'li_pending',
      want: { state: 'li_implementing', startedRuns: 1 },
    },
    {
      name: 'When the run survived the restart then should leave it implementing',
      from: 'li_implementing',
      attachLiveRun: true,
      want: { state: 'li_implementing' },
    },
    {
      name: 'When the run died with the process then should dispatch again',
      from: 'li_verifying',
      attachLostRun: true,
      want: { state: 'li_verifying', startedRuns: 1, iterationNumber: 1 },
    },
    {
      name: 'When a person has to look at it then should leave it for them',
      from: 'li_needs_human',
      want: { state: 'li_needs_human' },
    },
    {
      name: 'When the pull request is being waited on then should leave it for the next tick',
      from: 'li_waiting_pr',
      withPullRequest: true,
      want: { state: 'li_waiting_pr', pullRequestNumber: PULL_REQUEST_NUMBER },
    },
    {
      name: 'When the ticket already ended then should ignore it',
      from: 'li_done',
      want: { state: 'li_done' },
    },
    {
      name: 'When the ticket was dismissed then should ignore it',
      from: 'li_dismissed',
      want: { state: 'li_dismissed' },
    },
    {
      name: 'When the instance is unknown then should ignore it',
      unknownInstance: true,
      want: {},
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.unknownInstance ? undefined : openPeriodicInstance(c);
      if (instance) arrangePeriodic(instance, c);

      const error = await onSystemRecovery(engine, instance?.id ?? 'missing');

      assertOutcome(c.want, instance, error);
    });
  }
});

// Every entry point has to hand back the instance lock it took, whatever it
// decided, or a second event for the same ticket would hang.
describe('LinearImplementer entry points release the instance lock', () => {
  const cases: LockCase[] = [
    {
      name: 'When `onIssueAssigned` runs then should release the lock',
      act: () => onIssueAssigned(engine, issueRef()),
    },
    {
      name: 'When `onIssueCommented` runs then should release the lock',
      act: () => onIssueCommented(engine, issueRef()),
    },
    {
      name: 'When `onPrMerged` runs then should release the lock',
      act: () => onPrMerged(engine, pullRequestRef()),
    },
    {
      name: 'When `onPrClosed` runs then should release the lock',
      act: () => onPrClosed(engine, pullRequestRef()),
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      openInstanceWithPullRequest('li_waiting_pr');

      await c.act();

      assert.equal(locker.isBalanced, true);
      assert.ok(locker.acquired.length > 0);
    });
  }
});

function issueRef(): {
  repositoryId: string;
  linearIssueId: string;
  linearIssueIdentifier: string;
} {
  return { repositoryId, linearIssueId: 'iss-1', linearIssueIdentifier: 'JAR-58' };
}

function pullRequestRef(): { repositoryId: string; pullRequestNumber: number } {
  return { repositoryId, pullRequestNumber: PULL_REQUEST_NUMBER };
}

function openInstanceIn(state: LinearImplementerState): LinearImplementer {
  const instance = store.openLinearImplementer(issueRef());
  setState(engine, instance, state);
  return instance;
}

function openPeriodicInstance(c: PeriodicCase): LinearImplementer {
  const state = c.from as LinearImplementerState;
  return c.withPullRequest ? openInstanceWithPullRequest(state) : openInstanceIn(state);
}

function openInstanceWithPullRequest(state: LinearImplementerState): LinearImplementer {
  const instance = store.openLinearImplementer(issueRef());
  instance.pullRequestNumber = PULL_REQUEST_NUMBER;
  setState(engine, instance, state);
  return instance;
}

function attachRun(instance: LinearImplementer, c: RunOutcomeCase): string {
  const runId = store.startSandboxRun({
    agentName: 'LinearImplementer',
    workflowType: c.foreignRun ? 'pr_maintainer' : 'linear_implementer',
    workflowInstanceId: instance.id,
  }).id;
  if (!c.detachRun && !c.foreignRun) {
    instance.sandboxRunId = runId;
    setState(engine, instance, instance.workflowState);
  }
  return runId;
}

function arrangePeriodic(instance: LinearImplementer, c: PeriodicCase): void {
  if (c.attachLiveRun || c.attachLostRun || c.attachFinishedRun) {
    const runId = store.startSandboxRun({
      agentName: 'LinearImplementer',
      workflowType: 'linear_implementer',
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

function arrangeClosing(instance: LinearImplementer, c: ClosingCase): string | undefined {
  if (!c.run) return undefined;
  const runId = store.startSandboxRun({
    agentName: 'LinearImplementer',
    workflowType: 'linear_implementer',
    workflowInstanceId: instance.id,
  }).id;
  instance.sandboxRunId = runId;
  setState(engine, instance, instance.workflowState);
  if (c.run === 'in_flight' || c.run === 'reporting') {
    pool.startSandbox(runId);
    pool.started.length = 0;
  }
  if (c.run === 'reporting' || c.run === 'finished') {
    store.finishSandboxRun(runId, { runState: 'succeeded', costUsd: FINISHED_RUN_COST_USD });
  }
  return runId;
}

function assertClosing(
  c: ClosingCase,
  instance: LinearImplementer | undefined,
  sandboxRunId: string | undefined,
  error: Error | undefined,
): void {
  assertOutcome(c.want, instance, error);
  assert.equal(pool.aborted.length, c.want.abortedRuns ?? 0);
  if (instance) assert.equal(store.getLinearImplementer(instance.id)?.sandboxRunId, null);
  const sandboxRun = sandboxRunId ? store.getSandboxRun(sandboxRunId) : undefined;
  assert.deepEqual(
    sandboxRun && { runState: sandboxRun.runState, costUsd: sandboxRun.costUsd },
    c.want.sandboxRun,
  );
}

function assertOutcome(
  want: Want,
  instance: LinearImplementer | undefined,
  error: Error | undefined,
): void {
  assert.equal(error?.constructor.name, want.errorName);
  assert.equal(pool.started.length, want.startedRuns ?? 0);
  if (want.instanceExists === false) {
    assert.equal(store.findLinearImplementerByIssue('iss-1'), undefined);
    return;
  }
  if (!instance) return;
  const stored = store.getLinearImplementer(instance.id);
  assert.equal(stored?.workflowState, want.state);
  assert.equal(stored?.needsHumanReason, want.needsHumanReason ?? null);
  assert.equal(stored?.pullRequestNumber, want.pullRequestNumber ?? null);
  assert.equal(stored?.verifierVerdict, want.verifierVerdict ?? null);
  assert.equal(stored?.iterationNumber, want.iterationNumber ?? 0);
  if (want.released) assert.deepEqual(github.released, want.released);
}

interface Want {
  state?: LinearImplementerState;
  released?: number[];
  instanceExists?: boolean;
  startedRuns?: number;
  abortedRuns?: number;
  sandboxRun?: { runState: SandboxRunState; costUsd: number | null };
  needsHumanReason?: string;
  pullRequestNumber?: number;
  verifierVerdict?: string;
  iterationNumber?: number;
  errorName?: string;
}

interface StateCase {
  name: string;
  from?: LinearImplementerState;
  unknownInstance?: boolean;
  arrange?: (instance: LinearImplementer) => void;
  want: Want;
  askStaysOpen?: boolean;
}

interface ClosingCase {
  name: string;
  from?: LinearImplementerState;
  // The pool still holds an `in_flight` or `reporting` run, and has let go of a `lost` or `finished` one.
  run?: 'in_flight' | 'reporting' | 'lost' | 'finished';
  want: Want;
}

interface RunOutcomeCase {
  name: string;
  from: LinearImplementerState;
  withPullRequest?: boolean;
  outcome?: RunOutcome;
  detachRun?: boolean;
  foreignRun?: boolean;
  arrange?: (instance: LinearImplementer) => void;
  want: Want;
}

interface PeriodicCase {
  name: string;
  from?: LinearImplementerState;
  withPullRequest?: boolean;
  unknownInstance?: boolean;
  attachLiveRun?: boolean;
  attachLostRun?: boolean;
  attachFinishedRun?: Exclude<SandboxRunState, 'pending' | 'running'>;
  keepInPool?: boolean;
  arrange?: (instance: LinearImplementer) => void;
  want: Want;
}

interface LockCase {
  name: string;
  act: () => Promise<Error | undefined>;
}
