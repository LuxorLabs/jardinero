import type { LinearImplementer, VerifierVerdict } from '../../../store/types.js';
import { consumeRequest, recordWorkflowInstanceOpened, type Lock } from '../execution.js';
import { runLinearImplementerFSM, setState, UnsupportedStateError } from './engine.js';
import type { PullRequestSnapshot } from '../pr-maintainer/service.js';
import type { LinearImplementerStateEngine } from './service.js';

export interface IssueRef {
  repositoryId: string;
  linearIssueId: string;
  linearIssueIdentifier: string;
  linearSessionId?: string;
  promptContext?: string;
}

export interface PullRequestRef {
  repositoryId: string;
  pullRequestNumber: number;
}

export interface CommentData extends PullRequestRef {
  // Plain data from the adapter, which decides nothing with it: whether this is
  // an event at all is decided here.
  authoredByUs: boolean;
}

// RunOutcome is what the agent reported. Which fields matter depends on the state it
// arrives in: the implementer fills the first three, the verifier the rest.
export interface RunOutcome {
  pullRequestNumber?: number;
  linearSessionId?: string;
  verdict?: VerifierVerdict;
  verifiedCommitSha?: string;
  verifierIssues?: string;
  // A run that ended without producing a verdict at all is broken, not negative,
  // and gets a bounded number of re-runs rather than counting as a rejection.
  hasVerdict?: boolean;
}

interface TakenLinearImplementer {
  instance: LinearImplementer;
  lock: Lock;
}

// onIssueAssigned is the only door into this machine: a person delegated the ticket to
// us.
export async function onIssueAssigned(
  engine: LinearImplementerStateEngine,
  ref: IssueRef,
  requestRouterId?: string,
): Promise<Error | undefined> {
  const taken = await createOrTakeLinearImplementer(engine, ref, { create: true, requestRouterId });
  if (!taken) return undefined;
  const instance = taken.instance;
  instance.linearSessionId = ref.linearSessionId ?? instance.linearSessionId;
  instance.promptContext = ref.promptContext ?? instance.promptContext;
  try {
    switch (instance.workflowState) {
      // The state an instance is born in, so this covers both a new ticket and
      // one whose dispatch is still owed.
      case 'li_pending':
        consumeRequest(engine.store, 'linear_implementer', requestRouterId, instance);
        return runLinearImplementerFSM(engine, instance);

      // Already being worked, and re-assigning is not a second ticket: the pass in
      // flight is what answers the ask.
      case 'li_implementing':
      case 'li_verifying':
      case 'li_waiting_pr':
        consumeRequest(engine.store, 'linear_implementer', requestRouterId, instance);
        return undefined;

      // Re-assigning something we gave up on is a person asking again.
      case 'li_needs_human':
        consumeRequest(engine.store, 'linear_implementer', requestRouterId, instance);
        return resumeWithFreshBudget(engine, instance);

      // The pull request was closed without merging, so the ticket is still
      // open work and delegating it again is a second pass.
      case 'li_abandoned':
        consumeRequest(engine.store, 'linear_implementer', requestRouterId, instance);
        return resumeWithFreshBudget(engine, instance);

      // Already delivered. Re-assigning is refused: this one is done, and whatever is
      // wanted now is another ticket, so the ask is left for a person to answer.
      case 'li_done':
      case 'li_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

export async function onIssueCommented(
  engine: LinearImplementerStateEngine,
  ref: IssueRef,
): Promise<Error | undefined> {
  const taken = await createOrTakeLinearImplementer(engine, ref, { create: false });
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      // The comment is recorded as an unconsumed request either way, so a run in
      // flight picks it up when it lands rather than losing it.
      case 'li_pending':
      case 'li_implementing':
      case 'li_verifying':
      case 'li_waiting_pr':
        return undefined;

      case 'li_needs_human':
        return resumeWithFreshBudget(engine, instance);

      case 'li_done':
      case 'li_abandoned':
      case 'li_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

export async function onPrComment(
  engine: LinearImplementerStateEngine,
  data: CommentData,
): Promise<Error | undefined> {
  // Our own echo. The only thing stopping an endless reply loop.
  if (data.authoredByUs) return undefined;

  const taken = await takeLinearImplementerByPullRequest(engine, data);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'li_pending':
      case 'li_implementing':
      case 'li_verifying':
        return undefined;

      // The pull request is PrMaintainer's from here, so a comment on it is not
      // ours to act on.
      case 'li_waiting_pr':
        return undefined;

      case 'li_needs_human':
        return resumeWithFreshBudget(engine, instance);

      // The ticket already ended; a late event about it changes nothing.
      case 'li_done':
      case 'li_abandoned':
      case 'li_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

export async function onPrMerged(
  engine: LinearImplementerStateEngine,
  ref: PullRequestRef,
): Promise<Error | undefined> {
  const taken = await takeLinearImplementerByPullRequest(engine, ref);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'li_pending':
      case 'li_implementing':
      case 'li_verifying':
      case 'li_needs_human':
      case 'li_waiting_pr':
        return setState(engine, instance, 'li_done');

      // The ticket already ended; a late event about it changes nothing.
      case 'li_done':
      case 'li_abandoned':
      case 'li_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

export async function onPrClosed(
  engine: LinearImplementerStateEngine,
  ref: PullRequestRef,
): Promise<Error | undefined> {
  const taken = await takeLinearImplementerByPullRequest(engine, ref);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'li_pending':
      case 'li_implementing':
      case 'li_verifying':
      case 'li_needs_human':
      case 'li_waiting_pr':
        return setState(engine, instance, 'li_abandoned');

      // The ticket already ended; a late event about it changes nothing.
      case 'li_done':
      case 'li_abandoned':
      case 'li_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

export async function onSandboxRunSucceeded(
  engine: LinearImplementerStateEngine,
  sandboxRunId: string,
  outcome: RunOutcome,
): Promise<Error | undefined> {
  const taken = await takeLinearImplementerBySandboxRun(engine, sandboxRunId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'li_implementing':
        instance.sandboxRunId = null;
        instance.linearSessionId = outcome.linearSessionId ?? instance.linearSessionId;
        // A pass that ends without a pull request produced nothing to verify,
        // and the agent is the only one who knows why.
        if (!outcome.pullRequestNumber) {
          instance.needsHumanReason = 'no_pull_request';
          return setState(engine, instance, 'li_needs_human');
        }
        instance.pullRequestNumber = outcome.pullRequestNumber;
        instance.needsHumanReason = null;
        return setStateAndRun(engine, instance, 'li_verifying');

      case 'li_verifying':
        instance.sandboxRunId = null;
        return await processVerdict(engine, instance, outcome);

      default:
        // An outcome that arrives in any other state is stale.
        return undefined;
    }
  } finally {
    taken.lock.release();
  }
}

export async function onSandboxRunFailed(
  engine: LinearImplementerStateEngine,
  sandboxRunId: string,
): Promise<Error | undefined> {
  const taken = await takeLinearImplementerBySandboxRun(engine, sandboxRunId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'li_implementing':
      case 'li_verifying':
        instance.sandboxRunId = null;
        instance.iterationNumber += 1;
        return setStateAndRun(engine, instance, instance.workflowState);

      default:
        return undefined;
    }
  } finally {
    taken.lock.release();
  }
}

// onOperatorRetryVerification re-judges what the last pass already pushed, for when the
// verification is what failed and the implementation has nothing left to do.
export async function onOperatorRetryVerification(
  engine: LinearImplementerStateEngine,
  linearImplementerId: string,
): Promise<Error | undefined> {
  const taken = await takeLinearImplementerById(engine, linearImplementerId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      // Judge only once a pass opened a pull request; before that there is nothing to read.
      case 'li_needs_human':
        if (instance.pullRequestNumber === null) return undefined;
        instance.iterationNumber = 0;
        instance.needsHumanReason = null;
        return setStateAndRun(engine, instance, 'li_verifying');

      case 'li_pending':
      case 'li_implementing':
      case 'li_verifying':
      case 'li_waiting_pr':
      case 'li_done':
      case 'li_abandoned':
      case 'li_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

export async function onOperatorRetry(
  engine: LinearImplementerStateEngine,
  linearImplementerId: string,
): Promise<Error | undefined> {
  const taken = await takeLinearImplementerById(engine, linearImplementerId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'li_needs_human':
        return resumeWithFreshBudget(engine, instance);

      // Nothing to retry: the work is either owed, in flight, or finished.
      case 'li_pending':
      case 'li_implementing':
      case 'li_verifying':
      case 'li_waiting_pr':
        return undefined;

      // The ticket already ended; a late event about it changes nothing.
      case 'li_done':
      case 'li_abandoned':
      case 'li_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

// onOperatorDismiss is the other answer to a ticket parked on a person: they read it and
// stopped it, so the instance ends here instead of going back to work.
export async function onOperatorDismiss(
  engine: LinearImplementerStateEngine,
  linearImplementerId: string,
): Promise<Error | undefined> {
  const taken = await takeLinearImplementerById(engine, linearImplementerId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'li_needs_human':
        instance.needsHumanReason = null;
        return setState(engine, instance, 'li_dismissed');

      // Only what stopped for a person is theirs to dismiss; the rest is in flight or
      // already ended.
      case 'li_pending':
      case 'li_implementing':
      case 'li_verifying':
      case 'li_waiting_pr':
      case 'li_done':
      case 'li_abandoned':
      case 'li_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

// onPeriodicCheck is one tick of the clock. The clock knows no cadences: each state
// decides whether enough time has passed to look again.
export async function onPeriodicCheck(
  engine: LinearImplementerStateEngine,
  linearImplementerId: string,
): Promise<Error | undefined> {
  const taken = await takeLinearImplementerById(engine, linearImplementerId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    const wait = engine.config.checkWaitMs[instance.workflowState];
    // A state left out of the map is never looked at, on purpose.
    if (wait === undefined) return undefined;
    if (Date.now() - (instance.lastStateCheckedAt ?? 0) < wait) return undefined;
    engine.store.markLinearImplementerChecked(instance.id);

    switch (instance.workflowState) {
      case 'li_pending':
        // The dispatch never happened: the pool was full or paused, or whoever
        // held the work lock died holding it.
        return runLinearImplementerFSM(engine, instance);

      case 'li_implementing':
      case 'li_verifying':
        return processSandboxRunWhileWorking(engine, instance);

      case 'li_waiting_pr': {
        const snapshot = await readPullRequestWhileWaiting(engine, instance);
        if (snapshot?.state === 'merged') return setState(engine, instance, 'li_done');
        if (snapshot?.state === 'closed') return setState(engine, instance, 'li_abandoned');
        return undefined;
      }

      // The ticket already ended; a late event about it changes nothing.
      case 'li_done':
      case 'li_abandoned':
      case 'li_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

export async function onSystemRecovery(
  engine: LinearImplementerStateEngine,
  linearImplementerId: string,
): Promise<Error | undefined> {
  const taken = await takeLinearImplementerById(engine, linearImplementerId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'li_pending':
        return runLinearImplementerFSM(engine, instance);

      case 'li_implementing':
      case 'li_verifying':
        return processSandboxRunWhileWorking(engine, instance);

      case 'li_needs_human':
      case 'li_waiting_pr':
        // Nothing was in flight, so the next event moves it.
        return undefined;

      // The ticket already ended; a late event about it changes nothing.
      case 'li_done':
      case 'li_abandoned':
      case 'li_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

async function processVerdict(
  engine: LinearImplementerStateEngine,
  instance: LinearImplementer,
  outcome: RunOutcome,
): Promise<Error | undefined> {
  // A pass that left no verdict could be an error, so we need to increment the iteration and try again rather than treat it as a rejection.
  if (outcome.hasVerdict === false || !outcome.verdict) {
    instance.iterationNumber += 1;
    return setStateAndRun(engine, instance, 'li_verifying');
  }

  instance.verifierVerdict = outcome.verdict;
  instance.verifiedCommitSha = outcome.verifiedCommitSha ?? instance.verifiedCommitSha;
  instance.verifierIssues = outcome.verifierIssues ?? null;

  if (outcome.verdict === 'accept') {
    // The pull request was opened as a draft so nobody would review half of it.
    // Accepting it is what makes it reviewable, so it is released here and not by
    // the agent, which cannot be trusted to have done it.
    const releaseError = await releasePullRequest(engine, instance);
    if (releaseError) {
      instance.needsHumanReason = 'release_failed';
      return setState(engine, instance, 'li_needs_human');
    }
    instance.needsHumanReason = null;
    return setStateAndRun(engine, instance, 'li_waiting_pr');
  }

  // The rejection texts are the input of the corrective pass, which is why they
  // are stored rather than only reported.
  instance.iterationNumber += 1;
  return setStateAndRun(engine, instance, 'li_implementing');
}

// processSandboxRunWhileWorking finds out what became of the run. It may have finished
// without anyone telling us, or died with the process, and each ends somewhere
// different.
function processSandboxRunWhileWorking(
  engine: LinearImplementerStateEngine,
  instance: LinearImplementer,
): Error | undefined {
  const sandboxRun = instance.sandboxRunId
    ? engine.store.getSandboxRun(instance.sandboxRunId)
    : undefined;

  switch (sandboxRun?.runState) {
    // No run at all, which is how a dispatch the pool refused reads. Nothing ran,
    // so this is not a failure to hand to a person: it is a dispatch owed.
    case undefined:
      instance.sandboxRunId = null;
      return setStateAndRun(engine, instance, instance.workflowState);

    case 'pending':
    case 'running':
      // The row outlives a process crash and the pool does not, so the pool is
      // the only thing that knows whether the sandbox is still alive.
      if (engine.pool.isExecuting(sandboxRun.id)) return undefined;
      engine.store.finishSandboxRun(sandboxRun.id, { runState: 'orphaned' });
      instance.sandboxRunId = null;
      // Dispatching again is safe: the agent works from the branch, not from
      // whatever the dead sandbox held in memory.
      instance.iterationNumber += 1;
      return setStateAndRun(engine, instance, instance.workflowState);

    case 'succeeded':
      // The pool closes the run row before it hands the outcome over, so a run it still
      // holds is one whose outcome is on its way.
      if (engine.pool.isExecuting(sandboxRun.id)) return undefined;
      // Whoever reports the outcome carries the verdict, and this path only
      // exists because nobody did, so there is nothing to judge on.
      instance.sandboxRunId = null;
      instance.needsHumanReason = 'outcome_lost';
      return setState(engine, instance, 'li_needs_human');

    // Failed or aborted, and nobody reported it, which is what a restart mid-run leaves
    // behind. It costs an iteration like any lost run and the handler decides from there.
    default:
      instance.sandboxRunId = null;
      instance.iterationNumber += 1;
      return setStateAndRun(engine, instance, instance.workflowState);
  }
}

// resumeWithFreshBudget clears the reason and the budget, because a person asking again
// would otherwise walk straight back into the state it left.
function resumeWithFreshBudget(
  engine: LinearImplementerStateEngine,
  instance: LinearImplementer,
): Error | undefined {
  instance.iterationNumber = 0;
  instance.needsHumanReason = null;
  return setStateAndRun(engine, instance, 'li_implementing');
}

// releasePullRequest marks the verified draft ready for review, which is the ticket
// leaving our hands.
async function releasePullRequest(
  engine: LinearImplementerStateEngine,
  instance: LinearImplementer,
): Promise<Error | undefined> {
  if (!instance.pullRequestNumber) return new Error('no pull request to release');
  const repository = engine.store.getRepositoryById(instance.repositoryId);
  if (!repository) return new Error(`repository ${instance.repositoryId} is gone`);
  return engine.github.markReadyForReview(repository.fullName, instance.pullRequestNumber);
}

// readPullRequestWhileWaiting reads how the ticket's pull request stands, for when the
// webhook never arrived.
async function readPullRequestWhileWaiting(
  engine: LinearImplementerStateEngine,
  instance: LinearImplementer,
): Promise<PullRequestSnapshot | undefined> {
  const repository = engine.store.getRepositoryById(instance.repositoryId);
  if (!repository || !instance.pullRequestNumber) return undefined;
  return engine.github.readPullRequest(repository.fullName, instance.pullRequestNumber);
}

function setStateAndRun(
  engine: LinearImplementerStateEngine,
  instance: LinearImplementer,
  state: LinearImplementer['workflowState'],
): Error | undefined {
  const writeError = setState(engine, instance, state);
  if (writeError) return writeError;
  return runLinearImplementerFSM(engine, instance);
}

// createOrTakeLinearImplementer returns the instance locked, whatever its state, the
// same as CreateOrTakePurchaseTransaction in MCA. What an ending means is decided by
// each event's switch.
async function createOrTakeLinearImplementer(
  engine: LinearImplementerStateEngine,
  ref: IssueRef,
  options: { create: boolean; requestRouterId?: string },
): Promise<TakenLinearImplementer | undefined> {
  // Locking by ticket and not by instance id: the instance may not exist yet,
  // and two events arriving together must not create two of them.
  const lock = await engine.locker.acquire(linearImplementerLockKey(ref.linearIssueId));
  if (!lock) return undefined;
  // Taken whatever its state, so an ending is something the switch decides on
  // rather than something that looks like a ticket never seen before.
  let instance = engine.store.findLinearImplementerByIssue(ref.linearIssueId);
  if (!instance) {
    // A ticket nobody delegated to us is not our business.
    if (!options.create) {
      lock.release();
      return undefined;
    }
    instance = engine.store.openLinearImplementer({
      repositoryId: ref.repositoryId,
      linearIssueId: ref.linearIssueId,
      linearIssueIdentifier: ref.linearIssueIdentifier,
      linearSessionId: ref.linearSessionId,
      promptContext: ref.promptContext,
      requestRouterId: options.requestRouterId,
    });
    recordWorkflowInstanceOpened(engine.store, 'linear_implementer', instance, {
      linear_issue_identifier: instance.linearIssueIdentifier,
      linear_session_id: instance.linearSessionId,
    });
  }
  return { instance, lock };
}

async function takeLinearImplementerById(
  engine: LinearImplementerStateEngine,
  linearImplementerId: string,
): Promise<TakenLinearImplementer | undefined> {
  const known = engine.store.getLinearImplementer(linearImplementerId);
  if (!known) return undefined;
  const lock = await engine.locker.acquire(linearImplementerLockKey(known.linearIssueId));
  if (!lock) return undefined;
  // Read again under the lock: whoever held it before may have moved the state.
  const instance = engine.store.getLinearImplementer(linearImplementerId);
  if (!instance) {
    lock.release();
    return undefined;
  }
  return { instance, lock };
}

// takeLinearImplementerByPullRequest finds the ticket a pull request belongs to, which
// only holds while the instance is still following it.
async function takeLinearImplementerByPullRequest(
  engine: LinearImplementerStateEngine,
  ref: PullRequestRef,
): Promise<TakenLinearImplementer | undefined> {
  const match = engine.store
    .listOpenLinearImplementers()
    .find(
      (candidate) =>
        candidate.repositoryId === ref.repositoryId &&
        candidate.pullRequestNumber === ref.pullRequestNumber,
    );
  if (!match) return undefined;
  return takeLinearImplementerById(engine, match.id);
}

async function takeLinearImplementerBySandboxRun(
  engine: LinearImplementerStateEngine,
  sandboxRunId: string,
): Promise<TakenLinearImplementer | undefined> {
  const sandboxRun = engine.store.getSandboxRun(sandboxRunId);
  if (sandboxRun?.workflowType !== 'linear_implementer') return undefined;
  const taken = await takeLinearImplementerById(engine, sandboxRun.workflowInstanceId);
  if (!taken) return undefined;
  // An outcome for a sandbox run the instance is no longer waiting on is stale.
  if (taken.instance.sandboxRunId !== sandboxRunId) {
    taken.lock.release();
    return undefined;
  }
  return taken;
}

// linearImplementerLockKey is taken by every entry point, so two events for one ticket
// are handled one after the other.
function linearImplementerLockKey(linearIssueId: string): string {
  return `linear_implementer:${linearIssueId}`;
}
