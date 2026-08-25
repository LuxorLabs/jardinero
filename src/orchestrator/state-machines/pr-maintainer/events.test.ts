import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from '../../../store/store.js';
import type { PrMaintainer, PrMaintainerState } from '../../../store/types.js';
import {
  FakeGitHub,
  FakeLocker,
  FakeSandboxPool,
  type RecordingAnnouncer,
  createRecordingAnnouncer,
} from '../../../testing/state-machines.js';
import { createTestStore } from '../../../testing/store.js';
import { setState } from './engine.js';
import {
  onOperatorDismiss,
  onOperatorRetry,
  onPeriodicCheck,
  onPrCICompleted,
  onPrClosed,
  onPrComment,
  onPrDiscovered,
  onPrToFollow,
  onPrMerged,
  onPrReadyForReview,
  onPrReopened,
  onPrSynchronize,
  onSandboxRunFailed,
  onSandboxRunSucceeded,
  onSystemRecovery,
  type CommentData,
} from './events.js';
import { PrMaintainerStateEngine } from './service.js';

const MAX_ATTEMPTS = 2;
const MAX_REPLIES_PER_THREAD = 2;
const PULL_REQUEST_NUMBER = 4688;
const OPEN_STATES: PrMaintainerState[] = [
  'prm_pending',
  'prm_working',
  'prm_waiting',
  'prm_attempts_exhausted',
];

let store: Store;
let cleanup: () => void;
let pool: FakeSandboxPool;
let locker: FakeLocker;
let github: FakeGitHub;
let engine: PrMaintainerStateEngine;
let repositoryId: string;
let announcer: RecordingAnnouncer;

beforeEach(() => {
  ({ store, cleanup } = createTestStore());
  pool = new FakeSandboxPool();
  locker = new FakeLocker();
  github = new FakeGitHub();
  repositoryId = store.upsertRepository('acme/web.app').id;
  announcer = createRecordingAnnouncer();
  engine = new PrMaintainerStateEngine(
    store,
    pool,
    github,
    locker,
    {
      maxAttempts: MAX_ATTEMPTS,
      maxRepliesPerThread: MAX_REPLIES_PER_THREAD,
      agentPullRequest: { branchPrefix: 'agent/' },
      checkWaitMs: {
        prm_pending: 0,
        prm_working: 0,
        prm_waiting: 0,
      },
    },
    announcer,
  );
});

afterEach(() => {
  cleanup();
});

describe('onPrReadyForReview', () => {
  const cases: AnnouncementCase[] = [
    ...announcementCases(),
    {
      name: 'When the pull request is not ours then should open nothing',
      facts: { headBranch: 'someone/their-work' },
      want: { instanceExists: false },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.from ? openInstanceIn(c.from) : undefined;

      const error = await onPrReadyForReview(engine, { ...ourPullRequest(), ...c.facts });

      assertAnnouncement(c, instance, error);
    });
  }
});

describe('onPrToFollow', () => {
  const cases: AnnouncementCase[] = announcementCases();

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.from ? openInstanceIn(c.from) : undefined;

      const error = await onPrToFollow(engine, pullRequestRef(), undefined);

      assertAnnouncement(c, instance, error);
    });
  }
});

describe('onPrDiscovered', () => {
  const cases: AnnouncementCase[] = [
    ...announcementCases(),
    {
      name: 'When the sweep names a pull request that is not ours then should open nothing',
      facts: { headBranch: 'someone/their-work' },
      want: { instanceExists: false },
    },
    {
      // A draft of ours is still the implementer's until it releases it.
      name: 'When one of ours is still a draft then should open nothing',
      facts: { isDraft: true },
      want: { instanceExists: false },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.from ? openInstanceIn(c.from) : undefined;

      const error = await onPrDiscovered(engine, { ...ourPullRequest(), ...c.facts });

      assertAnnouncement(c, instance, error);
    });
  }
});

describe('onPrReopened', () => {
  const cases: AnnouncementCase[] = [
    {
      // It keeps its number, so this is the same subject coming back and the
      // counters start over.
      name: 'When the pull request was closed then should start a new pass with a fresh budget',
      from: 'prm_closed',
      arrange: (instance) => {
        instance.attemptCount = MAX_ATTEMPTS;
        setState(engine, instance, 'prm_closed');
      },
      want: { state: 'prm_working', startedRuns: 1 },
    },
    {
      name: 'When the pull request merged then should leave the ending alone',
      from: 'prm_merged',
      want: { state: 'prm_merged' },
    },
    {
      name: 'When the pull request was dismissed then should leave the ending alone',
      from: 'prm_dismissed',
      want: { state: 'prm_dismissed' },
    },
    {
      name: 'When there is no instance yet then should open one and dispatch',
      want: { state: 'prm_working', startedRuns: 1 },
    },
    ...OPEN_STATES.filter((state) => state !== 'prm_pending').map((state) => ({
      name: `When the pull request is already followed in \`${state}\` then should leave it alone`,
      from: state,
      want: { state },
    })),
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.from ? openInstanceIn(c.from) : undefined;
      if (instance) c.arrange?.(instance);

      const error = await onPrReopened(engine, { ...ourPullRequest(), ...c.facts });

      assertAnnouncement(c, instance, error);
    });
  }
});

describe('onPrComment', () => {
  const cases: CommentCase[] = [
    {
      // Our own echo. The only thing stopping an endless reply loop.
      name: 'When the comment is ours then should ignore it',
      from: 'prm_waiting',
      authoredByUs: true,
      want: { state: 'prm_waiting' },
    },
    {
      name: 'When there is no instance and the comment does not tag us then should ignore it',
      want: { instanceExists: false },
    },
    {
      name: 'When there is no instance and the comment tags us then should take the pull request',
      mentionsUs: true,
      want: { state: 'prm_working', startedRuns: 1, attemptCount: 1, pickedUp: true },
    },
    {
      name: 'When it was just taken then should dispatch the pass',
      from: 'prm_pending',
      want: { state: 'prm_working', startedRuns: 1, attemptCount: 1, pickedUp: true },
    },
    {
      // The pass in flight consumes the ask when it ends, so the comment is marked
      // without a pass of its own.
      name: 'When a sandbox run is in flight then should mark it without dispatching',
      from: 'prm_working',
      want: { state: 'prm_working', pickedUp: true },
    },
    {
      name: 'When the instance is waiting then should dispatch a new pass',
      from: 'prm_waiting',
      want: { state: 'prm_working', startedRuns: 1, attemptCount: 1, pickedUp: true },
    },
    {
      // A review body is a comment GitHub takes no reaction on, and the mark is a
      // courtesy the pass does not wait for.
      name: 'When the comment says no endpoint then should dispatch and mark nothing',
      from: 'prm_waiting',
      comment: { author: 'someone', body: 'please look', externalId: '991' },
      want: { state: 'prm_working', startedRuns: 1, attemptCount: 1 },
    },
    {
      name: 'When the comment carries no id then should dispatch and mark nothing',
      from: 'prm_waiting',
      comment: { author: 'someone', body: 'please look', commentType: 'issue' },
      want: { state: 'prm_working', startedRuns: 1, attemptCount: 1 },
    },
    {
      // Writing on a pull request we stopped working on is not a request to
      // start again. Tagging us is.
      name: 'When the attempts are exhausted and the comment does not tag us then should ignore it',
      from: 'prm_attempts_exhausted',
      want: { state: 'prm_attempts_exhausted' },
    },
    {
      name: 'When the attempts are exhausted and the comment tags us then should start again with a fresh budget',
      from: 'prm_attempts_exhausted',
      mentionsUs: true,
      arrange: (instance) => {
        instance.attemptCount = MAX_ATTEMPTS;
        setState(engine, instance, 'prm_attempts_exhausted');
      },
      want: { state: 'prm_working', startedRuns: 1, attemptCount: 1, pickedUp: true },
    },
    {
      name: 'When the pull request already merged then should ignore it',
      from: 'prm_merged',
      mentionsUs: true,
      want: { state: 'prm_merged' },
    },
    {
      name: 'When the pull request was closed then should ignore it',
      from: 'prm_closed',
      mentionsUs: true,
      want: { state: 'prm_closed' },
    },
    {
      name: 'When the pull request was dismissed then should ignore it',
      from: 'prm_dismissed',
      want: { state: 'prm_dismissed' },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.from ? openInstanceIn(c.from) : undefined;
      if (instance) c.arrange?.(instance);

      const error = await onPrComment(engine, {
        ...pullRequestRef(),
        authoredByUs: c.authoredByUs ?? false,
        mentionsUs: c.mentionsUs ?? false,
        reviewThreadId: c.reviewThreadId,
        comment: c.comment ?? {
          author: 'someone',
          body: 'please look',
          externalId: '991',
          commentType: 'issue',
        },
      });

      assertOutcome(c.want, instance, error);
      assert.equal(github.pickedUp.length, c.want.pickedUp ? 1 : 0);
      const ask = store.listRequests({}, { limit: 10 }).rows.at(0);
      assert.equal(
        ask?.workflowInstanceId ?? null,
        c.want.startedRuns ? (instance?.id ?? store.listOpenPrMaintainers().at(0)?.id) : null,
      );
    });
  }
});

// The mark is the only signal the person gets between writing a comment and the agent
// answering, so where it goes and what a refusal costs are their own subject.
describe('The pickup mark on a comment', () => {
  test('When the machine takes the comment then should mark it where it was written', async () => {
    openInstanceIn('prm_waiting');

    await onPrComment(engine, { ...pullRequestRef(), ...comment({}) });

    assert.deepEqual(github.pickedUp, [
      {
        repositoryFullName: 'acme/web.app',
        commentType: 'issue',
        commentExternalId: '991',
      },
    ]);
  });

  test('When GitHub refuses the mark then should record it and dispatch anyway', async () => {
    openInstanceIn('prm_waiting');
    github.pickupRefusal = new Error('HTTP 403');

    await onPrComment(engine, { ...pullRequestRef(), ...comment({}) });

    assert.equal(pool.started.length, 1);
    assert.equal(
      store
        .listEvents({ workflowType: 'pr_maintainer' }, { limit: 20 })
        .rows.filter((row) => row.eventType === 'orchestrator.github_reaction_failed').length,
      1,
    );
  });
});

// Answering one conversation for ever is a loop, so each thread has a budget and
// comments outside a review thread share the pull request's.
describe('The reply cap of a thread', () => {
  const cases: Array<{
    name: string;
    reviewThreadIds: Array<string | undefined>;
    wantStarted: number;
  }> = [
    {
      name: 'When one thread is answered past its cap then should stop dispatching for it',
      reviewThreadIds: ['thread-1', 'thread-1', 'thread-1'],
      wantStarted: MAX_REPLIES_PER_THREAD,
    },
    {
      name: 'When the comments carry no thread then should share the pull request cap',
      reviewThreadIds: [undefined, undefined, undefined],
      wantStarted: MAX_REPLIES_PER_THREAD,
    },
    {
      name: 'When another thread is answered then should give it its own cap',
      reviewThreadIds: ['thread-1', 'thread-1', 'thread-2'],
      wantStarted: 3,
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = openInstanceIn('prm_pending');

      for (const reviewThreadId of c.reviewThreadIds) {
        await onPrComment(engine, { ...pullRequestRef(), ...comment({ reviewThreadId }) });
        settleIntoWaiting(instance.id);
      }

      assert.equal(pool.started.length, c.wantStarted);
      assert.equal(github.pickedUp.length, c.wantStarted);
    });
  }
});

// What a person wrote is recorded before any machine acts on it, so an ask nobody
// answered is still readable, and one that was answered says who did.
describe('The ask a comment records', () => {
  const cases: Array<{
    name: string;
    from?: PrMaintainerState;
    mentionsUs?: boolean;
    overCap?: boolean;
    carriesComment?: boolean;
    wantRecorded?: boolean;
    wantConsumed: boolean;
  }> = [
    {
      name: 'When the comment dispatches a pass then should record who answered it',
      from: 'prm_pending',
      wantConsumed: true,
    },
    {
      name: 'When the comment wakes a waiting instance then should record who answered it',
      from: 'prm_waiting',
      wantConsumed: true,
    },
    {
      name: 'When a tag revives an exhausted instance then should record who answered it',
      from: 'prm_attempts_exhausted',
      mentionsUs: true,
      wantConsumed: true,
    },
    {
      name: 'When a sandbox run is in flight then should leave the ask open',
      from: 'prm_working',
      wantConsumed: false,
    },
    {
      name: 'When the pull request is merged then should leave the ask open',
      from: 'prm_merged',
      wantConsumed: false,
    },
    {
      name: 'When the pull request was dismissed then should leave the ask open',
      from: 'prm_dismissed',
      wantConsumed: false,
    },
    {
      name: 'When the thread is past its cap then should leave the ask open',
      from: 'prm_waiting',
      overCap: true,
      wantConsumed: false,
    },
    {
      name: 'When nobody follows the pull request and nobody tagged us then should record no ask',
      wantRecorded: false,
      wantConsumed: false,
    },
    {
      name: 'When the delivery carried no comment then should record no ask',
      mentionsUs: true,
      carriesComment: false,
      wantRecorded: false,
      wantConsumed: false,
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.from ? openInstanceIn(c.from) : undefined;
      if (c.overCap && instance) {
        for (let reply = 0; reply <= MAX_REPLIES_PER_THREAD; reply += 1) {
          store.bumpThreadReply(instance.id, 'thread-1');
        }
      }

      await onPrComment(engine, {
        ...pullRequestRef(),
        ...comment({ reviewThreadId: 'thread-1' }),
        mentionsUs: c.mentionsUs ?? false,
        comment:
          c.carriesComment === false
            ? undefined
            : { author: 'someone', body: 'please look', externalId: '991' },
      });

      const stored = store.listRequests({}, { limit: 10 }).rows.at(0);
      assert.equal(stored !== undefined, c.wantRecorded ?? true);
      assert.equal(stored === undefined ? false : stored.consumedAt !== null, c.wantConsumed);
      assert.equal(
        stored?.workflowInstanceId ?? null,
        c.wantConsumed ? (instance?.id ?? null) : null,
      );
    });
  }

  test('When a person tags us then should record what they wrote and where to answer', async () => {
    await onPrComment(engine, {
      ...pullRequestRef(),
      authoredByUs: false,
      mentionsUs: true,
      comment: { author: 'lucio', body: '@acme-jardinero look at this', externalId: '4242' },
    });

    const ask = store.listRequests({}, { limit: 10 }).rows.at(0);
    assert.equal(ask?.requestSource, 'github');
    assert.equal(ask?.requestText, '@acme-jardinero look at this');
    assert.equal(ask?.requesterExternalId, 'lucio');
    assert.equal(ask?.replyTargetType, 'github_comment');
    assert.equal(ask?.replyTargetId, '4242');
    assert.equal(ask?.workflowInstanceId, store.listOpenPrMaintainers().at(0)?.id);
  });
});

describe('onPrCICompleted', () => {
  const cases: CiCase[] = [
    {
      name: 'When the instance is pending then should ignore it',
      from: 'prm_pending',
      checksAreRed: true,
      want: { state: 'prm_pending' },
    },
    {
      name: 'When a sandbox run is in flight then should ignore it',
      from: 'prm_working',
      checksAreRed: true,
      want: { state: 'prm_working' },
    },
    {
      // We tried and could not; green checks do not change that.
      name: 'When the attempts are exhausted then should ignore it',
      from: 'prm_attempts_exhausted',
      checksAreRed: false,
      want: { state: 'prm_attempts_exhausted' },
    },
    {
      name: 'When waiting and the checks are green then should ignore it',
      from: 'prm_waiting',
      checksAreRed: false,
      want: { state: 'prm_waiting' },
    },
    {
      name: 'When waiting and the checks are red then should dispatch a new pass',
      from: 'prm_waiting',
      checksAreRed: true,
      want: { state: 'prm_working', startedRuns: 1, attemptCount: 1 },
    },
    {
      name: 'When the pull request was dismissed then should ignore it',
      from: 'prm_dismissed',
      checksAreRed: true,
      want: { state: 'prm_dismissed' },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = openInstanceIn(c.from);

      const error = await onPrCICompleted(engine, {
        ...pullRequestRef(),
        checksAreRed: c.checksAreRed,
      });

      assertOutcome(c.want, instance, error);
    });
  }
});

describe('onPrSynchronize', () => {
  const cases: StateOnlyCase[] = [
    {
      name: 'When the instance is pending then should ignore it',
      from: 'prm_pending',
      want: { state: 'prm_pending' },
    },
    {
      name: 'When a sandbox run is in flight then should ignore it',
      from: 'prm_working',
      want: { state: 'prm_working' },
    },
    {
      name: 'When the attempts are exhausted then should ignore it',
      from: 'prm_attempts_exhausted',
      want: { state: 'prm_attempts_exhausted' },
    },
    {
      name: 'When the instance is waiting then should dispatch a pass over the new head',
      from: 'prm_waiting',
      want: {
        state: 'prm_working',
        startedRuns: 1,
        attemptCount: 1,
        lastActedCommitSha: 'sha-new',
      },
    },
    {
      name: 'When the push is the one our own pass made then should ignore it',
      from: 'prm_waiting',
      arrange: (instance) => {
        instance.lastActedCommitSha = 'sha-new';
        setState(engine, instance, 'prm_waiting');
      },
      want: { state: 'prm_waiting', lastActedCommitSha: 'sha-new' },
    },
    {
      name: 'When the pull request was dismissed then should ignore it',
      from: 'prm_dismissed',
      want: { state: 'prm_dismissed' },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = openInstanceIn(c.from);
      c.arrange?.(instance);

      const error = await onPrSynchronize(engine, pullRequestRef(), 'sha-new');

      assertOutcome(c.want, instance, error);
    });
  }
});

describe('onPrMerged', () => {
  const cases: ClosingCase[] = closingCases('prm_merged');

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.from ? openInstanceIn(c.from) : undefined;
      if (instance) arrangeClosing(instance, c);

      const error = await onPrMerged(engine, pullRequestRef());

      assertClosing(c, instance, error);
    });
  }
});

describe('onPrClosed', () => {
  const cases: ClosingCase[] = closingCases('prm_closed');

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.from ? openInstanceIn(c.from) : undefined;
      if (instance) arrangeClosing(instance, c);

      const error = await onPrClosed(engine, pullRequestRef());

      assertClosing(c, instance, error);
    });
  }
});

describe('onSandboxRunSucceeded', () => {
  const cases: RunOutcomeCase[] = [
    {
      name: 'When the run moved the head then should move it to waiting and record the head',
      from: 'prm_working',
      want: { state: 'prm_waiting', lastActedCommitSha: 'sha-head' },
    },
    {
      name: 'When the run left the head where it was then should give the attempt back',
      from: 'prm_working',
      arrange: (instance) => {
        instance.lastActedCommitSha = 'sha-head';
        instance.attemptCount = 1;
        setState(engine, instance, 'prm_working');
      },
      want: { state: 'prm_waiting', lastActedCommitSha: 'sha-head', attemptCount: 0 },
    },
    {
      name: 'When the head did not move and no attempt was counted then should leave it at zero',
      from: 'prm_working',
      arrange: (instance) => {
        instance.lastActedCommitSha = 'sha-head';
        setState(engine, instance, 'prm_working');
      },
      want: { state: 'prm_waiting', lastActedCommitSha: 'sha-head', attemptCount: 0 },
    },
    {
      name: 'When the pull request cannot be read then should leave the attempt as it was',
      from: 'prm_working',
      arrange: (instance) => {
        instance.attemptCount = 1;
        setState(engine, instance, 'prm_working');
        github.readFailure = new Error('GitHub is down');
      },
      want: { state: 'prm_waiting', attemptCount: 1 },
    },
    {
      // An outcome for a run the instance is no longer waiting on is stale.
      name: 'When the instance moved on from that run then should ignore it',
      from: 'prm_working',
      detachRun: true,
      want: { state: 'prm_working' },
    },
    {
      name: 'When the instance is no longer working then should ignore it',
      from: 'prm_waiting',
      want: { state: 'prm_waiting' },
    },
    {
      name: 'When comments arrived while the pass ran then should close all of them',
      from: 'prm_working',
      pendingAsks: 3,
      want: { state: 'prm_waiting', unconsumedAsks: 0, lastActedCommitSha: 'sha-head' },
    },
    {
      name: 'When the run belongs to another workflow then should ignore it',
      from: 'prm_working',
      foreignRun: true,
      want: { state: 'prm_working' },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = openInstanceIn(c.from);
      c.arrange?.(instance);
      const runId = attachRun(instance, c);
      for (let ask = 0; ask < (c.pendingAsks ?? 0); ask += 1) {
        store.createRequest({
          requestSource: 'github',
          requestText: `progress ${ask}`,
          repositoryId,
          subjectType: 'pull_request',
          subjectExternalId: String(PULL_REQUEST_NUMBER),
        });
      }

      const error = await onSandboxRunSucceeded(engine, runId);

      assertOutcome(c.want, instance, error);
    });
  }
});

describe('onSandboxRunFailed', () => {
  const cases: RunOutcomeCase[] = [
    {
      name: 'When attempts are left then should dispatch another pass',
      from: 'prm_working',
      want: { state: 'prm_working', startedRuns: 1, attemptCount: 1 },
    },
    {
      name: 'When the attempts are spent then should give up into `prm_attempts_exhausted`',
      from: 'prm_working',
      arrange: (instance) => {
        instance.attemptCount = MAX_ATTEMPTS;
        setState(engine, instance, 'prm_working');
      },
      want: {
        state: 'prm_attempts_exhausted',
        attemptCount: MAX_ATTEMPTS,
        needsHumanReason: 'attempts_exhausted',
      },
    },
    {
      name: 'When the instance moved on from that run then should ignore it',
      from: 'prm_working',
      detachRun: true,
      want: { state: 'prm_working' },
    },
    {
      name: 'When the instance is no longer working then should ignore it',
      from: 'prm_pending',
      want: { state: 'prm_pending' },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = openInstanceIn(c.from);
      const runId = attachRun(instance, c);
      c.arrange?.(instance);

      const error = await onSandboxRunFailed(engine, runId);

      assertOutcome(c.want, instance, error);
    });
  }
});

describe('onOperatorRetry', () => {
  const cases: OperatorCase[] = [
    {
      // Without clearing the budget the instance would walk straight back into
      // the state it was retried out of.
      name: 'When the attempts are exhausted then should start again with a fresh budget',
      from: 'prm_attempts_exhausted',
      arrange: (instance) => {
        instance.attemptCount = MAX_ATTEMPTS;
        setState(engine, instance, 'prm_attempts_exhausted');
      },
      want: { state: 'prm_working', startedRuns: 1, attemptCount: 1 },
    },
    {
      name: 'When the instance is pending then should ignore it',
      from: 'prm_pending',
      want: { state: 'prm_pending' },
    },
    {
      name: 'When a sandbox run is in flight then should ignore it',
      from: 'prm_working',
      want: { state: 'prm_working' },
    },
    {
      name: 'When the instance is waiting then should ignore it',
      from: 'prm_waiting',
      want: { state: 'prm_waiting' },
    },
    {
      name: 'When the pull request was dismissed then should ignore it',
      from: 'prm_dismissed',
      want: { state: 'prm_dismissed' },
    },
    {
      name: 'When the instance is unknown then should ignore it',
      unknownInstance: true,
      want: { instanceExists: false },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.unknownInstance ? undefined : openInstanceIn(c.from as PrMaintainerState);
      if (instance) c.arrange?.(instance);

      const error = await onOperatorRetry(engine, instance?.id ?? 'missing');

      assertOutcome(c.want, instance, error);
    });
  }
});

describe('onOperatorDismiss', () => {
  const cases: OperatorCase[] = [
    {
      name: 'When the attempts are exhausted then should end it as dismissed',
      from: 'prm_attempts_exhausted',
      want: { state: 'prm_dismissed' },
    },
    {
      name: 'When the instance is pending then should ignore it',
      from: 'prm_pending',
      want: { state: 'prm_pending' },
    },
    {
      name: 'When a sandbox run is in flight then should ignore it',
      from: 'prm_working',
      want: { state: 'prm_working' },
    },
    {
      name: 'When the instance is waiting then should ignore it',
      from: 'prm_waiting',
      want: { state: 'prm_waiting' },
    },
    {
      name: 'When the pull request already ended then should ignore it',
      from: 'prm_merged',
      want: { state: 'prm_merged' },
    },
    {
      name: 'When it was already dismissed then should ignore it',
      from: 'prm_dismissed',
      want: { state: 'prm_dismissed' },
    },
    {
      name: 'When the instance is unknown then should ignore it',
      unknownInstance: true,
      want: { instanceExists: false },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.unknownInstance ? undefined : openInstanceIn(c.from as PrMaintainerState);
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
      from: 'prm_attempts_exhausted',
      want: { state: 'prm_attempts_exhausted', checked: false },
    },
    {
      name: 'When the wait has not elapsed then should leave it alone',
      from: 'prm_pending',
      arrange: (instance) => {
        engine.config.checkWaitMs.prm_pending = 60_000;
        store.markPrMaintainerChecked(instance.id);
      },
      want: { state: 'prm_pending', checked: true },
    },
    {
      // The dispatch never happened: the pool was full or paused, or whoever
      // held the work lock died holding it.
      name: 'When the instance is pending then should retry the dispatch',
      from: 'prm_pending',
      want: { state: 'prm_working', startedRuns: 1, attemptCount: 1, checked: true },
    },
    {
      name: 'When the run is still in the pool then should leave it working',
      from: 'prm_working',
      attachLiveRun: true,
      want: { state: 'prm_working', checked: true },
    },
    {
      name: 'When the run finished without telling us then should move it to waiting',
      from: 'prm_working',
      attachFinishedRun: 'succeeded',
      want: { state: 'prm_waiting', checked: true },
    },
    {
      name: 'When the outcome is still on its way then should leave it working',
      from: 'prm_working',
      attachFinishedRun: 'succeeded',
      keepInPool: true,
      want: { state: 'prm_working', checked: true },
    },
    {
      name: 'When the run died with the process then should dispatch again',
      from: 'prm_working',
      attachLostRun: true,
      want: { state: 'prm_working', startedRuns: 1, attemptCount: 1, checked: true },
    },
    {
      name: 'When waiting and the pull request merged then should close it as merged',
      from: 'prm_waiting',
      snapshot: { state: 'merged' },
      want: { state: 'prm_merged', checked: true },
    },
    {
      name: 'When waiting and the pull request closed then should close it unmerged',
      from: 'prm_waiting',
      snapshot: { state: 'closed' },
      want: { state: 'prm_closed', checked: true },
    },
    {
      name: 'When waiting and the checks are red then should dispatch a pass',
      from: 'prm_waiting',
      snapshot: { checksAreRed: true },
      want: { state: 'prm_working', startedRuns: 1, attemptCount: 1, checked: true },
    },
    {
      name: 'When waiting and a review thread is unresolved then should dispatch a pass',
      from: 'prm_waiting',
      snapshot: { hasUnresolvedReviewThreads: true },
      want: { state: 'prm_working', startedRuns: 1, attemptCount: 1, checked: true },
    },
    {
      name: 'When waiting and there is nothing to do then should leave it waiting',
      from: 'prm_waiting',
      want: { state: 'prm_waiting', checked: true },
    },
    {
      name: 'When the instance is unknown then should ignore it',
      unknownInstance: true,
      want: { instanceExists: false },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.unknownInstance ? undefined : openInstanceIn(c.from as PrMaintainerState);
      if (instance) arrangePeriodic(instance, c);

      const error = await onPeriodicCheck(engine, instance?.id ?? 'missing');

      assertOutcome(c.want, instance, error);
      if (instance) {
        assert.equal(
          (store.getPrMaintainer(instance.id)?.lastStateCheckedAt ?? 0) > 0,
          c.want.checked ?? false,
        );
      }
    });
  }
});

describe('onSystemRecovery', () => {
  const cases: PeriodicCase[] = [
    {
      name: 'When the instance is pending then should dispatch what was owed',
      from: 'prm_pending',
      want: { state: 'prm_working', startedRuns: 1, attemptCount: 1 },
    },
    {
      name: 'When the run survived the restart then should leave it working',
      from: 'prm_working',
      attachLiveRun: true,
      want: { state: 'prm_working' },
    },
    {
      name: 'When the run finished while the process was down then should move it to waiting',
      from: 'prm_working',
      attachFinishedRun: 'succeeded',
      want: { state: 'prm_waiting' },
    },
    {
      name: 'When the run died with the process then should dispatch again',
      from: 'prm_working',
      attachLostRun: true,
      want: { state: 'prm_working', startedRuns: 1, attemptCount: 1 },
    },
    {
      name: 'When the instance is waiting then should leave it for the next event',
      from: 'prm_waiting',
      want: { state: 'prm_waiting' },
    },
    {
      name: 'When the attempts are exhausted then should leave it for a person',
      from: 'prm_attempts_exhausted',
      want: { state: 'prm_attempts_exhausted' },
    },
    {
      name: 'When the pull request was dismissed then should ignore it',
      from: 'prm_dismissed',
      want: { state: 'prm_dismissed' },
    },
    {
      name: 'When the instance is unknown then should ignore it',
      unknownInstance: true,
      want: { instanceExists: false },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const instance = c.unknownInstance ? undefined : openInstanceIn(c.from as PrMaintainerState);
      if (instance) arrangePeriodic(instance, c);

      const error = await onSystemRecovery(engine, instance?.id ?? 'missing');

      assertOutcome(c.want, instance, error);
    });
  }
});

// Every entry point has to hand back the instance lock it took, whatever it
// decided, or a second event for the same pull request would hang.
describe('PrMaintainer entry points release the instance lock', () => {
  const cases: LockCase[] = [
    {
      name: 'When `onPrReadyForReview` runs then should release the lock',
      act: () => onPrReadyForReview(engine, pullRequestRef()),
    },
    {
      name: 'When `onPrToFollow` runs then should release the lock',
      act: () => onPrToFollow(engine, pullRequestRef()),
    },
    {
      name: 'When `onPrDiscovered` runs then should release the lock',
      act: () => onPrDiscovered(engine, pullRequestRef()),
    },
    {
      name: 'When `onPrComment` runs then should release the lock',
      act: () =>
        onPrComment(engine, { ...pullRequestRef(), authoredByUs: false, mentionsUs: false }),
    },
    {
      name: 'When `onPrCICompleted` runs then should release the lock',
      act: () =>
        onPrCICompleted(engine, {
          ...pullRequestRef(),
          checksAreRed: true,
        }),
    },
    {
      name: 'When `onPrSynchronize` runs then should release the lock',
      act: () => onPrSynchronize(engine, pullRequestRef(), 'sha'),
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
      openInstanceIn('prm_waiting');

      await c.act();

      assert.equal(locker.isBalanced, true);
      assert.ok(locker.acquired.length > 0);
    });
  }
});

describe('The moment a pull request is adopted', () => {
  const cases: Array<{ name: string; alreadyOpen: boolean; wantMoments: string[] }> = [
    {
      name: 'When the pull request was never seen then should announce it is maintained now',
      alreadyOpen: false,
      wantMoments: ['pullRequestAdopted'],
    },
    {
      // The second event about the same pull request is not a second adoption.
      name: 'When it is already maintained then should announce nothing',
      alreadyOpen: true,
      wantMoments: [],
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      if (testCase.alreadyOpen) openInstanceIn('prm_waiting');

      await onPrToFollow(engine, pullRequestRef());

      assert.deepEqual(announcer.moments, testCase.wantMoments);
    });
  }
});

function pullRequestRef(): { repositoryId: string; pullRequestNumber: number } {
  return { repositoryId, pullRequestNumber: PULL_REQUEST_NUMBER };
}

function ourPullRequest(): { repositoryId: string; pullRequestNumber: number; headBranch: string } {
  return { ...pullRequestRef(), headBranch: 'agent/fix-1' };
}

// The pass a comment dispatched has to end before the next comment can dispatch
// another, which is what the machine does when a run reports success.
function settleIntoWaiting(prMaintainerId: string): void {
  const instance = store.getPrMaintainer(prMaintainerId) as PrMaintainer;
  if (instance.sandboxRunId) {
    store.finishSandboxRun(instance.sandboxRunId, { runState: 'succeeded' });
  }
  instance.sandboxRunId = null;
  instance.attemptCount = 0;
  setState(engine, instance, 'prm_waiting');
}

function comment(fields: { reviewThreadId?: string }): CommentData {
  return {
    ...pullRequestRef(),
    authoredByUs: false,
    mentionsUs: false,
    reviewThreadId: fields.reviewThreadId,
    comment: {
      author: 'someone',
      body: 'please look',
      externalId: '991',
      commentType: 'issue',
    },
  };
}

function openInstanceIn(state: PrMaintainerState): PrMaintainer {
  const instance = store.openPrMaintainer({
    repositoryId,
    pullRequestNumber: PULL_REQUEST_NUMBER,
  });
  setState(engine, instance, state);
  return instance;
}

function attachRun(instance: PrMaintainer, c: RunOutcomeCase): string {
  const runId = store.startSandboxRun({
    agentName: 'PrMaintainer',
    workflowType: c.foreignRun ? 'linear_implementer' : 'pr_maintainer',
    workflowInstanceId: instance.id,
  }).id;
  if (!c.detachRun && !c.foreignRun) {
    instance.sandboxRunId = runId;
    setState(engine, instance, instance.workflowState);
  }
  return runId;
}

function arrangePeriodic(instance: PrMaintainer, c: PeriodicCase): void {
  if (c.snapshot) github.snapshot = { ...github.snapshot, ...c.snapshot };
  if (c.attachLiveRun || c.attachLostRun || c.attachFinishedRun) {
    const runId = store.startSandboxRun({
      agentName: 'PrMaintainer',
      workflowType: 'pr_maintainer',
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

function announcementCases(): AnnouncementCase[] {
  return [
    {
      name: 'When there is no instance yet then should open one and dispatch',
      want: { state: 'prm_working', startedRuns: 1, attemptCount: 1 },
    },
    {
      name: 'When the dispatch is still owed then should dispatch it',
      from: 'prm_pending',
      want: { state: 'prm_working', startedRuns: 1, attemptCount: 1 },
    },
    ...OPEN_STATES.filter((state) => state !== 'prm_pending').map((state) => ({
      name: `When the pull request is already followed in \`${state}\` then should leave it alone`,
      from: state,
      want: { state },
    })),
    {
      // GitHub cannot reopen a merged pull request, so nothing can revive it.
      name: 'When the pull request already merged then should leave the ending alone',
      from: 'prm_merged' as PrMaintainerState,
      want: { state: 'prm_merged' as PrMaintainerState },
    },
    {
      // A closed one comes back through OnPrReopened and not through this door.
      name: 'When the pull request was closed then should leave the ending alone',
      from: 'prm_closed' as PrMaintainerState,
      want: { state: 'prm_closed' as PrMaintainerState },
    },
    {
      name: 'When the pull request was dismissed then should leave the ending alone',
      from: 'prm_dismissed' as PrMaintainerState,
      want: { state: 'prm_dismissed' as PrMaintainerState },
    },
  ];
}

function assertAnnouncement(
  c: AnnouncementCase,
  instance: PrMaintainer | undefined,
  error: Error | undefined,
): void {
  assert.equal(error?.constructor.name, c.want.errorName);
  const stored = instance
    ? store.getPrMaintainer(instance.id)
    : store.findOpenPrMaintainer(repositoryId, PULL_REQUEST_NUMBER);
  assert.equal(stored?.workflowState, c.want.state);
  assert.equal(pool.started.length, c.want.startedRuns ?? 0);
}

function closingCases(finalState: PrMaintainerState): ClosingCase[] {
  return [
    ...OPEN_STATES.filter((state) => state !== 'prm_working').map((state) => ({
      name: `When the pull request was in \`${state}\` then should close it as \`${finalState}\``,
      from: state,
      want: { state: finalState },
    })),
    {
      // The agent is still working on a pull request nobody is going to read.
      name: `When a sandbox run is in flight then should abort it and close as \`${finalState}\``,
      from: 'prm_working' as PrMaintainerState,
      attachRunToAbort: true,
      want: { state: finalState, abortedRuns: 1 },
    },
    {
      // A repeated webhook must not turn an ending into an error.
      name: 'When the pull request already ended then should leave the ending alone',
      from: 'prm_merged' as PrMaintainerState,
      want: { state: 'prm_merged' as PrMaintainerState },
    },
    {
      name: 'When the pull request was dismissed then should leave the ending alone',
      from: 'prm_dismissed' as PrMaintainerState,
      want: { state: 'prm_dismissed' as PrMaintainerState },
    },
    {
      name: 'When there is no instance then should ignore it',
      want: { instanceExists: false },
    },
  ];
}

function arrangeClosing(instance: PrMaintainer, c: ClosingCase): void {
  if (c.attachRunToAbort) {
    const runId = store.startSandboxRun({
      agentName: 'PrMaintainer',
      workflowType: 'pr_maintainer',
      workflowInstanceId: instance.id,
    }).id;
    instance.sandboxRunId = runId;
    setState(engine, instance, instance.workflowState);
    pool.startSandbox(runId);
    pool.started.length = 0;
  }
  c.arrange?.(instance);
}

function assertClosing(
  c: ClosingCase,
  instance: PrMaintainer | undefined,
  error: Error | undefined,
): void {
  assertOutcome(c.want, instance, error);
  assert.equal(pool.aborted.length, c.want.abortedRuns ?? 0);
}

function assertOutcome(
  want: Want,
  instance: PrMaintainer | undefined,
  error: Error | undefined,
): void {
  assert.equal(error?.constructor.name, want.errorName);
  if (want.instanceExists === false) {
    assert.equal(store.findOpenPrMaintainer(repositoryId, PULL_REQUEST_NUMBER), undefined);
    assert.equal(pool.started.length, 0);
    return;
  }
  // An event may be what opened the instance, so without one to read by id the
  // subject is what finds it.
  const stored = instance
    ? store.getPrMaintainer(instance.id)
    : store.findOpenPrMaintainer(repositoryId, PULL_REQUEST_NUMBER);
  assert.equal(stored?.workflowState, want.state);
  assert.equal(pool.started.length, want.startedRuns ?? 0);
  assert.equal(stored?.attemptCount, want.attemptCount ?? 0);
  assert.equal(stored?.needsHumanReason, want.needsHumanReason ?? null);
  assert.equal(stored?.lastActedCommitSha, want.lastActedCommitSha ?? null);
  if (want.unconsumedAsks !== undefined) {
    assert.equal(
      store.listUnconsumedRequests('pull_request', String(PULL_REQUEST_NUMBER), repositoryId)
        .length,
      want.unconsumedAsks,
    );
  }
}

interface Want {
  state?: PrMaintainerState;
  instanceExists?: boolean;
  startedRuns?: number;
  attemptCount?: number;
  needsHumanReason?: string;
  lastActedCommitSha?: string;
  abortedRuns?: number;
  checked?: boolean;
  errorName?: string;
  unconsumedAsks?: number;
}

interface AnnouncementCase {
  name: string;
  from?: PrMaintainerState;
  facts?: { headBranch?: string; isDraft?: boolean };
  arrange?: (instance: PrMaintainer) => void;
  want: Want;
}

interface CommentCase {
  name: string;
  from?: PrMaintainerState;
  authoredByUs?: boolean;
  mentionsUs?: boolean;
  reviewThreadId?: string;
  // What GitHub sent, for a case that turns on the comment rather than on the state.
  comment?: CommentData['comment'];
  arrange?: (instance: PrMaintainer) => void;
  want: Want & { pickedUp?: boolean };
}

interface CiCase {
  name: string;
  from: PrMaintainerState;
  checksAreRed: boolean;
  want: Want;
}

interface StateOnlyCase {
  name: string;
  from: PrMaintainerState;
  arrange?: (instance: PrMaintainer) => void;
  want: Want;
}

interface ClosingCase {
  name: string;
  from?: PrMaintainerState;
  attachRunToAbort?: boolean;
  arrange?: (instance: PrMaintainer) => void;
  want: Want;
}

interface RunOutcomeCase {
  name: string;
  from: PrMaintainerState;
  pendingAsks?: number;
  detachRun?: boolean;
  foreignRun?: boolean;
  arrange?: (instance: PrMaintainer) => void;
  want: Want;
}

interface OperatorCase {
  name: string;
  from?: PrMaintainerState;
  unknownInstance?: boolean;
  arrange?: (instance: PrMaintainer) => void;
  want: Want;
}

interface PeriodicCase {
  name: string;
  from?: PrMaintainerState;
  unknownInstance?: boolean;
  attachLiveRun?: boolean;
  attachLostRun?: boolean;
  attachFinishedRun?: 'succeeded' | 'failed';
  keepInPool?: boolean;
  snapshot?: Partial<FakeGitHub['snapshot']>;
  arrange?: (instance: PrMaintainer) => void;
  want: Want;
}

interface LockCase {
  name: string;
  act: () => Promise<Error | undefined>;
}
