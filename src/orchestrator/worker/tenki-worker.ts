import type { AppConfig } from '../../config.js';
import type { SandboxProvider, SandboxSession } from '../../types.js';
import { terminateTenkiSessionInChild } from '../../adapters/tenki/tenki-terminate.js';
import {
  buildTenkiClientOptions,
  JARDINERO_SANDBOX_APP,
  resolveWorkspaceScope,
} from '../../adapters/tenki/tenki-scope.js';
import { SandboxWorkerRunner, type SandboxWorkerRunnerDeps } from './sandbox-worker.js';

type TenkiSdk = typeof import('@tenkicloud/sandbox');
type TenkiSession = import('@tenkicloud/sandbox').Session;

// Seams that production leaves at their defaults; tests inject fakes so the run
// loop can be exercised without a live Tenki sandbox or a child-process close.
export interface TenkiWorkerRunnerDeps extends SandboxWorkerRunnerDeps {
  loadSdk?: () => Promise<TenkiSdk>;
  terminateSession?: typeof terminateTenkiSessionInChild;
}

// TenkiWorkerRunner runs the shared sandbox loop against Tenki.
export class TenkiWorkerRunner extends SandboxWorkerRunner {
  constructor(config: AppConfig, env = process.env, deps: TenkiWorkerRunnerDeps = {}) {
    super(config, env, new TenkiSandboxProvider(config, env, deps), deps);
  }
}

// TenkiSandboxProvider owns the Tenki half of a run: the client, the scope its
// create options need, and the close.
export class TenkiSandboxProvider implements SandboxProvider {
  readonly name = 'Tenki';
  readonly apiTarget = 'api.tenki.cloud';
  private readonly loadSdk: () => Promise<TenkiSdk>;
  private readonly terminateSession: typeof terminateTenkiSessionInChild;
  private sandbox?: Awaited<ReturnType<typeof this.openSandbox>>;
  private workspaceScope?: { workspaceId?: string };

  constructor(
    private readonly config: AppConfig,
    private readonly env = process.env,
    deps: Pick<TenkiWorkerRunnerDeps, 'loadSdk' | 'terminateSession'> = {},
  ) {
    this.loadSdk = deps.loadSdk ?? loadTenkiSdk;
    this.terminateSession = deps.terminateSession ?? terminateTenkiSessionInChild;
  }

  async create(options: Record<string, unknown>, _signal: AbortSignal): Promise<SandboxSession> {
    const sandbox = await this.openSandbox();
    // Tenki-only create options, so they go here and not where the run assembles
    // what every provider shares. The reaper lists by the tag. The scope is kept
    // after the first create because it depends only on the env; caching the
    // value rather than the promise leaves a failed lookup to be retried.
    this.workspaceScope ??= await resolveWorkspaceScope(this.config, this.env, sandbox);
    Object.assign(options, this.workspaceScope, {
      tags: [JARDINERO_SANDBOX_APP],
    });
    return sandbox.create(options);
  }

  waitReady(session: SandboxSession, signal: AbortSignal): Promise<void> {
    return (session as TenkiSession).waitReady(undefined, signal);
  }

  // The close runs in a child process so it still completes when the orchestrator
  // is shutting down and its own event loop is about to go away.
  terminate(session: SandboxSession): Promise<void> {
    return this.terminateSession(session.id, {
      authToken: this.env[this.config.worker.tenkiApiKeyEnv],
      baseUrl: this.env[this.config.worker.tenkiApiUrlEnv],
      cwd: this.config.rootDir,
      timeoutMs: this.config.worker.sessionCloseTimeoutMs,
    });
  }

  private async openSandbox(): Promise<InstanceType<TenkiSdk['TenkiSandbox']>> {
    if (this.sandbox) return this.sandbox;
    const sdk = await this.loadSdk();
    this.sandbox = new sdk.TenkiSandbox(buildTenkiClientOptions(this.config, this.env));
    return this.sandbox;
  }
}

export async function loadTenkiSdk(): Promise<TenkiSdk> {
  try {
    return await import('@tenkicloud/sandbox');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to load @tenkicloud/sandbox (${message}). Run pnpm install to install @tenkicloud/sandbox.`,
    );
  }
}
