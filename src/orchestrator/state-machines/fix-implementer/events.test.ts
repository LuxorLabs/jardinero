import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from '../../../store/store.js';
import type { FixImplementer, FixImplementerState, SandboxRunState } from '../../../store/types.js';
import { FakeGitHub, FakeLocker, FakeSandboxPool } from '../../../testing/state-machines.js';
import { createTestStore } from '../../../testing/store.js';
import { setState } from './engine.js';
import {
  onFindingReported,
  onOperatorDismiss,
  onOperatorRetry,
  onPeriodicCheck,
  onPrClosed,
  onPrMerged,
  onSandboxRunFailed,
  onSandboxRunSucceeded,
  onSystemRecovery,
  type RunOutcome,
} from './events.js';
import { FixImplementerStateEngine } from './service.js';

const FINGERPRINT = 'fp-1';
const PULL_REQUEST_NUMBER = 77;
const MAX_ITERATIONS = 1;
// The budget a retry grants starts at the instance's `state_changed_at`, so a run stamped
// in the same millisecond as the retry falls inside it; the runs a person forgives are
// older than the click that forgives them.
const BEFORE_THE_RETRY = Date.UTC(2026, 0, 1);
const COVERAGE_EVENT_TYPES = new Set(['workflow.finding_refused', 'workflow.finding_deduplicated']);
const OPEN_STATES: FixImplementerState[] = [
  'fi_pending',
  'fi_implementing',
  'fi_verifying',
  'fi_needs_human',
  'fi_waiting_pr',
];

let store: Store;
let cleanup: () => void;
let pool: FakeSandboxPool;
let locker: FakeLocker;
let github: FakeGitHub;
let engine: FixImplementerStateEngine;
let repositoryId: string;

beforeEach(() => {
  ({ store, cleanup } = createTestStore());
  pool = new FakeSandboxPool();
  locker = new FakeLocker();
  github = new FakeGitHub();
  repositoryId = store.upsertRepository('acme/web.app').id;
  engine = new FixImplementerStateEngine(store, pool, github, locker, {
    maxIterations: MAX_ITERATIONS,
    checkWaitMs: { fi_pending: 0, fi_implementing: 0, fi_verifying: 0, fi_waiting_pr: 0 },
  });
});

afterEach(() => {
  cleanup();
});

describe('onFindingReported', () => {
  const cases: StateCase[] = [
    {
      name: 'When the finding is new then should open it and dispatch the implementer',
      want: { state: 'fi_implementing', startedRuns: 1 },
    },
    {
      name: 'When the dispatch is still owed then should dispatch it',
      from: 'fi_pending',
      want: { state: 'fi_implementing', startedRuns: 1 },
    },
    ...['fi_implementing', 'fi_verifying', 'fi_needs_human', 'fi_waiting_pr'].map((state) => ({
      // The same error seen by a second scan is not new work.
      name: `When the finding is already being worked in \`${state}\` then should leave it alone`,
      from: state as FixImplementerState,
      want: { state: state as FixImplementerState },
    })),
    {
      // The discard may have been a false negative, and the error is still out
      // there.
      name: 'When the finding had been discarded then should start a second pass',
      from: 'fi_discarded',
      arrange: (instance) => {
        instance.discardReason = 'false_positive';
        setState(engine, instance, 'fi_discarded');
      },
      want: { state: 'fi_implementing', startedRuns: 1 },
    },
    {
      name: 'When a person closed the fix then should leave it abandoned',
      from: 'fi_abandoned',
      want: { state: 'fi_abandoned' },
    },
    {
      name: 'When the fix already merged then should treat it as a different error and ignore it',
      from: 'fi_done',
      want: { state: 'fi_done' },
    },
    {
      name: 'When the finding was dismissed then should ignore it',
      from: 'fi_dismissed',
      want: { state: 'fi_dismissed' },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.from ? openInstanceIn(c.from) : undefined;
      if (instance) c.arrange?.(instance);

      const error = await onFindingReported(engine, finding());

      assertOutcome(c.want, instance ?? store.findFixImplementerByFingerprint(FINGERPRINT), error);
    });
  }
});

describe('onFindingReported over a problem already covered', () => {
  const COVERED = 'checkout-service-null-payment';
  const REPORTED = 'checkout service null payment guard';

  const cases: CoverageCase[] = [
    {
      name: 'When a person refused the same problem then should open nothing',
      sibling: { fingerprint: COVERED, state: 'fi_abandoned' },
      want: {
        opened: false,
        eventType: 'workflow.finding_refused',
        reason: 'human_rejected_prior_pr',
        coveredByFingerprint: COVERED,
      },
    },
    {
      name: 'When the refused fix left a pull request then should point at it',
      sibling: { fingerprint: COVERED, state: 'fi_abandoned', pullRequestNumber: 4917 },
      want: {
        opened: false,
        eventType: 'workflow.finding_refused',
        reason: 'human_rejected_prior_pr',
        coveredByFingerprint: COVERED,
        coveredByPullRequest: 4917,
      },
    },
    {
      name: 'When the same problem is already being worked then should open nothing',
      sibling: { fingerprint: COVERED, state: 'fi_implementing' },
      want: {
        opened: false,
        eventType: 'workflow.finding_deduplicated',
        reason: 'same_problem_in_flight',
        coveredByFingerprint: COVERED,
      },
    },
    {
      name: 'When an open pull request already covers it then should open nothing',
      openPullRequest: 5043,
      want: {
        opened: false,
        eventType: 'workflow.finding_deduplicated',
        reason: 'existing_open_pr',
        coveredByPullRequest: 5043,
        matchedTokens: ['fingerprint'],
      },
    },
    {
      // A fix that ended is no reason to leave the error unattended.
      name: 'When the work on the same problem ended then should open the finding',
      sibling: { fingerprint: COVERED, state: 'fi_done' },
      want: { opened: true },
    },
    {
      name: 'When it is another problem of the same service then should open the finding',
      sibling: { fingerprint: 'login-timeout-loop', state: 'fi_implementing' },
      want: { opened: true },
    },
    {
      name: 'When the reported evidence cannot be read then should open the finding',
      sibling: { fingerprint: COVERED, state: 'fi_abandoned' },
      evidence: 'not json',
      want: { opened: true },
    },
    {
      name: 'When the covering finding left no readable evidence then should open the finding',
      sibling: { fingerprint: COVERED, state: 'fi_implementing', evidence: 'not json' },
      want: { opened: true },
    },
    {
      name: 'When the reported evidence is not an object then should open the finding',
      sibling: { fingerprint: COVERED, state: 'fi_abandoned' },
      evidence: '[]',
      want: { opened: true },
    },
    {
      name: 'When the reported evidence carries no fingerprint then should open the finding',
      sibling: { fingerprint: COVERED, state: 'fi_abandoned' },
      evidence: JSON.stringify({ service: 'api', environment: 'production' }),
      want: { opened: true },
    },
    {
      name: 'When nothing covers it then should open the finding',
      want: { opened: true },
    },
    {
      // Dropping the finding would be worse than the duplicate the target guards against.
      name: 'When the target cannot be held then should open the finding anyway',
      refuseTargetLock: true,
      want: { opened: true },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      if (c.refuseTargetLock)
        locker.refusedResourceId = `fix_implementer_target:${repositoryId}:api:production`;
      if (c.sibling) {
        const sibling = store.openFixImplementer({
          repositoryId,
          findingFingerprint: c.sibling.fingerprint,
          serviceName: 'api',
          environmentName: 'production',
          findingEvidence: c.sibling.evidence ?? evidenceFor(c.sibling.fingerprint),
        });
        sibling.pullRequestNumber = c.sibling.pullRequestNumber ?? null;
        setState(engine, sibling, c.sibling.state);
      }
      if (c.openPullRequest) {
        github.openImplementationPr = {
          number: c.openPullRequest,
          matchedTokens: ['fingerprint'],
        };
      }

      await onFindingReported(engine, {
        repositoryId,
        findingFingerprint: REPORTED,
        serviceName: 'api',
        environmentName: 'production',
        findingEvidence: c.evidence ?? evidenceFor(REPORTED),
      });

      assert.equal(store.findFixImplementerByFingerprint(REPORTED) !== undefined, c.want.opened);
      const recorded = store
        .listEvents({ repositoryId })
        .rows.find((entry) => COVERAGE_EVENT_TYPES.has(entry.eventType));
      const metadata = JSON.parse(recorded?.metadata ?? '{}');
      assert.equal(recorded?.eventType, c.want.eventType);
      assert.equal(metadata.reason, c.want.reason);
      assert.equal(metadata.covered_by_fingerprint, c.want.coveredByFingerprint);
      assert.equal(metadata.covered_by_pull_request_number, c.want.coveredByPullRequest);
      assert.deepEqual(metadata.covered_by_matched_tokens, c.want.matchedTokens);
    });
  }

  function evidenceFor(fingerprint: string): string {
    return JSON.stringify({
      fingerprint,
      service: 'api',
      environment: 'production',
      likely_files_or_symbols: ['handlers/checkout.ts'],
    });
  }
});

describe('onSandboxRunSucceeded', () => {
  const cases: RunOutcomeCase[] = [
    {
      name: 'When the agent opened a pull request then should hand it to verifying',
      from: 'fi_implementing',
      outcome: { pullRequestNumber: PULL_REQUEST_NUMBER },
      want: { state: 'fi_verifying', pullRequestNumber: PULL_REQUEST_NUMBER },
    },
    {
      // Refusing a finding is a legitimate answer here, because a machine found
      // the work and no human is waiting on it.
      name: 'When the agent refused the finding then should discard it with the reason',
      from: 'fi_implementing',
      outcome: { discardReason: 'unreproducible' },
      want: { state: 'fi_discarded', discardReason: 'unreproducible' },
    },
    {
      name: 'When the agent refused without saying why then should still record a reason',
      from: 'fi_implementing',
      outcome: {},
      want: { state: 'fi_discarded', discardReason: 'no_reason_given' },
    },
    {
      name: 'When the instance moved on from that run then should ignore it',
      from: 'fi_implementing',
      detachRun: true,
      outcome: { pullRequestNumber: PULL_REQUEST_NUMBER },
      want: { state: 'fi_implementing' },
    },
    {
      name: 'When the instance is not running the agent then should ignore it',
      from: 'fi_waiting_pr',
      outcome: {},
      want: { state: 'fi_waiting_pr' },
    },
    {
      name: 'When the run belongs to another workflow then should ignore it',
      from: 'fi_implementing',
      foreignRun: true,
      outcome: {},
      want: { state: 'fi_implementing' },
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
      name: 'When the first fix run died then should run the same pass again',
      from: 'fi_implementing',
      want: { state: 'fi_implementing', startedRuns: 1 },
    },
    {
      name: 'When the runs keep dying then should ask a person',
      from: 'fi_implementing',
      lostRuns: MAX_ITERATIONS + 1,
      want: { state: 'fi_needs_human', needsHumanReason: 'run_failed' },
    },
    {
      name: 'When the instance moved on from that run then should ignore it',
      from: 'fi_implementing',
      detachRun: true,
      want: { state: 'fi_implementing' },
    },
    {
      name: 'When the instance is not running the agent then should ignore it',
      from: 'fi_waiting_pr',
      want: { state: 'fi_waiting_pr' },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = openInstanceIn(c.from);
      for (let lost = 0; lost < (c.lostRuns ?? 0); lost += 1) {
        const dead = store.startSandboxRun({
          agentName: 'FixImplementer',
          workflowType: 'fix_implementer',
          workflowInstanceId: instance.id,
        });
        store.finishSandboxRun(dead.id, { runState: 'failed' });
      }
      const runId = attachRun(instance, c);

      const error = await onSandboxRunFailed(engine, runId);

      assertOutcome(c.want, instance, error);
    });
  }
});

describe('onPrMerged', () => {
  const cases: StateCase[] = [
    ...OPEN_STATES.map((state) => ({
      name: `When the finding was in \`${state}\` then should close it as \`fi_done\``,
      from: state,
      want: { state: 'fi_done' as FixImplementerState, pullRequestNumber: PULL_REQUEST_NUMBER },
    })),
    {
      name: 'When no instance follows that pull request then should ignore it',
      want: { instanceExists: false },
    },
    {
      name: 'When the finding was dismissed then should ignore it',
      from: 'fi_dismissed',
      want: { state: 'fi_dismissed', pullRequestNumber: PULL_REQUEST_NUMBER },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.from ? openInstanceWithPullRequest(c.from) : undefined;

      const error = await onPrMerged(engine, pullRequestRef());

      assertOutcome(c.want, instance, error);
    });
  }
});

describe('onPrClosed', () => {
  const cases: StateCase[] = [
    ...OPEN_STATES.map((state) => ({
      // A person closing our fix without merging it is the answer, and it is
      // why there is no separate rejected-pull-request record.
      name: `When the finding was in \`${state}\` then should close it as \`fi_abandoned\``,
      from: state,
      want: {
        state: 'fi_abandoned' as FixImplementerState,
        pullRequestNumber: PULL_REQUEST_NUMBER,
      },
    })),
    {
      name: 'When no instance follows that pull request then should ignore it',
      want: { instanceExists: false },
    },
    {
      name: 'When the finding was dismissed then should ignore it',
      from: 'fi_dismissed',
      want: { state: 'fi_dismissed', pullRequestNumber: PULL_REQUEST_NUMBER },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.from ? openInstanceWithPullRequest(c.from) : undefined;

      const error = await onPrClosed(engine, pullRequestRef());

      assertOutcome(c.want, instance, error);
    });
  }
});

describe('onOperatorRetry', () => {
  const cases: StateCase[] = [
    {
      name: 'When a person retries what we gave up on then should dispatch again',
      from: 'fi_needs_human',
      want: { state: 'fi_implementing', startedRuns: 1 },
    },
    {
      name: 'When a person retries a finding whose runs all died then should dispatch again',
      from: 'fi_needs_human',
      arrange: (instance) => {
        for (let lost = 0; lost <= MAX_ITERATIONS; lost += 1) killRunBeforeTheRetry(instance);
      },
      want: { state: 'fi_implementing', startedRuns: 1 },
    },
    ...['fi_pending', 'fi_implementing', 'fi_verifying', 'fi_waiting_pr'].map((state) => ({
      name: `When the finding is in \`${state}\` then should ignore it`,
      from: state as FixImplementerState,
      want: { state: state as FixImplementerState },
    })),
    {
      name: 'When the finding already ended then should ignore it',
      from: 'fi_done',
      want: { state: 'fi_done' },
    },
    {
      name: 'When the finding was dismissed then should ignore it',
      from: 'fi_dismissed',
      want: { state: 'fi_dismissed' },
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
        : openInstanceIn(c.from as FixImplementerState);
      if (instance) c.arrange?.(instance);

      const error = await onOperatorRetry(engine, instance?.id ?? 'missing');

      assertOutcome(c.want, instance, error);
    });
  }
});

describe('onOperatorDismiss', () => {
  const cases: StateCase[] = [
    {
      name: 'When a person has to look at it then should end it as dismissed',
      from: 'fi_needs_human',
      want: { state: 'fi_dismissed' },
    },
    ...['fi_pending', 'fi_implementing', 'fi_verifying', 'fi_waiting_pr'].map((state) => ({
      name: `When the finding is in \`${state}\` then should ignore it`,
      from: state as FixImplementerState,
      want: { state: state as FixImplementerState },
    })),
    {
      name: 'When the finding already ended then should ignore it',
      from: 'fi_done',
      want: { state: 'fi_done' },
    },
    {
      name: 'When it was already dismissed then should ignore it',
      from: 'fi_dismissed',
      want: { state: 'fi_dismissed' },
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
        : openInstanceIn(c.from as FixImplementerState);
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
      from: 'fi_needs_human',
      want: { state: 'fi_needs_human' },
    },
    {
      name: 'When the wait has not elapsed then should leave it alone',
      from: 'fi_pending',
      arrange: (instance) => {
        engine.config.checkWaitMs.fi_pending = 60_000;
        store.markFixImplementerChecked(instance.id);
      },
      want: { state: 'fi_pending' },
    },
    {
      name: 'When the dispatch is still owed then should retry it',
      from: 'fi_pending',
      want: { state: 'fi_implementing', startedRuns: 1 },
    },
    {
      name: 'When the release is owed then should release the draft and wait for the pull request',
      from: 'fi_verifying',
      withPullRequest: true,
      want: {
        state: 'fi_waiting_pr',
        pullRequestNumber: PULL_REQUEST_NUMBER,
        released: [PULL_REQUEST_NUMBER],
      },
    },
    {
      name: 'When GitHub refuses the release then should stay verifying with the failure',
      from: 'fi_verifying',
      withPullRequest: true,
      arrange: () => {
        github.refusal = new Error('github unreachable');
      },
      want: { state: 'fi_verifying', pullRequestNumber: PULL_REQUEST_NUMBER, errorName: 'Error' },
    },
    {
      name: 'When there is no pull request to release then should stay verifying with the failure',
      from: 'fi_verifying',
      want: { state: 'fi_verifying', errorName: 'Error' },
    },
    {
      name: 'When the pull request was merged then should finish the fix',
      from: 'fi_waiting_pr',
      withPullRequest: true,
      arrange: () => {
        github.snapshot = { ...github.snapshot, state: 'merged' };
      },
      want: { state: 'fi_done', pullRequestNumber: PULL_REQUEST_NUMBER },
    },
    {
      name: 'When the pull request was closed without merging then should abandon the finding',
      from: 'fi_waiting_pr',
      withPullRequest: true,
      arrange: () => {
        github.snapshot = { ...github.snapshot, state: 'closed' };
      },
      want: { state: 'fi_abandoned', pullRequestNumber: PULL_REQUEST_NUMBER },
    },
    {
      name: 'When the pull request is still open then should keep waiting',
      from: 'fi_waiting_pr',
      withPullRequest: true,
      want: { state: 'fi_waiting_pr', pullRequestNumber: PULL_REQUEST_NUMBER },
    },
    {
      name: 'When there is no pull request to read then should keep waiting',
      from: 'fi_waiting_pr',
      want: { state: 'fi_waiting_pr' },
    },
    {
      name: 'When the run is still in the pool then should leave it implementing',
      from: 'fi_implementing',
      attachLiveRun: true,
      want: { state: 'fi_implementing' },
    },
    {
      name: 'When the run died with the process then should dispatch again',
      from: 'fi_implementing',
      attachLostRun: true,
      want: { state: 'fi_implementing', startedRuns: 1 },
    },
    {
      name: 'When there is no run at all then should dispatch instead of asking a person',
      from: 'fi_implementing',
      want: { state: 'fi_implementing', startedRuns: 1 },
    },
    {
      name: 'When the run finished without telling us then should ask a person',
      from: 'fi_implementing',
      attachFinishedRun: 'succeeded',
      want: { state: 'fi_needs_human', needsHumanReason: 'outcome_lost' },
    },
    {
      name: 'When the outcome is still on its way then should leave it implementing',
      from: 'fi_implementing',
      attachFinishedRun: 'succeeded',
      keepInPool: true,
      want: { state: 'fi_implementing' },
    },
    {
      name: 'When the run failed without telling us then should ask a person',
      from: 'fi_implementing',
      attachFinishedRun: 'failed',
      want: { state: 'fi_needs_human', needsHumanReason: 'run_failed' },
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
      from: 'fi_pending',
      want: { state: 'fi_implementing', startedRuns: 1 },
    },
    {
      name: 'When the release was owed then should leave it for the next tick',
      from: 'fi_verifying',
      withPullRequest: true,
      want: { state: 'fi_verifying', pullRequestNumber: PULL_REQUEST_NUMBER, released: [] },
    },
    {
      name: 'When the run survived the restart then should leave it implementing',
      from: 'fi_implementing',
      attachLiveRun: true,
      want: { state: 'fi_implementing' },
    },
    {
      name: 'When the run died with the process then should dispatch again',
      from: 'fi_implementing',
      attachLostRun: true,
      want: { state: 'fi_implementing', startedRuns: 1 },
    },
    {
      name: 'When a person has to look at it then should leave it for them',
      from: 'fi_needs_human',
      want: { state: 'fi_needs_human' },
    },
    {
      name: 'When the pull request is being waited on then should leave it for the next tick',
      from: 'fi_waiting_pr',
      withPullRequest: true,
      want: { state: 'fi_waiting_pr', pullRequestNumber: PULL_REQUEST_NUMBER },
    },
    {
      name: 'When the finding already ended then should ignore it',
      from: 'fi_done',
      want: { state: 'fi_done' },
    },
    {
      name: 'When the finding was dismissed then should ignore it',
      from: 'fi_dismissed',
      want: { state: 'fi_dismissed' },
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
// decided, or a second event for the same finding would hang.
describe('FixImplementer entry points release what they take', () => {
  const cases: LockCase[] = [
    {
      // Coverage is read across fingerprints, so opening one also holds its target.
      name: 'When `onFindingReported` opens a finding then should take the finding and its target',
      act: () => onFindingReported(engine, { ...finding(), findingFingerprint: 'fp-unseen' }),
      wantKeys: () => ['fix_implementer:fp-unseen', `fix_implementer_target:${repositoryId}::`],
    },
    {
      name: 'When `onFindingReported` finds the instance then should take the finding alone',
      arrange: () => openInstanceWithPullRequest('fi_waiting_pr'),
      act: () => onFindingReported(engine, finding()),
      wantKeys: () => [`fix_implementer:${FINGERPRINT}`],
    },
    {
      name: 'When `onPrMerged` runs then should take the finding alone',
      arrange: () => openInstanceWithPullRequest('fi_waiting_pr'),
      act: () => onPrMerged(engine, pullRequestRef()),
      wantKeys: () => [`fix_implementer:${FINGERPRINT}`],
    },
    {
      name: 'When `onPrClosed` runs then should take the finding alone',
      arrange: () => openInstanceWithPullRequest('fi_waiting_pr'),
      act: () => onPrClosed(engine, pullRequestRef()),
      wantKeys: () => [`fix_implementer:${FINGERPRINT}`],
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      c.arrange?.();

      await c.act();

      assert.deepEqual(locker.acquired, c.wantKeys());
      assert.equal(locker.isBalanced, true);
    });
  }
});

function finding(): { repositoryId: string; findingFingerprint: string } {
  return { repositoryId, findingFingerprint: FINGERPRINT };
}

function pullRequestRef(): { repositoryId: string; pullRequestNumber: number } {
  return { repositoryId, pullRequestNumber: PULL_REQUEST_NUMBER };
}

function openInstanceIn(state: FixImplementerState): FixImplementer {
  const instance = store.openFixImplementer(finding());
  setState(engine, instance, state);
  return instance;
}

function openPeriodicInstance(c: PeriodicCase): FixImplementer {
  const state = c.from as FixImplementerState;
  return c.withPullRequest ? openInstanceWithPullRequest(state) : openInstanceIn(state);
}

function openInstanceWithPullRequest(state: FixImplementerState): FixImplementer {
  const instance = store.openFixImplementer(finding());
  instance.pullRequestNumber = PULL_REQUEST_NUMBER;
  setState(engine, instance, state);
  return instance;
}

function killRunBeforeTheRetry(instance: FixImplementer): void {
  const dead = store.startSandboxRun({
    agentName: 'FixImplementer',
    workflowType: 'fix_implementer',
    workflowInstanceId: instance.id,
  });
  store.finishSandboxRun(dead.id, { runState: 'failed' });
  store.db
    .prepare('UPDATE sandbox_run SET started_at = ?, ended_at = ? WHERE id = ?')
    .run(BEFORE_THE_RETRY, BEFORE_THE_RETRY, dead.id);
}

function attachRun(instance: FixImplementer, c: RunOutcomeCase): string {
  const runId = store.startSandboxRun({
    agentName: 'FixImplementer',
    workflowType: c.foreignRun ? 'pr_maintainer' : 'fix_implementer',
    workflowInstanceId: instance.id,
  }).id;
  if (!c.detachRun && !c.foreignRun) {
    instance.sandboxRunId = runId;
    setState(engine, instance, instance.workflowState);
  }
  return runId;
}

function arrangePeriodic(instance: FixImplementer, c: PeriodicCase): void {
  if (c.attachLiveRun || c.attachLostRun || c.attachFinishedRun) {
    const runId = store.startSandboxRun({
      agentName: 'FixImplementer',
      workflowType: 'fix_implementer',
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
  instance: FixImplementer | undefined,
  error: Error | undefined,
): void {
  assert.equal(error?.constructor.name, want.errorName);
  assert.equal(pool.started.length, want.startedRuns ?? 0);
  if (want.instanceExists === false) {
    assert.equal(store.findFixImplementerByFingerprint(FINGERPRINT), undefined);
    return;
  }
  if (!instance) return;
  const stored = store.getFixImplementer(instance.id);
  assert.equal(stored?.workflowState, want.state);
  assert.equal(stored?.needsHumanReason, want.needsHumanReason ?? null);
  assert.equal(stored?.discardReason, want.discardReason ?? null);
  assert.equal(stored?.pullRequestNumber, want.pullRequestNumber ?? null);
  if (want.released) assert.deepEqual(github.released, want.released);
}

interface Want {
  state?: FixImplementerState;
  instanceExists?: boolean;
  startedRuns?: number;
  needsHumanReason?: string;
  discardReason?: string;
  pullRequestNumber?: number;
  released?: number[];
  errorName?: string;
}

interface StateCase {
  name: string;
  from?: FixImplementerState;
  unknownInstance?: boolean;
  arrange?: (instance: FixImplementer) => void;
  want: Want;
}

interface CoverageCase {
  name: string;
  sibling?: {
    fingerprint: string;
    state: FixImplementerState;
    evidence?: string;
    pullRequestNumber?: number;
  };
  openPullRequest?: number;
  evidence?: string;
  refuseTargetLock?: boolean;
  want: {
    opened: boolean;
    eventType?: string;
    reason?: string;
    coveredByFingerprint?: string;
    coveredByPullRequest?: number;
    matchedTokens?: string[];
  };
}

interface RunOutcomeCase {
  name: string;
  from: FixImplementerState;
  outcome?: RunOutcome;
  detachRun?: boolean;
  foreignRun?: boolean;
  lostRuns?: number;
  want: Want;
}

interface PeriodicCase {
  name: string;
  from?: FixImplementerState;
  withPullRequest?: boolean;
  unknownInstance?: boolean;
  attachLiveRun?: boolean;
  attachLostRun?: boolean;
  attachFinishedRun?: Exclude<SandboxRunState, 'pending' | 'running'>;
  keepInPool?: boolean;
  arrange?: (instance: FixImplementer) => void;
  want: Want;
}

interface LockCase {
  name: string;
  arrange?: () => void;
  act: () => Promise<Error | undefined>;
  wantKeys: () => string[];
}
