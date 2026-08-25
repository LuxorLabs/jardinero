import { recordWorkflowInstanceOpened } from '../execution.js';
import type { FixImplementerTargetScope } from '../../../store/store.js';
import type { FixImplementer } from '../../../store/types.js';
import { objectValue } from '../../../platform/json.js';
import { problemSignatureOf } from '../../../workflows/pr/implementation-handoff.js';
import {
  type ExistingImplementationPr,
  isSameProblem,
  type ProblemSignature,
} from '../../../workflows/pr/implementation-pr-dedup.js';
import type { Lock } from '../execution.js';
import { runFixImplementerFSM, setState, UnsupportedStateError } from './engine.js';
import type { PullRequestSnapshot } from '../pr-maintainer/service.js';
import type { FixImplementerStateEngine } from './service.js';

export interface Finding {
  repositoryId: string;
  findingFingerprint: string;
  serviceName?: string;
  environmentName?: string;
  findingEvidence?: string;
}

export interface PullRequestRef {
  repositoryId: string;
  pullRequestNumber: number;
}

// RunOutcome is what the agent reported. A pass that opened no pull request has to say
// why: unless it refused the finding, nothing changed and the finding is still open.
export interface RunOutcome {
  pullRequestNumber?: number;
  discardReason?: string;
}

interface TakenFixImplementer {
  instance: FixImplementer;
  lock: Lock;
}

// onFindingReported is a scan reporting a finding. The fingerprint is the identity, so
// the same error found twice is one finding.
export async function onFindingReported(
  engine: FixImplementerStateEngine,
  finding: Finding,
  logReviewerId?: string,
): Promise<Error | undefined> {
  const lock = await engine.locker.acquire(fixImplementerLockKey(finding.findingFingerprint));
  if (!lock) return undefined;
  // Taken whatever its state, so an ending is something the switch decides on
  // rather than something that looks like a finding never seen before.
  let instance = engine.store.findFixImplementerByFingerprint(finding.findingFingerprint);
  if (!instance) {
    // Coverage is read across fingerprints, so two scans wording one problem differently
    // hold different fingerprints and would both find nothing and both open. Unlike the
    // fingerprint, a target we cannot take is not worth dropping the finding over.
    const targetLock = await engine.locker.acquire(fixImplementerTargetLockKey(finding));
    try {
      const coverage = await coveredElsewhere(engine, finding);
      if (coverage) {
        recordCoveredFinding(engine, finding, coverage);
        lock.release();
        return undefined;
      }
      instance = engine.store.openFixImplementer({
        repositoryId: finding.repositoryId,
        findingFingerprint: finding.findingFingerprint,
        serviceName: finding.serviceName,
        environmentName: finding.environmentName,
        findingEvidence: finding.findingEvidence,
        logReviewerId,
      });
      recordWorkflowInstanceOpened(engine.store, 'fix_implementer', instance, {
        finding_fingerprint: instance.findingFingerprint,
        service_name: instance.serviceName,
        environment_name: instance.environmentName,
      });
    } finally {
      targetLock?.release();
    }
  }
  try {
    switch (instance.workflowState) {
      // The state an instance is born in, so this covers both a new finding and
      // one whose dispatch is still owed.
      case 'fi_pending':
        return runFixImplementerFSM(engine, instance);

      // Already being worked, and seeing the same error again is not new work.
      case 'fi_implementing':
      case 'fi_verifying':
      case 'fi_needs_human':
      case 'fi_waiting_pr':
        return undefined;

      // The error is still out there and a discard may have been a false negative, so
      // the agent refusing the finding once does not settle it.
      case 'fi_discarded':
        instance.discardReason = null;
        instance.needsHumanReason = null;
        return setStateAndRun(engine, instance, 'fi_implementing');

      // Closing our pull request without merging it is the only way a person has to
      // say no. Reporting the same error again does not overrule them.
      case 'fi_abandoned':
        recordCoveredFinding(engine, finding, { reason: 'human_rejected_prior_pr', instance });
        return undefined;

      // Already fixed and merged, so seeing it again is a different error.
      case 'fi_done':
      case 'fi_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    lock.release();
  }
}

export async function onSandboxRunSucceeded(
  engine: FixImplementerStateEngine,
  sandboxRunId: string,
  outcome: RunOutcome,
): Promise<Error | undefined> {
  const taken = await takeFixImplementerBySandboxRun(engine, sandboxRunId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'fi_implementing': {
        instance.sandboxRunId = null;
        // No pull request and a reason is the agent refusing the finding, which
        // is an outcome and not a failure.
        if (!outcome.pullRequestNumber) {
          instance.discardReason = outcome.discardReason ?? 'no_reason_given';
          return setState(engine, instance, 'fi_discarded');
        }
        instance.pullRequestNumber = outcome.pullRequestNumber;
        instance.needsHumanReason = null;
        return setStateAndRun(engine, instance, 'fi_verifying');
      }

      default:
        // An outcome that arrives in any other state is stale.
        return undefined;
    }
  } finally {
    taken.lock.release();
  }
}

export async function onSandboxRunFailed(
  engine: FixImplementerStateEngine,
  sandboxRunId: string,
): Promise<Error | undefined> {
  const taken = await takeFixImplementerBySandboxRun(engine, sandboxRunId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'fi_implementing':
        instance.sandboxRunId = null;
        return setStateAndRun(engine, instance, instance.workflowState);

      default:
        return undefined;
    }
  } finally {
    taken.lock.release();
  }
}

export async function onPrMerged(
  engine: FixImplementerStateEngine,
  ref: PullRequestRef,
): Promise<Error | undefined> {
  const taken = await takeFixImplementerByPullRequest(engine, ref);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'fi_pending':
      case 'fi_implementing':
      case 'fi_verifying':
      case 'fi_needs_human':
      case 'fi_waiting_pr':
        return setState(engine, instance, 'fi_done');

      // The finding already ended; a late event about it changes nothing.
      case 'fi_discarded':
      case 'fi_done':
      case 'fi_abandoned':
      case 'fi_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

export async function onPrClosed(
  engine: FixImplementerStateEngine,
  ref: PullRequestRef,
): Promise<Error | undefined> {
  const taken = await takeFixImplementerByPullRequest(engine, ref);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'fi_pending':
      case 'fi_implementing':
      case 'fi_verifying':
      case 'fi_needs_human':
      case 'fi_waiting_pr':
        // A person closing our fix without merging it is the answer, and it is
        // why there is no separate rejected-pull-request record.
        return setState(engine, instance, 'fi_abandoned');

      // The finding already ended; a late event about it changes nothing.
      case 'fi_discarded':
      case 'fi_done':
      case 'fi_abandoned':
      case 'fi_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

export async function onOperatorRetry(
  engine: FixImplementerStateEngine,
  fixImplementerId: string,
): Promise<Error | undefined> {
  const taken = await takeFixImplementerById(engine, fixImplementerId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'fi_needs_human':
        instance.needsHumanReason = null;
        return setStateAndRun(engine, instance, 'fi_implementing');

      // A person closed our pull request and this is an operator overruling that.
      case 'fi_abandoned':
        instance.needsHumanReason = null;
        return setStateAndRun(engine, instance, 'fi_implementing');

      // Nothing to retry: the work is either owed, in flight, or finished.
      case 'fi_pending':
      case 'fi_implementing':
      case 'fi_verifying':
      case 'fi_waiting_pr':
        return undefined;

      // The finding already ended; a late event about it changes nothing.
      case 'fi_discarded':
      case 'fi_done':
      case 'fi_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

// onOperatorDismiss is the other answer to a finding parked on a person: they read it and
// stopped it, so the instance ends here instead of going back to work.
export async function onOperatorDismiss(
  engine: FixImplementerStateEngine,
  fixImplementerId: string,
): Promise<Error | undefined> {
  const taken = await takeFixImplementerById(engine, fixImplementerId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'fi_needs_human':
        instance.needsHumanReason = null;
        return setState(engine, instance, 'fi_dismissed');

      // Only what stopped for a person is theirs to dismiss; the rest is in flight or
      // already ended.
      case 'fi_pending':
      case 'fi_implementing':
      case 'fi_verifying':
      case 'fi_waiting_pr':
      case 'fi_discarded':
      case 'fi_done':
      case 'fi_abandoned':
      case 'fi_dismissed':
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
  engine: FixImplementerStateEngine,
  fixImplementerId: string,
): Promise<Error | undefined> {
  const taken = await takeFixImplementerById(engine, fixImplementerId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    const wait = engine.config.checkWaitMs[instance.workflowState];
    // A state left out of the map is never looked at, on purpose.
    if (wait === undefined) return undefined;
    if (Date.now() - (instance.lastStateCheckedAt ?? 0) < wait) return undefined;
    engine.store.markFixImplementerChecked(instance.id);

    switch (instance.workflowState) {
      case 'fi_pending':
        // The transition never happened: the pool was full or paused, or
        // whoever held the work lock died holding it.
        return runFixImplementerFSM(engine, instance);

      case 'fi_implementing':
        return processSandboxRunWhileWorking(engine, instance);

      // Marks the draft ready for review; if GitHub fails, the next tick retries.
      case 'fi_verifying': {
        const releaseError = await releasePullRequest(engine, instance);
        if (releaseError) return releaseError;
        return setStateAndRun(engine, instance, 'fi_waiting_pr');
      }

      case 'fi_waiting_pr': {
        const snapshot = await readPullRequestWhileWaiting(engine, instance);
        if (snapshot?.state === 'merged') return setState(engine, instance, 'fi_done');
        if (snapshot?.state === 'closed') return setState(engine, instance, 'fi_abandoned');
        return undefined;
      }

      // The finding already ended; a late event about it changes nothing.
      case 'fi_discarded':
      case 'fi_done':
      case 'fi_abandoned':
      case 'fi_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

export async function onSystemRecovery(
  engine: FixImplementerStateEngine,
  fixImplementerId: string,
): Promise<Error | undefined> {
  const taken = await takeFixImplementerById(engine, fixImplementerId);
  if (!taken) return undefined;
  const instance = taken.instance;
  try {
    switch (instance.workflowState) {
      case 'fi_pending':
        return runFixImplementerFSM(engine, instance);

      case 'fi_implementing':
        return processSandboxRunWhileWorking(engine, instance);

      case 'fi_verifying':
      case 'fi_waiting_pr':
      case 'fi_needs_human':
        // Nothing was in flight, so the next event or the next tick moves it.
        return undefined;

      // The finding already ended; a late event about it changes nothing.
      case 'fi_discarded':
      case 'fi_done':
      case 'fi_abandoned':
      case 'fi_dismissed':
        return undefined;

      default:
        return new UnsupportedStateError(instance.workflowState);
    }
  } finally {
    taken.lock.release();
  }
}

// processSandboxRunWhileWorking finds out what became of the run. It may have finished
// without anyone telling us, or died with the process, and each ends somewhere
// different.
function processSandboxRunWhileWorking(
  engine: FixImplementerStateEngine,
  instance: FixImplementer,
): Error | undefined {
  const sandboxRun = instance.sandboxRunId
    ? engine.store.getSandboxRun(instance.sandboxRunId)
    : undefined;

  switch (sandboxRun?.runState) {
    // No run at all, which is how a dispatch the pool refused reads. Nothing ran,
    // so this is not a failure to hand to a person: it is a dispatch owed.
    case undefined:
      instance.sandboxRunId = null;
      return setStateAndRun(engine, instance, 'fi_implementing');

    case 'pending':
    case 'running':
      // The row outlives a process crash and the pool does not, so the pool is
      // the only thing that knows whether the sandbox is still alive.
      if (engine.pool.isExecuting(sandboxRun.id)) return undefined;
      engine.store.finishSandboxRun(sandboxRun.id, { runState: 'orphaned' });
      instance.sandboxRunId = null;
      return setStateAndRun(engine, instance, 'fi_implementing');

    case 'succeeded':
      // The pool closes the run row before it hands the outcome over, so a run it still
      // holds is one whose outcome is on its way.
      if (engine.pool.isExecuting(sandboxRun.id)) return undefined;
      // Whoever reports the outcome carries the pull request number, and this
      // path only exists because nobody did.
      instance.sandboxRunId = null;
      instance.needsHumanReason = 'outcome_lost';
      return setState(engine, instance, 'fi_needs_human');

    default:
      instance.sandboxRunId = null;
      instance.needsHumanReason = 'run_failed';
      return setState(engine, instance, 'fi_needs_human');
  }
}

function setStateAndRun(
  engine: FixImplementerStateEngine,
  instance: FixImplementer,
  state: FixImplementer['workflowState'],
): Error | undefined {
  const writeError = setState(engine, instance, state);
  if (writeError) return writeError;
  return runFixImplementerFSM(engine, instance);
}

async function takeFixImplementerById(
  engine: FixImplementerStateEngine,
  fixImplementerId: string,
): Promise<TakenFixImplementer | undefined> {
  const known = engine.store.getFixImplementer(fixImplementerId);
  if (!known) return undefined;
  const lock = await engine.locker.acquire(fixImplementerLockKey(known.findingFingerprint));
  if (!lock) return undefined;
  // Read again under the lock: whoever held it before may have moved the state.
  const instance = engine.store.getFixImplementer(fixImplementerId);
  if (!instance) {
    lock.release();
    return undefined;
  }
  return { instance, lock };
}

// takeFixImplementerByPullRequest finds the finding a pull request belongs to, which
// only holds while the instance is still following it.
async function takeFixImplementerByPullRequest(
  engine: FixImplementerStateEngine,
  ref: PullRequestRef,
): Promise<TakenFixImplementer | undefined> {
  const match = engine.store
    .listOpenFixImplementers()
    .find(
      (candidate) =>
        candidate.repositoryId === ref.repositoryId &&
        candidate.pullRequestNumber === ref.pullRequestNumber,
    );
  if (!match) return undefined;
  return takeFixImplementerById(engine, match.id);
}

async function takeFixImplementerBySandboxRun(
  engine: FixImplementerStateEngine,
  sandboxRunId: string,
): Promise<TakenFixImplementer | undefined> {
  const sandboxRun = engine.store.getSandboxRun(sandboxRunId);
  if (sandboxRun?.workflowType !== 'fix_implementer') return undefined;
  const taken = await takeFixImplementerById(engine, sandboxRun.workflowInstanceId);
  if (!taken) return undefined;
  // An outcome for a sandbox run the instance is no longer waiting on is stale.
  if (taken.instance.sandboxRunId !== sandboxRunId) {
    taken.lock.release();
    return undefined;
  }
  return taken;
}

// releasePullRequest marks the draft ready for review, which is the fix leaving our hands.
async function releasePullRequest(
  engine: FixImplementerStateEngine,
  instance: FixImplementer,
): Promise<Error | undefined> {
  if (!instance.pullRequestNumber) return new Error('no pull request to release');
  const repository = engine.store.getRepositoryById(instance.repositoryId);
  if (!repository) return new Error(`repository ${instance.repositoryId} is gone`);
  return engine.github.markReadyForReview(repository.fullName, instance.pullRequestNumber);
}

// readPullRequestWhileWaiting reads how the fix's pull request stands, since no webhook
// reaches this machine.
async function readPullRequestWhileWaiting(
  engine: FixImplementerStateEngine,
  instance: FixImplementer,
): Promise<PullRequestSnapshot | undefined> {
  const repository = engine.store.getRepositoryById(instance.repositoryId);
  if (!repository || !instance.pullRequestNumber) return undefined;
  return engine.github.readPullRequest(repository.fullName, instance.pullRequestNumber);
}

interface Coverage {
  reason: 'human_rejected_prior_pr' | 'same_problem_in_flight' | 'existing_open_pr';
  instance?: FixImplementer;
  pullRequest?: ExistingImplementationPr;
}

// The agent writes the fingerprint anew on every scan, so a fingerprint never seen
// before is no proof of a problem never worked; the evidence is what tells them apart.
async function coveredElsewhere(
  engine: FixImplementerStateEngine,
  finding: Finding,
): Promise<Coverage | undefined> {
  const signature = signatureOf(finding.findingEvidence);
  if (!signature) return undefined;
  const scope: FixImplementerTargetScope = {
    repositoryId: finding.repositoryId,
    serviceName: finding.serviceName,
    environmentName: finding.environmentName,
  };

  // A person's answer outranks work in flight, so the refusals are read first.
  const refused = sameProblemAmong(engine.store.listAbandonedFixImplementers(scope), signature);
  if (refused) return { reason: 'human_rejected_prior_pr', instance: refused };

  const inFlight = sameProblemAmong(
    engine.store.listOpenFixImplementersForTarget(scope),
    signature,
  );
  if (inFlight) return { reason: 'same_problem_in_flight', instance: inFlight };

  const pullRequest = await openPullRequestCovering(engine, finding, signature);
  return pullRequest ? { reason: 'existing_open_pr', pullRequest } : undefined;
}

function sameProblemAmong(
  candidates: FixImplementer[],
  signature: ProblemSignature,
): FixImplementer | undefined {
  return candidates.find((candidate) => {
    const covered = signatureOf(candidate.findingEvidence);
    return covered !== undefined && isSameProblem(signature, covered);
  });
}

// The instance that opened a pull request may have ended, or never have reached this
// database, so an open one still answers the finding.
async function openPullRequestCovering(
  engine: FixImplementerStateEngine,
  finding: Finding,
  signature: ProblemSignature,
): Promise<ExistingImplementationPr | undefined> {
  const repository = engine.store.getRepositoryById(finding.repositoryId);
  if (!repository) return undefined;
  return engine.github.findOpenImplementationPullRequest(repository.fullName, signature);
}

// signatureOf reads what identifies a finding's problem out of its evidence, or nothing
// when the agent left none this can be read from.
function signatureOf(findingEvidence: string | null | undefined) {
  if (!findingEvidence) return undefined;
  try {
    const raw = objectValue(JSON.parse(findingEvidence) as unknown);
    return raw ? problemSignatureOf(raw) : undefined;
  } catch {
    return undefined;
  }
}

// A person saying no is kept apart from the system coalescing duplicates, so an operator
// reading the refusals is not handed the deduplication too.
function recordCoveredFinding(
  engine: FixImplementerStateEngine,
  finding: Finding,
  coverage: Coverage,
): void {
  engine.store.appendEvent({
    eventType:
      coverage.reason === 'human_rejected_prior_pr'
        ? 'workflow.finding_refused'
        : 'workflow.finding_deduplicated',
    workflowType: 'fix_implementer',
    workflowInstanceId: coverage.instance?.id,
    repositoryId: finding.repositoryId,
    metadata: {
      reason: coverage.reason,
      finding_fingerprint: finding.findingFingerprint,
      covered_by_fingerprint: coverage.instance?.findingFingerprint,
      // Undefined, so covering work that opened no pull request leaves the key out.
      covered_by_pull_request_number:
        coverage.pullRequest?.number ?? coverage.instance?.pullRequestNumber ?? undefined,
      // A wrong match withholds a fix silently, so what it matched on has to be readable.
      covered_by_matched_tokens: coverage.pullRequest?.matchedTokens,
    },
  });
}

// fixImplementerLockKey is taken by every entry point, so two events for one finding
// are handled one after the other.
function fixImplementerLockKey(findingFingerprint: string): string {
  return `fix_implementer:${findingFingerprint}`;
}

// Only the open path takes this one. Keying every entry point on the target instead
// would serialize findings that have nothing to do with each other.
function fixImplementerTargetLockKey(finding: Finding): string {
  return `fix_implementer_target:${finding.repositoryId}:${finding.serviceName ?? ''}:${finding.environmentName ?? ''}`;
}
