import type { WorkAnnouncer } from '../orchestrator/work-announcer.js';
import type { GitHubImplementationPrReader } from '../orchestrator/state-machines/fix-implementer/service.js';
import type { Lock, Locker, SandboxPool } from '../orchestrator/state-machines/execution.js';
import type { GitHubWriter } from '../orchestrator/state-machines/linear-implementer/service.js';
import type {
  GitHubCommentWriter,
  GitHubReader,
  PickedUpComment,
  PullRequestSnapshot,
} from '../orchestrator/state-machines/pr-maintainer/service.js';
import type { ExistingImplementationPr } from '../workflows/pr/implementation-pr-dedup.js';
import type {
  PeriodicallyCheckedWorkflow,
  WorkflowEngines,
} from '../orchestrator/workflow-engines.js';
import type { Store } from '../store/store.js';
import type {
  FixImplementerState,
  LinearImplementerState,
  LogReviewerState,
  PrMaintainerState,
  RequestRouterState,
} from '../store/types.js';

// Records what the machine asked of the pool, and lets a test say which runs the
// pool still holds. Typed to the real interface so a widened signature cannot
// let a test assert a payload the system never produces.
export class FakeSandboxPool implements SandboxPool {
  readonly started: string[] = [];
  readonly aborted: string[] = [];
  // Set by a test to stand in for the concurrency caps being full.
  refuseToStart = false;
  // Set by a test to stand in for the caps being full before a run row is created.
  refuseRoom = false;
  private readonly executing = new Set<string>();

  hasRoomFor(): boolean {
    return !this.refuseRoom;
  }

  startSandbox(sandboxRunId: string): boolean {
    if (this.refuseToStart) return false;
    this.started.push(sandboxRunId);
    this.executing.add(sandboxRunId);
    return true;
  }

  isExecuting(sandboxRunId: string): boolean {
    return this.executing.has(sandboxRunId);
  }

  abort(sandboxRunId: string): void {
    this.aborted.push(sandboxRunId);
    this.executing.delete(sandboxRunId);
  }

  // Stands in for the sandbox dying with the process: the run row survives and
  // the pool does not.
  loseFromPool(sandboxRunId: string): void {
    this.executing.delete(sandboxRunId);
  }
}

// Single process, so the real locker is an in-memory mutex too. This one only
// records, which is enough to prove every entry point takes and releases.
export class FakeLocker implements Locker {
  readonly acquired: string[] = [];
  readonly released: string[] = [];

  // Set by a test to stand in for a wait that ran out, for every resource or for one.
  refuseToLock = false;
  refusedResourceId: string | undefined;

  acquire(resourceId: string): Promise<Lock | undefined> {
    if (this.refuseToLock || this.refusedResourceId === resourceId)
      return Promise.resolve(undefined);
    this.acquired.push(resourceId);
    return Promise.resolve({
      release: () => {
        this.released.push(resourceId);
      },
    });
  }

  // Every entry point has to hand back what it took, whatever it decided.
  get isBalanced(): boolean {
    return this.acquired.length === this.released.length;
  }
}

// Answers what the machines read of a pull request and records what they wrote on it,
// and lets a test refuse a write. Typed to the real seams so it cannot answer more.
export class FakeGitHub
  implements GitHubReader, GitHubWriter, GitHubImplementationPrReader, GitHubCommentWriter
{
  readonly reads: Array<{ repositoryFullName: string; pullRequestNumber: number }> = [];
  readonly released: number[] = [];
  readonly implementationPrLookups: string[] = [];
  readonly pickedUp: Array<{ repositoryFullName: string } & PickedUpComment> = [];
  refusal: Error | undefined;
  readFailure: Error | undefined;
  pickupRefusal: Error | undefined;
  // Set by a test to stand in for an open pull request that already covers the problem.
  openImplementationPr: ExistingImplementationPr | undefined;
  snapshot: PullRequestSnapshot = {
    state: 'open',
    headCommitSha: 'sha-head',
    checksAreRed: false,
    hasUnresolvedReviewThreads: false,
  };

  readPullRequest(
    repositoryFullName: string,
    pullRequestNumber: number,
  ): Promise<PullRequestSnapshot> {
    this.reads.push({ repositoryFullName, pullRequestNumber });
    if (this.readFailure) return Promise.reject(this.readFailure);
    return Promise.resolve(this.snapshot);
  }

  markReadyForReview(
    _repositoryFullName: string,
    pullRequestNumber: number,
  ): Promise<Error | undefined> {
    if (this.refusal) return Promise.resolve(this.refusal);
    this.released.push(pullRequestNumber);
    return Promise.resolve(undefined);
  }

  findOpenImplementationPullRequest(
    repositoryFullName: string,
  ): Promise<ExistingImplementationPr | undefined> {
    this.implementationPrLookups.push(repositoryFullName);
    return Promise.resolve(this.openImplementationPr);
  }

  markCommentPickedUp(
    repositoryFullName: string,
    comment: PickedUpComment,
  ): Promise<Error | undefined> {
    if (this.pickupRefusal) return Promise.resolve(this.pickupRefusal);
    this.pickedUp.push({ repositoryFullName, ...comment });
    return Promise.resolve(undefined);
  }
}

// Records which instances the clock and the boot recovery handed over, and lets
// a test make one of them fail. Typed to the seam the real engines satisfy, so
// it cannot answer something they never would.
export class FakePeriodicallyCheckedWorkflow<State extends string>
  implements PeriodicallyCheckedWorkflow<State>
{
  readonly checked: string[] = [];
  readonly recovered: string[] = [];
  failsFor: string | undefined;
  throwsFor: string | undefined;

  constructor(readonly config: { readonly checkWaitMs: Partial<Record<State, number>> }) {}

  onPeriodicCheck(workflowInstanceId: string): Promise<Error | undefined> {
    this.checked.push(workflowInstanceId);
    return this.answerFor(workflowInstanceId);
  }

  onSystemRecovery(workflowInstanceId: string): Promise<Error | undefined> {
    this.recovered.push(workflowInstanceId);
    return this.answerFor(workflowInstanceId);
  }

  private answerFor(workflowInstanceId: string): Promise<Error | undefined> {
    if (this.throwsFor === workflowInstanceId)
      return Promise.reject(new Error('the machine blew up'));
    if (this.failsFor === workflowInstanceId)
      return Promise.resolve(new Error('the machine refused it'));
    return Promise.resolve(undefined);
  }
}

// RecordingAnnouncer is the port the machines announce through, remembering the moments
// instead of delivering them, so a machine's test can say which one it chose.
export interface RecordingAnnouncer extends WorkAnnouncer {
  readonly moments: string[];
}

export function createRecordingAnnouncer(): RecordingAnnouncer {
  const moments: string[] = [];
  const remember = (moment: string) => (): void => {
    moments.push(moment);
  };
  return {
    moments,
    ticketImplementationStarted: remember('ticketImplementationStarted'),
    ticketVerificationStarted: remember('ticketVerificationStarted'),
    ticketRejectedByVerifier: remember('ticketRejectedByVerifier'),
    ticketParked: remember('ticketParked'),
    fixParked: remember('fixParked'),
    pullRequestAdopted: remember('pullRequestAdopted'),
    pullRequestMaintenanceParked: remember('pullRequestMaintenanceParked'),
    pullRequestMerged: remember('pullRequestMerged'),
    pullRequestClosed: remember('pullRequestClosed'),
    requestUnresolvable: remember('requestUnresolvable'),
  };
}

// The five machines as recording doubles, for the clock and the boot recovery.
// Each is checked in the state its instances are born in, so a bare instance is
// due on the first beat.
export interface FakeWorkflowEngines extends WorkflowEngines {
  requestRouter: FakePeriodicallyCheckedWorkflow<RequestRouterState>;
  linearImplementer: FakePeriodicallyCheckedWorkflow<LinearImplementerState>;
  fixImplementer: FakePeriodicallyCheckedWorkflow<FixImplementerState>;
  prMaintainer: FakePeriodicallyCheckedWorkflow<PrMaintainerState>;
  logReviewer: FakePeriodicallyCheckedWorkflow<LogReviewerState>;
}

export function createFakeWorkflowEngines(): FakeWorkflowEngines {
  return {
    requestRouter: new FakePeriodicallyCheckedWorkflow({ checkWaitMs: { rr_pending: 0 } }),
    linearImplementer: new FakePeriodicallyCheckedWorkflow({ checkWaitMs: { li_pending: 0 } }),
    fixImplementer: new FakePeriodicallyCheckedWorkflow({ checkWaitMs: { fi_pending: 0 } }),
    prMaintainer: new FakePeriodicallyCheckedWorkflow({ checkWaitMs: { prm_pending: 0 } }),
    logReviewer: new FakePeriodicallyCheckedWorkflow({ checkWaitMs: { lr_pending: 0 } }),
  };
}

// Opens one instance of each machine, so a test can say which subject it wants
// without repeating what every table needs.
export function openInstancesFor(store: Store, repositoryId: string) {
  return {
    openRequest: () => store.createRequest({ requestSource: 'discord', requestText: 'x' }).id,
    openLinearImplementer: () =>
      store.openLinearImplementer({
        repositoryId,
        linearIssueId: 'iss-1',
        linearIssueIdentifier: 'JAR-58',
      }).id,
    openFixImplementer: () =>
      store.openFixImplementer({ repositoryId, findingFingerprint: 'fp-1' }).id,
    openPrMaintainer: (pullRequestNumber = 4688) =>
      store.openPrMaintainer({ repositoryId, pullRequestNumber }).id,
    openLogReviewer: () => store.openLogReviewer({ repositoryId }).id,
  };
}

export type WorkflowInstanceOpeners = ReturnType<typeof openInstancesFor>;
