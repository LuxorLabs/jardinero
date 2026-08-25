import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadConfig } from '../../config.js';
import { TenkiWorkerRunner, type TenkiWorkerRunnerDeps } from './tenki-worker.js';
import type { SandboxRun } from '../../store/types.js';
import type { SandboxRunContext, SandboxTask } from '../sandbox-pool.js';

// Regression for the wall-clock-abort crash path: when a run hits its
// maxWallClockMs the dispatcher aborts the signal, the worker fires terminate()
// fire-and-forget, and terminate() reports failures via context.publishEvent.
// If the sandbox close fails (common at the wall-clock boundary — the sandbox is
// often unreachable, which is *why* the run ran long) AND publishing that
// failure also throws (events.jsonl append under disk/IO pressure), the cleanup
// promise must not surface as an unhandled rejection: the orchestrator exits the
// whole process on any unhandled rejection, taking every in-flight run with it.
describe('TenkiWorkerRunner', () => {
  test('When a terminate failure report also throws then should not reject', async () => {
    const config = loadConfig();

    const env: NodeJS.ProcessEnv = {};
    env[config.worker.githubTokenEnv] = 'gh-token';
    // Set the project id so resolveTenkiScope short-circuits and never calls the
    // (faked) sandbox's whoAmI.
    env[config.worker.tenkiProjectIdEnv] = 'project-1';
    env[config.worker.tenkiApiKeyEnv] = 'tenki-key';
    if (config.worker.codexAuthMode === 'access_token') {
      env[config.worker.codexAccessTokenEnv] = 'codex-token';
    } else if (config.worker.codexAuthMode === 'api_key') {
      env[config.worker.codexApiKeyEnv] = 'codex-key';
    }

    // waitReady never settles on its own: it parks the run exactly where a
    // long-running codex exec sits when the wall-clock timer fires (the exec does
    // not observe the abort signal), so the only thing between a failed
    // session-close and the process is the abort handler's guard.
    const waitReady = deferred<void>();
    const fakeSdk = {
      TenkiSandbox: class {
        async create(): Promise<unknown> {
          return {
            id: 'fake-session',
            waitReady: () => waitReady.promise,
          };
        }
      },
    };

    const runner = new TenkiWorkerRunner(config, env, {
      loadSdk: (async () => fakeSdk) as unknown as TenkiWorkerRunnerDeps['loadSdk'],
      // The sandbox close fails, the way it does when the sandbox is unreachable.
      terminateSession: (async () => {
        throw new Error('boom-terminate');
      }) as unknown as TenkiWorkerRunnerDeps['terminateSession'],
    });

    const controller = new AbortController();
    const context: SandboxRunContext = {
      sandboxRun: fakeSandboxRun(),
      task: fakeTask(),
      maxWallClockMs: 1_000,
      signal: controller.signal,
      publishEvent: async (event) => {
        // The events.jsonl append fails for the termination report — the second
        // half of the compound fault.
        if (event.type === 'sandbox.close_failed') {
          throw new Error('boom-append');
        }
      },
      writeSandboxRunArtifact: async () => 'artifact',
    };

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const runPromise = runner.run(context);
      // Let the run reach (and park in) waitReady so a session exists to terminate.
      await flushMacrotasks();
      controller.abort();
      // Let the abort handler's terminate() + failed report settle and, if
      // unguarded, surface as an unhandled rejection.
      await flushMacrotasks();
      await flushMacrotasks();
      await flushMacrotasks();

      assert.deepEqual(rejections, [], 'abort cleanup must not leak an unhandled rejection');

      // Release the parked run so it can settle and the test can finish. The
      // worker rethrows the abort, so the run rejects — handled here as the
      // dispatcher would handle it.
      waitReady.reject(new Error('Run aborted.'));
      await assert.rejects(runPromise);
      // No further rejections leaked while the run unwound.
      assert.deepEqual(rejections, []);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

function fakeSandboxRun(): SandboxRun {
  return {
    id: 'run-abort-test',
    agentName: 'PrMaintainer',
    runState: 'running',
    workflowType: 'pr_maintainer',
    workflowInstanceId: 'instance-1',
    sandboxSessionId: null,
    costUsd: null,
    errorMessage: null,
    startedAt: 0,
    endedAt: null,
  };
}

function fakeTask(): SandboxTask {
  return {
    workflow: 'pr_maintain',
    payload: { repo: 'acme/web.app', pr_number: 1 },
    promptOverrides: {},
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMacrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
