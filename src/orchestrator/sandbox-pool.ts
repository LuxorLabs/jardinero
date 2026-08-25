import type { Store } from '../store/store.js';
import type { SandboxRun, WorkflowType } from '../store/types.js';
import { logger } from '../platform/logger.js';
import type { WorkerEvent, WorkerResult, Workflow } from '../types.js';
import type { SandboxPool as SandboxPoolInterface } from './state-machines/execution.js';

// SandboxTask is what an agent needs to run: the prompt the runner builds, and the
// context written into the sandbox for the agent to read.
export interface SandboxTask {
  workflow: Workflow;
  payload: Record<string, unknown>;
  promptOverrides: Record<string, string>;
}

export interface SandboxTaskFactory {
  buildTask(sandboxRun: SandboxRun): Promise<SandboxTask>;
}

export interface SandboxRunContext {
  sandboxRun: SandboxRun;
  task: SandboxTask;
  maxWallClockMs: number;
  signal: AbortSignal;
  publishEvent(event: Omit<WorkerEvent, 'timestamp'>): Promise<void>;
  writeSandboxRunArtifact(name: string, content: string | Buffer): Promise<string>;
}

// SandboxRunner runs one sandbox and answers what the agent produced. Narrower than the
// SandboxRunner behind it, so the pool depends on nothing it does not use.
export interface SandboxRunner {
  run(context: SandboxRunContext): Promise<WorkerResult>;
}

// SandboxRunOutcomeReporter hands a finished run to the machine that owns it, so the
// pool never learns which machines exist.
export interface SandboxRunOutcomeReporter {
  reportSucceeded(sandboxRunId: string, result: WorkerResult): Promise<void>;
  reportFailed(sandboxRunId: string): Promise<void>;
}

export interface SandboxPoolConfig {
  maxConcurrentSandboxes: number;
  maxWallClockMs: number;
  maxConcurrentSandboxesByWorkflow: Partial<Record<WorkflowType, number>>;
}

// SandboxPool runs agents in sandboxes and rations how many run at once. It holds no
// queue: a run the caps refuse is refused, and its instance asks again on the next
// tick.
export class SandboxPool implements SandboxPoolInterface {
  private readonly executing = new Map<string, AbortController>();
  private readonly workflowByRunId = new Map<string, WorkflowType>();
  private stopping = false;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly log = logger.child('sandbox-pool');
  private readonly workerLog = logger.child('worker');

  constructor(
    private readonly store: Store,
    private readonly runner: SandboxRunner,
    private readonly tasks: SandboxTaskFactory,
    private readonly reporter: SandboxRunOutcomeReporter,
    private readonly config: SandboxPoolConfig,
  ) {}

  startSandbox(sandboxRunId: string): boolean {
    // A request still in flight during shutdown can reach a machine after stop()
    // has drained; starting a sandbox here would write into a closed database.
    if (this.stopping) return false;
    if (this.executing.has(sandboxRunId)) return true;
    const sandboxRun = this.store.getSandboxRun(sandboxRunId);
    if (!sandboxRun) {
      this.log.error('sandbox run missing at start', { sandbox_run_id: sandboxRunId });
      return false;
    }
    if (!this.hasRoomFor(sandboxRun.workflowType)) return false;

    const controller = new AbortController();
    this.executing.set(sandboxRunId, controller);
    this.workflowByRunId.set(sandboxRunId, sandboxRun.workflowType);
    // Fired and not awaited: the caller is a state handler inside the engine
    // loop, and the sandbox takes minutes.
    const running = this.execute(sandboxRun, controller.signal);
    this.inFlight.add(running);
    void running.finally(() => this.inFlight.delete(running));
    return true;
  }

  isExecuting(sandboxRunId: string): boolean {
    return this.executing.has(sandboxRunId);
  }

  // recordWorkerEvent writes down what a sandbox reported about its own run, from the
  // runner or over HTTP, and keeps the run row pointing at its sandbox as soon as
  // there is one: a run that never completes still has to be reapable.
  recordWorkerEvent(sandboxRunId: string, event: Omit<WorkerEvent, 'timestamp'>): void {
    const sandboxRun = this.store.getSandboxRun(sandboxRunId);
    if (!sandboxRun) return;
    this.store.appendEvent({
      eventType: event.type,
      workflowType: sandboxRun.workflowType,
      workflowInstanceId: sandboxRun.workflowInstanceId,
      sandboxRunId,
      metadata:
        event.message === undefined ? event.data : { message: event.message, ...event.data },
    });
    const sessionId = event.data?.sandbox_session_id;
    if (event.type === 'sandbox.ready' && typeof sessionId === 'string' && sessionId) {
      this.store.markSandboxRunRunning(sandboxRunId, sessionId);
    }
    this.logWorkerEvent(sandboxRunId, event);
  }

  // logWorkerEvent keeps codex.* at debug because it fires once per streamed CLI line,
  // and lifts a failure to warn.
  private logWorkerEvent(sandboxRunId: string, event: Omit<WorkerEvent, 'timestamp'>): void {
    // Spread the payload first so the run and the type stay authoritative even when a
    // raw codex.* payload carries its own `type`.
    const fields = { ...event.data, sandbox_run: sandboxRunId.slice(0, 8), type: event.type };
    if (event.type.includes('failed') || event.type.includes('rejected')) {
      this.workerLog.warn(event.message ?? event.type, fields);
    } else if (event.type.startsWith('agent.')) {
      this.workerLog.debug(event.message ?? event.type, fields);
    } else {
      this.workerLog.info(event.message ?? event.type, fields);
    }
  }

  abort(sandboxRunId: string): void {
    const controller = this.executing.get(sandboxRunId);
    if (!controller) return;
    controller.abort();
  }

  // stop aborts every sandbox in flight and waits for each to finish recording how
  // it ended, so nothing writes after the process decides to go.
  async stop(): Promise<void> {
    this.stopping = true;
    for (const controller of this.executing.values()) controller.abort();
    await Promise.allSettled([...this.inFlight]);
  }

  // abortReason names us as the cause; whatever error the cancellation left behind reads
  // like a Tenki fault and sends whoever debugs it to the wrong system.
  private abortReason(): string {
    return this.stopping
      ? 'orchestrator stopped while run was in flight'
      : 'run aborted by the orchestrator';
  }

  // abortedRunState answers how an abort is recorded: the shutdown drain leaves the run
  // orphaned, so recovery dispatches it again instead of parking it on a person.
  private abortedRunState(aborted: boolean): 'aborted' | 'orphaned' | undefined {
    if (!aborted) return undefined;
    return this.stopping ? 'orphaned' : 'aborted';
  }

  // Whether the caps allow one more sandbox for this workflow. Public so a state
  // handler can ask before it creates a run row the pool would only refuse.
  hasRoomFor(workflowType: WorkflowType): boolean {
    if (this.stopping) return false;
    if (this.executing.size >= this.config.maxConcurrentSandboxes) return false;
    const cap = this.config.maxConcurrentSandboxesByWorkflow[workflowType];
    if (cap === undefined) return true;
    let running = 0;
    for (const type of this.workflowByRunId.values()) if (type === workflowType) running += 1;
    return running < cap;
  }

  // Builds the task, runs the agent and records how it ended. Never throws: the
  // caller fired it without awaiting.
  private async execute(sandboxRun: SandboxRun, signal: AbortSignal): Promise<void> {
    try {
      const task = await this.tasks.buildTask(sandboxRun);
      this.store.markSandboxRunRunning(sandboxRun.id);
      const result = await this.runner.run({
        sandboxRun,
        task,
        maxWallClockMs: this.config.maxWallClockMs,
        signal,
        publishEvent: async (event) => {
          this.recordWorkerEvent(sandboxRun.id, event);
        },
        writeSandboxRunArtifact: (name, content) =>
          Promise.resolve(this.store.writeSandboxRunArtifact(sandboxRun.id, name, content)),
      });
      await this.finish(sandboxRun, result);
    } catch (error) {
      this.log.error('sandbox run failed', {
        sandbox_run_id: sandboxRun.id,
        agent_name: sandboxRun.agentName,
        reason: error instanceof Error ? error.message : String(error),
      });
      this.store.finishSandboxRun(sandboxRun.id, {
        runState: this.abortedRunState(signal.aborted) ?? 'failed',
        errorMessage: signal.aborted
          ? this.abortReason()
          : error instanceof Error
            ? error.message
            : String(error),
      });
      // An aborted run is one nobody is waiting on any more, so telling the
      // machine would move an instance that already moved on.
      if (!signal.aborted) await this.report(sandboxRun.id, undefined);
    } finally {
      this.executing.delete(sandboxRun.id);
      this.workflowByRunId.delete(sandboxRun.id);
    }
  }

  // Records the outcome of a run the agent completed and reports it onwards.
  private async finish(sandboxRun: SandboxRun, result: WorkerResult): Promise<void> {
    const runState =
      result.status === 'succeeded'
        ? 'succeeded'
        : (this.abortedRunState(result.status === 'aborted') ?? result.status);
    const errorMessage = result.status === 'aborted' ? this.abortReason() : result.error;
    this.store.finishSandboxRun(sandboxRun.id, {
      runState,
      sandboxSessionId: result.sandboxSessionId,
      costUsd: result.costUsd,
      errorMessage,
    });
    this.store.appendEvent({
      eventType: 'sandbox.finished',
      workflowType: sandboxRun.workflowType,
      workflowInstanceId: sandboxRun.workflowInstanceId,
      sandboxRunId: sandboxRun.id,
      metadata: {
        agent_name: sandboxRun.agentName,
        run_state: runState,
        cost_usd: result.costUsd,
        error: errorMessage,
        summary: result.summary,
      },
    });
    if (result.status === 'aborted') return;
    // Report a skipped run as an answer: the agent decided no pull request was warranted.
    const answered = result.status === 'succeeded' || result.status === 'skipped';
    await this.report(sandboxRun.id, answered ? result : undefined);
  }

  // Reports the outcome to the owning machine, swallowing a failure there: the
  // run is already recorded, and the periodic check picks the instance up.
  private async report(sandboxRunId: string, result: WorkerResult | undefined): Promise<void> {
    try {
      if (result) await this.reporter.reportSucceeded(sandboxRunId, result);
      else await this.reporter.reportFailed(sandboxRunId);
    } catch (error) {
      this.log.error('reporting the outcome failed', {
        sandbox_run_id: sandboxRunId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
