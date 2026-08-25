import type { PrMaintainer, PrMaintainerState } from '../../../store/types.js';
import {
  type AgentPullRequestFacts,
  isAgentPullRequest,
} from '../../../workflows/pr/pr-maintainer.js';
import {
  retrievePullRequestConversation,
  runPrMaintainerFSM,
  setState,
  UnsupportedStateError,
} from './engine.js';
import type { PrMaintainerStateEngine, PullRequestSnapshot } from './service.js';
import type { Lock } from '../execution.js';
import {
  asError,
  consumeRequest,
  recordWorkflowInstanceOpened,
  REPLY_CAP_REACHED_NOTE,
} from '../execution.js';

// Top-level comments and review submissions sit in no GitHub thread, so they are
// counted against the pull request under this reserved key.
const PULL_REQUEST_THREAD_ID = 'pull_request';

export interface PullRequestRef {
  repositoryId: string;
  pullRequestNumber: number;
}

export interface PullRequestFacts extends PullRequestRef, AgentPullRequestFacts {
  isDraft?: boolean;
}

export interface CommentData extends PullRequestRef {
  isDraft?: boolean;
  isMerged?: boolean;
  authoredByUs: boolean;
  mentionsUs: boolean;
  reviewThreadId?: string;
  // commentType is where a pickup mark goes; a review body has no endpoint for one.
  comment?: {
    author?: string;
    body?: string;
    externalId?: string;
    commentType?: 'issue' | 'review';
  };
}

export interface CiData extends PullRequestRef {
  checksAreRed: boolean;
}

interface TakenPrMaintainer {
  instance: PrMaintainer;
  lock: Lock;
}

// onPrReadyForReview is a pull request leaving draft, which is how the work of
// LinearImplementer and FixImplementer reaches us. Somebody else's draft leaving draft
// is not ours to maintain.
export async function onPrReadyForReview(
  engine: PrMaintainerStateEngine,
  data: PullRequestFacts,
  requestRouterId?: string,
): Promise<Error | undefined> {
  const ref = data;
  const taken = await createOrTakePrMaintainer(engine, ref, {
    create: isAgentPullRequest(data, engine.config.agentPullRequest),
    requestRouterId,
  });
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      // The state an instance is born in, so this covers both a new pull
      // request and one whose dispatch is still owed.
      case 'prm_pending':
        return runPrMaintainerFSM(engine, instance);

      // Already being followed, and a second announcement is not new work.
      case 'prm_working':
      case 'prm_waiting':
      case 'prm_attempts_exhausted':
        return undefined;

      // GitHub cannot reopen a merged pull request, and a closed one comes back
      // through OnPrReopened rather than through an announcement.
      case 'prm_merged':
      case 'prm_closed':
      case 'prm_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

// onPrToFollow is a person handing us a pull request from Discord, through the Router.
// Tagging the agent on the pull request itself arrives as OnPrComment.
export async function onPrToFollow(
  engine: PrMaintainerStateEngine,
  ref: PullRequestRef,
  requestRouterId?: string,
): Promise<Error | undefined> {
  const taken = await createOrTakePrMaintainer(engine, ref, { create: true, requestRouterId });
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'prm_pending':
        return runPrMaintainerFSM(engine, instance);

      case 'prm_working':
      case 'prm_waiting':
      case 'prm_attempts_exhausted':
        return undefined;

      // GitHub cannot reopen a merged pull request, and a closed one comes back
      // through OnPrReopened rather than through an announcement.
      case 'prm_merged':
      case 'prm_closed':
      case 'prm_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

// onPrDiscovered is the sweep finding an open pull request with no instance, which is
// the safety net for a webhook that never arrived.
export async function onPrDiscovered(
  engine: PrMaintainerStateEngine,
  data: PullRequestFacts,
): Promise<Error | undefined> {
  const ref = data;
  // A draft is still the implementer's, and a pull request that is not ours is nobody's
  // to maintain, so the sweep only opens what we may act on.
  const create = data.isDraft !== true && isAgentPullRequest(data, engine.config.agentPullRequest);
  const taken = await createOrTakePrMaintainer(engine, ref, { create });
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'prm_pending':
        return runPrMaintainerFSM(engine, instance);

      case 'prm_working':
      case 'prm_waiting':
      case 'prm_attempts_exhausted':
        return undefined;

      // GitHub cannot reopen a merged pull request, and a closed one comes back
      // through OnPrReopened rather than through an announcement.
      case 'prm_merged':
      case 'prm_closed':
      case 'prm_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

// onPrReopened is GitHub reopening a pull request we had closed. It keeps its number,
// so it is the same subject coming back, with a fresh budget.
export async function onPrReopened(
  engine: PrMaintainerStateEngine,
  data: PullRequestFacts,
): Promise<Error | undefined> {
  const ref = data;
  const taken = await createOrTakePrMaintainer(engine, ref, {
    create: isAgentPullRequest(data, engine.config.agentPullRequest),
  });
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'prm_pending':
        return runPrMaintainerFSM(engine, instance);

      case 'prm_working':
      case 'prm_waiting':
      case 'prm_attempts_exhausted':
        return undefined;

      // It keeps its number, so this is the same subject coming back and the
      // counters start over.
      case 'prm_closed':
        instance.attemptCount = 0;
        instance.needsHumanReason = null;
        return setStateAndRun(engine, instance, 'prm_pending');

      // GitHub cannot reopen a merged pull request, and dismissed work stays dismissed.
      case 'prm_merged':
      case 'prm_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

export async function onPrComment(
  engine: PrMaintainerStateEngine,
  data: CommentData,
): Promise<Error | undefined> {
  // Our own echo. The only thing stopping an endless reply loop.
  if (data.authoredByUs) return undefined;

  // Tagging the agent on a pull request is how a person hands us one we were not
  // following, whatever state it is in; a merged one has nothing left to work on.
  const create = data.mentionsUs && data.isMerged !== true;
  const requestRouterId =
    create || engine.store.findPrMaintainerByPullRequest(data.repositoryId, data.pullRequestNumber)
      ? recordAsk(engine, data)
      : undefined;
  const taken = await createOrTakePrMaintainer(engine, data, { create, requestRouterId });
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      // The pass in flight consumes this ask when it ends, so the comment is taken
      // and marked even though it gets no pass of its own.
      case 'prm_working':
        await markCommentPickedUp(engine, instance, data);
        return undefined;

      // A tag on a pull request nobody was following opens it here, so this is
      // where that pass is dispatched.
      case 'prm_pending':
        if (repliesExhausted(engine, instance, data, requestRouterId)) return undefined;
        consumeRequest(engine.store, 'pr_maintainer', requestRouterId, instance);
        await markCommentPickedUp(engine, instance, data);
        return runPrMaintainerFSM(engine, instance);

      case 'prm_waiting':
        if (repliesExhausted(engine, instance, data, requestRouterId)) return undefined;
        consumeRequest(engine.store, 'pr_maintainer', requestRouterId, instance);
        await markCommentPickedUp(engine, instance, data);
        instance.needsHumanReason = null;
        return setStateAndRun(engine, instance, 'prm_pending');

      case 'prm_attempts_exhausted':
        // Writing on a pull request we stopped working on is not by itself a
        // request to start again. Tagging us is.
        if (!data.mentionsUs) return undefined;
        if (repliesExhausted(engine, instance, data, requestRouterId)) return undefined;
        consumeRequest(engine.store, 'pr_maintainer', requestRouterId, instance);
        await markCommentPickedUp(engine, instance, data);
        instance.attemptCount = 0;
        instance.needsHumanReason = null;
        return setStateAndRun(engine, instance, 'prm_pending');

      // The pull request already ended; a late event about it changes nothing.
      case 'prm_merged':
      case 'prm_closed':
      case 'prm_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

export async function onPrCICompleted(
  engine: PrMaintainerStateEngine,
  data: CiData,
): Promise<Error | undefined> {
  const taken = await createOrTakePrMaintainer(engine, data, { create: false });
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'prm_pending':
      case 'prm_working':
      case 'prm_attempts_exhausted':
        return undefined;

      case 'prm_waiting':
        if (!data.checksAreRed) return undefined;
        instance.needsHumanReason = null;
        return setStateAndRun(engine, instance, 'prm_pending');

      // The pull request already ended; a late event about it changes nothing.
      case 'prm_merged':
      case 'prm_closed':
      case 'prm_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

export async function onPrSynchronize(
  engine: PrMaintainerStateEngine,
  ref: PullRequestRef,
  headCommitSha: string,
): Promise<Error | undefined> {
  const taken = await createOrTakePrMaintainer(engine, ref, { create: false });
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'prm_pending':
      case 'prm_working':
      case 'prm_attempts_exhausted':
        return undefined;

      case 'prm_waiting':
        // A push of ours arrives here as anyone else's would, and answering it would run a
        // pass over the head that pass just wrote.
        if (headCommitSha === instance.lastActedCommitSha) return undefined;
        instance.lastActedCommitSha = headCommitSha;
        instance.needsHumanReason = null;
        return setStateAndRun(engine, instance, 'prm_pending');

      // The pull request already ended; a late event about it changes nothing.
      case 'prm_merged':
      case 'prm_closed':
      case 'prm_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

export async function onOperatorRetry(
  engine: PrMaintainerStateEngine,
  prMaintainerId: string,
): Promise<Error | undefined> {
  const taken = await takePrMaintainerById(engine, prMaintainerId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'prm_attempts_exhausted':
        instance.attemptCount = 0;
        instance.needsHumanReason = null;
        return setStateAndRun(engine, instance, 'prm_pending');

      // Nothing to retry: the work is either owed or already in flight.
      case 'prm_pending':
      case 'prm_working':
      case 'prm_waiting':
        return undefined;

      // The pull request already ended; a late event about it changes nothing.
      case 'prm_merged':
      case 'prm_closed':
      case 'prm_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

// onOperatorDismiss is the other answer to a pull request we gave up on: a person read it
// and stopped it, so the instance ends here.
export async function onOperatorDismiss(
  engine: PrMaintainerStateEngine,
  prMaintainerId: string,
): Promise<Error | undefined> {
  const taken = await takePrMaintainerById(engine, prMaintainerId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'prm_attempts_exhausted':
        instance.needsHumanReason = null;
        return setState(engine, instance, 'prm_dismissed');

      // Only what stopped for a person is theirs to dismiss; the rest is in flight or
      // already ended.
      case 'prm_pending':
      case 'prm_working':
      case 'prm_waiting':
      case 'prm_merged':
      case 'prm_closed':
      case 'prm_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

export async function onPrMerged(
  engine: PrMaintainerStateEngine,
  ref: PullRequestRef,
): Promise<Error | undefined> {
  const taken = await createOrTakePrMaintainer(engine, ref, { create: false });
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'prm_pending':
      case 'prm_waiting':
      case 'prm_attempts_exhausted':
        return setState(engine, instance, 'prm_merged');

      case 'prm_working':
        return processPrClosingWhileWorking(engine, instance, 'prm_merged');

      // The pull request already ended; a late event about it changes nothing.
      case 'prm_merged':
      case 'prm_closed':
      case 'prm_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

export async function onPrClosed(
  engine: PrMaintainerStateEngine,
  ref: PullRequestRef,
): Promise<Error | undefined> {
  const taken = await createOrTakePrMaintainer(engine, ref, { create: false });
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'prm_pending':
      case 'prm_waiting':
      case 'prm_attempts_exhausted':
        return setState(engine, instance, 'prm_closed');

      case 'prm_working':
        return processPrClosingWhileWorking(engine, instance, 'prm_closed');

      // The pull request already ended; a late event about it changes nothing.
      case 'prm_merged':
      case 'prm_closed':
      case 'prm_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

export async function onSandboxRunSucceeded(
  engine: PrMaintainerStateEngine,
  sandboxRunId: string,
): Promise<Error | undefined> {
  const taken = await takePrMaintainerBySandboxRun(engine, sandboxRunId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'prm_working':
        instance.sandboxRunId = null;
        instance.needsHumanReason = null;
        consumeAsksAnswered(engine, instance);
        await settleAttempt(engine, instance);
        return setStateAndRun(engine, instance, 'prm_waiting');

      default:
        // An outcome that arrives in any other state is stale.
        return undefined;
    }
  } finally {
    taken.lock.release();
  }
}

export async function onSandboxRunFailed(
  engine: PrMaintainerStateEngine,
  sandboxRunId: string,
): Promise<Error | undefined> {
  const taken = await takePrMaintainerBySandboxRun(engine, sandboxRunId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'prm_working':
        instance.sandboxRunId = null;
        if (instance.attemptCount >= engine.config.maxAttempts) {
          instance.needsHumanReason = 'attempts_exhausted';
          return setState(engine, instance, 'prm_attempts_exhausted');
        }
        instance.needsHumanReason = null;
        return setStateAndRun(engine, instance, 'prm_pending');

      default:
        return undefined;
    }
  } finally {
    taken.lock.release();
  }
}

// onPeriodicCheck is one tick of the clock. The clock knows no cadences: each state
// decides whether enough time has passed to look again.
export async function onPeriodicCheck(
  engine: PrMaintainerStateEngine,
  prMaintainerId: string,
): Promise<Error | undefined> {
  const taken = await takePrMaintainerById(engine, prMaintainerId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    const wait = engine.config.checkWaitMs[instance.workflowState];
    // A state left out of the map is never looked at, on purpose.
    if (wait === undefined) return undefined;
    if (Date.now() - (instance.lastStateCheckedAt ?? 0) < wait) return undefined;
    engine.store.markPrMaintainerChecked(instance.id);

    switch (instance.workflowState) {
      case 'prm_pending':
        // The dispatch never happened: the pool was full or paused, or whoever
        // held the work lock died holding it.
        return runPrMaintainerFSM(engine, instance);

      case 'prm_working':
        return processSandboxRunWhileWorking(engine, instance);

      case 'prm_waiting':
        return await processPullRequestWhileWaiting(engine, instance);

      // Only a person moves this one, so there is nothing to look at.
      case 'prm_attempts_exhausted':
        return undefined;

      // The pull request already ended; a late event about it changes nothing.
      case 'prm_merged':
      case 'prm_closed':
      case 'prm_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

export async function onSystemRecovery(
  engine: PrMaintainerStateEngine,
  prMaintainerId: string,
): Promise<Error | undefined> {
  const taken = await takePrMaintainerById(engine, prMaintainerId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'prm_pending':
        return runPrMaintainerFSM(engine, instance);

      case 'prm_working':
        return processSandboxRunWhileWorking(engine, instance);

      case 'prm_waiting':
      case 'prm_attempts_exhausted':
        // Nothing was in flight, so the next event or the next tick moves it.
        return undefined;

      // The pull request already ended; a late event about it changes nothing.
      case 'prm_merged':
      case 'prm_closed':
      case 'prm_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

// processPrClosingWhileWorking stops the sandbox before writing the final state,
// because the pull request ended while an agent was still working on it.
function processPrClosingWhileWorking(
  engine: PrMaintainerStateEngine,
  instance: PrMaintainer,
  finalState: 'prm_merged' | 'prm_closed',
): Error | undefined {
  let abortError: Error | undefined;
  const sandboxRunId = instance.sandboxRunId;
  if (sandboxRunId) {
    try {
      engine.pool.abort(sandboxRunId);
      engine.store.finishSandboxRun(sandboxRunId, { runState: 'aborted' });
      instance.sandboxRunId = null;
    } catch (error) {
      abortError = asError(error);
    }
  }
  const writeError = setState(engine, instance, finalState);
  return abortError ?? writeError;
}

// processSandboxRunWhileWorking finds out what became of the run. It may have finished
// without anyone telling us, or died with the process, and each ends somewhere
// different.
function processSandboxRunWhileWorking(
  engine: PrMaintainerStateEngine,
  instance: PrMaintainer,
): Error | undefined {
  const sandboxRun = instance.sandboxRunId
    ? engine.store.getSandboxRun(instance.sandboxRunId)
    : undefined;
  instance.needsHumanReason = null;

  switch (sandboxRun?.runState) {
    case 'pending':
    case 'running':
      // The row outlives a process crash and the pool does not, so the pool is
      // the only thing that knows whether the sandbox is still alive.
      if (engine.pool.isExecuting(sandboxRun.id)) return undefined;
      engine.store.finishSandboxRun(sandboxRun.id, { runState: 'orphaned' });
      instance.sandboxRunId = null;
      return setStateAndRun(engine, instance, 'prm_pending');

    case 'succeeded':
      // The pool closes the run row before it hands the outcome over, so a run it still
      // holds is one whose outcome is on its way.
      if (engine.pool.isExecuting(sandboxRun.id)) return undefined;
      instance.sandboxRunId = null;
      return setStateAndRun(engine, instance, 'prm_waiting');

    default:
      // Finished badly or the row is gone; either way nothing is in flight.
      instance.sandboxRunId = null;
      return setStateAndRun(engine, instance, 'prm_pending');
  }
}

// processPullRequestWhileWaiting is one GitHub read per tick, which is the safety net
// for the pull_request and check_suite webhooks we may never receive.
async function processPullRequestWhileWaiting(
  engine: PrMaintainerStateEngine,
  instance: PrMaintainer,
): Promise<Error | undefined> {
  const repository = engine.store.getRepositoryById(instance.repositoryId);
  if (!repository) return undefined;
  const snapshot = await engine.github.readPullRequest(
    repository.fullName,
    instance.pullRequestNumber,
  );

  if (snapshot.state === 'merged') return setState(engine, instance, 'prm_merged');
  if (snapshot.state === 'closed') return setState(engine, instance, 'prm_closed');
  if (!snapshot.checksAreRed && !snapshot.hasUnresolvedReviewThreads) return undefined;
  instance.needsHumanReason = null;
  return setStateAndRun(engine, instance, 'prm_pending');
}

// settleAttempt spends an attempt only when the pass moved the head; answering a comment
// without touching the code gives it back.
async function settleAttempt(
  engine: PrMaintainerStateEngine,
  instance: PrMaintainer,
): Promise<void> {
  const snapshot = await readPullRequestQuietly(engine, instance);
  if (!snapshot) return;
  if (snapshot.headCommitSha === instance.lastActedCommitSha) {
    instance.attemptCount = Math.max(0, instance.attemptCount - 1);
    return;
  }
  instance.lastActedCommitSha = snapshot.headCommitSha;
}

// readPullRequestQuietly answers what GitHub says now, or nothing when the read fails,
// because a failed read must not decide anything on its own.
async function readPullRequestQuietly(
  engine: PrMaintainerStateEngine,
  instance: PrMaintainer,
): Promise<PullRequestSnapshot | undefined> {
  const repository = engine.store.getRepositoryById(instance.repositoryId);
  if (!repository) return undefined;
  try {
    return await engine.github.readPullRequest(repository.fullName, instance.pullRequestNumber);
  } catch {
    return undefined;
  }
}

// consumeAsksAnswered closes every ask the finished pass could read, because the agent
// works from the whole conversation and not from the one comment that woke it.
function consumeAsksAnswered(engine: PrMaintainerStateEngine, instance: PrMaintainer): void {
  for (const ask of engine.store.listUnconsumedRequests(
    'pull_request',
    String(instance.pullRequestNumber),
    instance.repositoryId,
  )) {
    engine.store.markRequestConsumed(ask.id, 'pr_maintainer', instance.id, instance.repositoryId);
  }
}

// recordAsk writes what a person wrote before any machine acted on it, so a comment
// nothing answered is still readable with who wrote it and where to answer.
function recordAsk(engine: PrMaintainerStateEngine, data: CommentData): string | undefined {
  const comment = data.comment;
  if (!comment) return undefined;
  return engine.store.createRequest({
    requestSource: 'github',
    requestText: comment.body,
    requesterExternalId: comment.author,
    replyTargetType: 'github_comment',
    replyTargetId: comment.externalId,
    repositoryId: data.repositoryId,
    subjectType: 'pull_request',
    subjectExternalId: String(data.pullRequestNumber),
  }).id;
}

function setStateAndRun(
  engine: PrMaintainerStateEngine,
  instance: PrMaintainer,
  state: PrMaintainerState,
): Error | undefined {
  const writeError = setState(engine, instance, state);
  if (writeError) return writeError;
  return runPrMaintainerFSM(engine, instance);
}

// markCommentPickedUp puts the pickup mark on the comment the machine just took, which
// is the only signal the person gets between writing it and the agent answering.
async function markCommentPickedUp(
  engine: PrMaintainerStateEngine,
  instance: PrMaintainer,
  data: CommentData,
): Promise<void> {
  const comment = data.comment;
  // A comment GitHub takes no reaction on, or one we cannot name, has nowhere to mark.
  if (!comment?.externalId || !comment.commentType) return;
  const repository = engine.store.getRepositoryById(instance.repositoryId);
  if (!repository) return;
  const error = await engine.github.markCommentPickedUp(repository.fullName, {
    commentType: comment.commentType,
    commentExternalId: comment.externalId,
  });
  if (!error) return;
  engine.store.appendEvent({
    eventType: 'orchestrator.github_reaction_failed',
    workflowType: 'pr_maintainer',
    workflowInstanceId: instance.id,
    repositoryId: instance.repositoryId,
    metadata: { comment_id: comment.externalId, error: error.message },
  });
}

// A conversation we have already answered maxRepliesPerThread times is a loop, not a
// conversation; the count is per thread, and comments outside a review thread share
// the pull request as theirs.
function repliesExhausted(
  engine: PrMaintainerStateEngine,
  instance: PrMaintainer,
  data: CommentData,
  requestRouterId: string | undefined,
): boolean {
  const thread = engine.store.bumpThreadReply(
    instance.id,
    data.reviewThreadId ?? PULL_REQUEST_THREAD_ID,
  );
  if (thread.replyCount <= engine.config.maxRepliesPerThread) return false;
  engine.store.appendEvent({
    eventType: 'workflow.stopped_answering_thread',
    workflowType: 'pr_maintainer',
    workflowInstanceId: instance.id,
    metadata: { review_thread_id: thread.reviewThreadId, reply_count: thread.replyCount },
  });
  // The note is what separates a deliberate silence from an ask nobody saw.
  if (requestRouterId !== undefined) {
    engine.store.setRequestState(requestRouterId, 'rr_resolved', {
      resolutionNote: REPLY_CAP_REACHED_NOTE,
    });
  }
  return true;
}

// createOrTakePrMaintainer returns the instance locked, whatever its state, the same as
// CreateOrTakePurchaseTransaction in MCA. What an ending means is decided by each
// event's switch.
async function createOrTakePrMaintainer(
  engine: PrMaintainerStateEngine,
  ref: PullRequestRef,
  options: { create: boolean; requestRouterId?: string },
): Promise<TakenPrMaintainer | undefined> {
  // Locking by pull request and not by instance id: the instance may not exist
  // yet, and two events arriving together must not create two of them.
  const lock = await engine.locker.acquire(prMaintainerLockKey(ref));
  if (!lock) return undefined;
  // Taken whatever its state, so an ending is something the switch decides on
  // rather than something that looks like a pull request never seen before.
  let instance = engine.store.findPrMaintainerByPullRequest(
    ref.repositoryId,
    ref.pullRequestNumber,
  );
  if (!instance) {
    // A pull request nobody handed us is not our business.
    if (!options.create) {
      lock.release();
      return undefined;
    }
    instance = engine.store.openPrMaintainer({
      repositoryId: ref.repositoryId,
      pullRequestNumber: ref.pullRequestNumber,
      requestRouterId: options.requestRouterId,
    });
    engine.announcer?.pullRequestAdopted(retrievePullRequestConversation(engine, instance), {
      number: instance.pullRequestNumber,
    });
    recordWorkflowInstanceOpened(engine.store, 'pr_maintainer', instance, {
      pull_request_number: instance.pullRequestNumber,
    });
  }
  return { instance, lock };
}

async function takePrMaintainerById(
  engine: PrMaintainerStateEngine,
  prMaintainerId: string,
): Promise<TakenPrMaintainer | undefined> {
  const known = engine.store.getPrMaintainer(prMaintainerId);
  if (!known) return undefined;
  const lock = await engine.locker.acquire(prMaintainerLockKey(known));
  if (!lock) return undefined;
  // Read again under the lock: whoever held it before may have moved the state.
  const instance = engine.store.getPrMaintainer(prMaintainerId);
  if (!instance) {
    lock.release();
    return undefined;
  }
  return { instance, lock };
}

async function takePrMaintainerBySandboxRun(
  engine: PrMaintainerStateEngine,
  sandboxRunId: string,
): Promise<TakenPrMaintainer | undefined> {
  const sandboxRun = engine.store.getSandboxRun(sandboxRunId);
  if (sandboxRun?.workflowType !== 'pr_maintainer') return undefined;
  const taken = await takePrMaintainerById(engine, sandboxRun.workflowInstanceId);
  if (!taken) return undefined;
  // An outcome for a sandbox run the instance is no longer waiting on is stale.
  if (taken.instance.sandboxRunId !== sandboxRunId) {
    taken.lock.release();
    return undefined;
  }
  return taken;
}

// prMaintainerLockKey is taken by every entry point, so two events for one pull request
// are handled one after the other.
function prMaintainerLockKey(ref: PullRequestRef): string {
  return `pr_maintainer:${ref.repositoryId}:${ref.pullRequestNumber}`;
}
