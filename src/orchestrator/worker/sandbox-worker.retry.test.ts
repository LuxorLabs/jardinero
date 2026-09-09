import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadConfig, type AppConfig } from '../../config.js';
import type { SandboxRun } from '../../store/types.js';
import type { SandboxRunContext, SandboxTask } from '../sandbox-pool.js';
import type { SandboxExecOutput, SandboxProvider, SandboxSession } from '../../types.js';
import {
  SandboxWorkerRunner,
  isCodexCapacityError,
  type SandboxWorkerRunnerDeps,
} from './sandbox-worker.js';
import { HANDOFF_JSON_MARKER } from '../../workflows/pr/implementation-handoff.js';

// What Codex prints when the model it was asked for is full.
const CAPACITY_STDOUT = JSON.stringify({
  type: 'agent.turn.failed',
  error: { message: 'Selected model is at capacity. Please try a different model.' },
});

const LOG_REVIEW_REPORTING_EVENTS = new Set([
  'agent.implementation_reported',
  'agent.scan_finished',
  'agent.scan_output_invalid',
  'agent.logs_reachable_check',
  'agent.logs_reachable_passed',
  'agent.logs_reachable_failed',
]);

describe('SandboxWorkerRunner', () => {
  test('When waitReady deadline exceeded then should retry with fresh session', async () => {
    const operations: string[] = [];
    const first = fakeSession('first', operations, {
      waitReadyError: new Error('[deadline_exceeded] the operation timed out'),
    });
    const second = fakeSession('second', operations);
    const events: Array<{ type: string; data?: Record<string, unknown>; message?: string }> = [];
    const runner = fakeRunner([first, second], operations);

    const result = await runner.run(fakeContext(events));

    assert.equal(result.status, 'succeeded');
    assert.deepEqual(operations.slice(0, 5), [
      'create:first',
      'waitReady:first',
      'terminate:first',
      'create:second',
      'waitReady:second',
    ]);
    assert.equal(operations.includes('exec:second'), true);
    assert.equal(
      events.some((event) => event.type === 'sandbox.create_retried'),
      true,
    );
    assert.deepEqual(events.find((event) => event.type === 'sandbox.create_retried')?.data, {
      run_id: 'run-retry-test',
      attempt: 1,
      next_attempt: 2,
      max_attempts: 2,
      stage: 'wait_ready',
      reason: 'deadline_exceeded',
      error: '[deadline_exceeded] the operation timed out',
    });
  });

  test('When waitReady http2 goaway then should retry or fail without uncaught exception', async () => {
    const operations: string[] = [];
    const first = fakeSession('first', operations, {
      waitReadyError: new Error(
        'ConnectError: [canceled] received GOAWAY without any open streams',
      ),
    });
    const second = fakeSession('second', operations);
    const events: Array<{ type: string; data?: Record<string, unknown>; message?: string }> = [];
    const runner = fakeRunner([first, second], operations);

    const result = await runner.run(fakeContext(events));

    assert.equal(result.status, 'succeeded');
    assert.deepEqual(operations.slice(0, 5), [
      'create:first',
      'waitReady:first',
      'terminate:first',
      'create:second',
      'waitReady:second',
    ]);
    assert.equal(operations.includes('exec:second'), true);
    assert.deepEqual(events.find((event) => event.type === 'sandbox.create_retried')?.data, {
      run_id: 'run-retry-test',
      attempt: 1,
      next_attempt: 2,
      max_attempts: 2,
      stage: 'wait_ready',
      reason: 'http2_goaway',
      error: 'ConnectError: [canceled] received GOAWAY without any open streams',
    });
  });

  const waitReadyTransientCases = [
    {
      name: 'When waitReady terminal terminated then should retry with fresh session',
      error: new Error('session entered terminal state: TERMINATED'),
      reason: 'session_terminal_terminated',
    },
    {
      name: 'When waitReady failed precondition not ready then should retry with fresh session',
      error: new Error('[failed_precondition] session is not ready for command execution'),
      reason: 'session_not_ready',
    },
  ] satisfies Array<{
    name: string;
    error: Error;
    reason: string;
  }>;

  for (const c of waitReadyTransientCases) {
    test(c.name, async () => {
      const operations: string[] = [];
      const first = fakeSession('first', operations, {
        waitReadyError: c.error,
      });
      const second = fakeSession('second', operations);
      const events: Array<{ type: string; data?: Record<string, unknown>; message?: string }> = [];
      const runner = fakeRunner([first, second], operations);

      const result = await runner.run(fakeContext(events));

      assert.equal(result.status, 'succeeded');
      assert.deepEqual(operations.slice(0, 5), [
        'create:first',
        'waitReady:first',
        'terminate:first',
        'create:second',
        'waitReady:second',
      ]);
      assert.equal(operations.includes('exec:second'), true);
      assert.deepEqual(events.find((event) => event.type === 'sandbox.create_retried')?.data, {
        run_id: 'run-retry-test',
        attempt: 1,
        next_attempt: 2,
        max_attempts: 2,
        stage: 'wait_ready',
        reason: c.reason,
        error: c.error.message,
      });
    });
  }

  test('When config allows three ready attempts then should retry twice', async () => {
    const operations: string[] = [];
    const first = fakeSession('first', operations, {
      waitReadyError: new Error('[deadline_exceeded] first timeout'),
    });
    const second = fakeSession('second', operations, {
      waitReadyError: new Error('[deadline_exceeded] second timeout'),
    });
    const third = fakeSession('third', operations);
    const events: Array<{ type: string; data?: Record<string, unknown>; message?: string }> = [];
    const runner = fakeRunner([first, second, third], operations, {
      config: (config) => {
        config.worker.maxSandboxReadyAttempts = 3;
      },
    });

    const result = await runner.run(fakeContext(events));

    assert.equal(result.status, 'succeeded');
    assert.deepEqual(
      operations.filter((operation) => operation.startsWith('create:')),
      ['create:first', 'create:second', 'create:third'],
    );
    assert.deepEqual(
      events
        .filter((event) => event.type === 'sandbox.create_retried')
        .map((event) => event.data?.max_attempts),
      [3, 3],
    );
  });

  test('When waitReady abort fires then should not retry', async () => {
    const operations: string[] = [];
    const events: Array<{ type: string; data?: Record<string, unknown>; message?: string }> = [];
    const controller = new AbortController();
    const first = fakeSession('first', operations, {
      waitReady: async () => {
        controller.abort();
        throw new Error('[deadline_exceeded] the operation timed out');
      },
    });
    const runner = fakeRunner([first], operations);

    await assert.rejects(
      runner.run(fakeContext(events, controller)),
      /\[wait for Fake sandbox to become ready\|fake\.invalid\]/,
    );

    assert.deepEqual(
      operations.filter((operation) => operation.startsWith('create:')),
      ['create:first'],
    );
    assert.equal(
      events.some((event) => event.type === 'sandbox.create_retried'),
      false,
    );
  });

  test('When waitReady error is not retryable then should return error', async () => {
    const operations: string[] = [];
    const events: Array<{ type: string; data?: Record<string, unknown>; message?: string }> = [];
    const first = fakeSession('first', operations, {
      waitReadyError: new Error('permanent template validation failed'),
    });
    const runner = fakeRunner([first], operations);

    await assert.rejects(
      runner.run(fakeContext(events)),
      /\[wait for Fake sandbox to become ready\|fake\.invalid\] Call failed: permanent template validation failed/,
    );

    assert.deepEqual(
      operations.filter((operation) => operation.startsWith('create:')),
      ['create:first'],
    );
    assert.equal(
      events.some((event) => event.type === 'sandbox.create_retried'),
      false,
    );
  });

  test('When failed session termination fails then should still retry', async () => {
    const operations: string[] = [];
    const first = fakeSession('first', operations, {
      waitReadyError: new Error('Stream closed with error code NGHTTP2_REFUSED_STREAM'),
    });
    const second = fakeSession('second', operations);
    const events: Array<{ type: string; data?: Record<string, unknown>; message?: string }> = [];
    const runner = fakeRunner([first, second], operations, {
      terminateErrorSessionIds: new Set(['first']),
    });

    const result = await runner.run(fakeContext(events));

    assert.equal(result.status, 'succeeded');
    assert.deepEqual(operations.slice(0, 5), [
      'create:first',
      'waitReady:first',
      'terminate:first',
      'create:second',
      'waitReady:second',
    ]);
    assert.equal(
      events.some(
        (event) => event.type === 'sandbox.close_failed' && event.message === 'terminate failed',
      ),
      true,
    );
  });

  const preCodexSetupCases = [
    {
      name: 'When write context refused stream then should retry with fresh session',
      firstSessionOptions: {
        writeFileErrorOnCall: 3,
        writeFileError: new Error('Stream closed with error code NGHTTP2_REFUSED_STREAM'),
      },
      wantRetry: {
        stage: 'write_context',
        reason: 'http2_refused_stream',
        error: 'Stream closed with error code NGHTTP2_REFUSED_STREAM',
      },
      wantStatus: 'succeeded',
    },
    {
      name: 'When write context error is not retryable then should return error',
      firstSessionOptions: {
        writeFileErrorOnCall: 3,
        writeFileError: new Error('workspace disk is full'),
      },
      wantReject: /workspace disk is full/,
      wantRetry: undefined,
    },
    {
      name: 'When write context abort fires then should not retry',
      firstSessionOptions: {
        writeFileErrorOnCall: 3,
        writeFileError: new Error('Stream closed with error code NGHTTP2_REFUSED_STREAM'),
        abortBeforeWriteFileError: true,
      },
      wantReject: /NGHTTP2_REFUSED_STREAM/,
      wantRetry: undefined,
      abort: true,
    },
    {
      name: 'When failed pre codex session termination fails then should still retry',
      firstSessionOptions: {
        writeFileErrorOnCall: 3,
        writeFileError: new Error('Stream closed with error code NGHTTP2_REFUSED_STREAM'),
      },
      terminateErrorSessionIds: new Set(['first']),
      wantRetry: {
        stage: 'write_context',
        reason: 'http2_refused_stream',
        error: 'Stream closed with error code NGHTTP2_REFUSED_STREAM',
      },
      wantStatus: 'succeeded',
      wantTerminateFailureEvent: true,
    },
  ] satisfies Array<{
    name: string;
    firstSessionOptions: FakeSessionOptions;
    wantRetry:
      | {
          stage: string;
          reason: string;
          error: string;
        }
      | undefined;
    wantStatus?: 'succeeded';
    wantReject?: RegExp;
    abort?: boolean;
    terminateErrorSessionIds?: Set<string>;
    wantTerminateFailureEvent?: boolean;
  }>;

  for (const c of preCodexSetupCases) {
    test(c.name, async () => {
      const operations: string[] = [];
      const events: Array<{ type: string; data?: Record<string, unknown>; message?: string }> = [];
      const controller = new AbortController();
      const first = fakeSession('first', operations, c.firstSessionOptions, controller);
      const second = fakeSession('second', operations);
      const runner = fakeRunner([first, second], operations, {
        terminateErrorSessionIds: c.terminateErrorSessionIds,
      });
      const runPromise = runner.run(fakeContext(events, controller));

      if (c.wantReject) {
        await assert.rejects(runPromise, c.wantReject);
      } else {
        const result = await runPromise;
        assert.equal(result.status, c.wantStatus);
      }

      const retryEvent = events.find((event) => event.type === 'sandbox.create_retried');
      if (c.wantRetry) {
        assert.deepEqual(retryEvent?.data, {
          run_id: 'run-retry-test',
          attempt: 1,
          next_attempt: 2,
          max_attempts: 2,
          ...c.wantRetry,
        });
        assert.deepEqual(
          operations.filter((operation) => operation.startsWith('create:')),
          ['create:first', 'create:second'],
        );
      } else {
        assert.equal(retryEvent, undefined);
        assert.deepEqual(
          operations.filter((operation) => operation.startsWith('create:')),
          ['create:first'],
        );
      }

      const readyEvents = events.filter((event) => event.type === 'sandbox.ready');
      assert.deepEqual(
        readyEvents.map((event) => event.data?.sandbox_session_id),
        c.wantStatus ? ['first', 'second'] : ['first'],
      );

      if (c.wantTerminateFailureEvent) {
        assert.equal(
          events.some(
            (event) =>
              event.type === 'sandbox.close_failed' && event.message === 'terminate failed',
          ),
          true,
        );
      }
    });
  }

  const gitCloneCases = [
    {
      name: 'When git clone dns resolution fails then should retry with fresh session',
      firstCloneError: new Error(
        "fatal: unable to access 'https://github.com/acme/webapp/': Could not resolve host: github.com",
      ),
      wantRetry: {
        reason: 'dns_lookup_failed',
        error:
          "fatal: unable to access 'https://github.com/acme/webapp/': Could not resolve host: github.com",
      },
      wantStatus: 'succeeded',
    },
    {
      name: 'When git clone auth fails then should return error',
      firstCloneError: new Error(
        "fatal: unable to access 'https://github.com/acme/webapp/': The requested URL returned error: 403",
      ),
      wantReject: /The requested URL returned error: 403/,
    },
  ] satisfies Array<{
    name: string;
    firstCloneError: Error;
    wantRetry?: {
      reason: string;
      error: string;
    };
    wantStatus?: 'succeeded';
    wantReject?: RegExp;
  }>;

  for (const c of gitCloneCases) {
    test(c.name, async () => {
      const operations: string[] = [];
      const events: Array<{ type: string; data?: Record<string, unknown>; message?: string }> = [];
      const first = fakeSession('first', operations, {
        gitCloneError: c.firstCloneError,
      });
      const second = fakeSession('second', operations);
      const runner = fakeRunner([first, second], operations);
      const task = { ...fakeTask(), payload: { repo: 'acme/webapp' } };
      const runPromise = runner.run(fakeContext(events, new AbortController(), task));

      if (c.wantReject) {
        await assert.rejects(runPromise, c.wantReject);
      } else {
        const result = await runPromise;
        assert.equal(result.status, c.wantStatus);
      }

      const retryEvent = events.find((event) => event.type === 'sandbox.create_retried');
      if (c.wantRetry) {
        assert.deepEqual(retryEvent?.data, {
          run_id: 'run-retry-test',
          attempt: 1,
          next_attempt: 2,
          max_attempts: 2,
          stage: 'prepare_workspace',
          ...c.wantRetry,
        });
        assert.deepEqual(
          operations.filter((operation) => operation.startsWith('create:')),
          ['create:first', 'create:second'],
        );
        assert.deepEqual(
          operations.filter((operation) => operation.startsWith('clone:')),
          ['clone:first', 'clone:second'],
        );
      } else {
        assert.equal(retryEvent, undefined);
        assert.deepEqual(
          operations.filter((operation) => operation.startsWith('create:')),
          ['create:first'],
        );
        assert.deepEqual(
          operations.filter((operation) => operation.startsWith('clone:')),
          ['clone:first'],
        );
      }
    });
  }

  test('When run reaches codex then should emit ordered stage events', async () => {
    const operations: string[] = [];
    const events: Array<{ type: string; data?: Record<string, unknown>; message?: string }> = [];
    const session = fakeSession('only', operations);
    session.git = {
      async clone(_url: string, _options: unknown) {
        operations.push('clone:only');
      },
    };
    const runner = fakeRunner([session], operations);
    const task = { ...fakeTask(), payload: { repo: 'acme/webapp' } };

    const result = await runner.run(fakeContext(events, new AbortController(), task));

    assert.equal(result.status, 'succeeded');
    const instrumented = new Set([
      'sandbox.prepare_workspace_started',
      'sandbox.cloning',
      'sandbox.cloned',
      'sandbox.docker_socket_access_started',
      'sandbox.prepare_repo_docs_started',
      'sandbox.write_context_started',
      'sandbox.prepare_codex_auth_started',
      'sandbox.prepare_grafana_mcp_started',
      'sandbox.verify_log_review_telemetry_started',
      'agent.started',
      'agent.finished',
    ]);
    assert.deepEqual(
      events.map((event) => event.type).filter((type) => instrumented.has(type)),
      [
        'sandbox.prepare_workspace_started',
        'sandbox.cloning',
        'sandbox.cloned',
        'sandbox.docker_socket_access_started',
        'sandbox.prepare_repo_docs_started',
        'sandbox.write_context_started',
        'sandbox.prepare_codex_auth_started',
        'sandbox.prepare_grafana_mcp_started',
        'sandbox.verify_log_review_telemetry_started',
        'agent.started',
        'agent.finished',
      ],
    );
  });

  test('When stage event write fails then should not abort the run', async () => {
    const operations: string[] = [];
    const events: Array<{ type: string; data?: Record<string, unknown>; message?: string }> = [];
    const session = fakeSession('only', operations);
    const runner = fakeRunner([session], operations);
    const context: SandboxRunContext = {
      sandboxRun: fakeSandboxRun(),
      task: fakeTask(),
      maxWallClockMs: 1_000,
      signal: new AbortController().signal,
      publishEvent: async (event) => {
        if (event.type === 'sandbox.write_context_started') {
          throw new Error('ENOSPC: no space left on device');
        }
        events.push({ type: event.type, data: event.data, message: event.message });
      },
      writeSandboxRunArtifact: async (name) => name,
    };

    const result = await runner.run(context);

    assert.equal(result.status, 'succeeded');
    assert.equal(
      events.some((event) => event.type === 'sandbox.write_context_started'),
      false,
    );
    assert.equal(
      events.some((event) => event.type === 'agent.started'),
      true,
    );
    assert.equal(
      events.some((event) => event.type === 'agent.finished'),
      true,
    );
  });

  const logReviewValidationEventCases = [
    {
      name: 'When handoff contract is missing then should emit contract failure event',
      finalMessage: `${HANDOFF_JSON_MARKER} ${JSON.stringify({
        telemetry_access: { status: 'ok', queries: ['{app="api"} |= "error"'] },
        candidates: [],
      })}`,
      wantType: 'agent.scan_output_invalid',
      wantMessage:
        'Log review output failed the handoff contract: structured_output_missing_implementation_handoffs',
      wantReason: 'structured_output_missing_implementation_handoffs',
      wantRejections: [{ index: 0, reason: 'structured_output_missing_implementation_handoffs' }],
      wantDetail: undefined,
    },
    {
      name: 'When handoff marker json is invalid then should emit contract failure event',
      finalMessage: `${HANDOFF_JSON_MARKER} {"implementation_handoffs":`,
      wantType: 'agent.scan_output_invalid',
      wantMessage: 'Log review output failed the handoff contract: marker_invalid_json',
      wantReason: 'marker_invalid_json',
      wantRejections: [{ index: 0, reason: 'marker_invalid_json' }],
      wantDetail: 'implementation handoff parser rejected index 0',
    },
    {
      name: 'When telemetry access is missing then should emit telemetry failure event',
      finalMessage: `${HANDOFF_JSON_MARKER} ${JSON.stringify({ implementation_handoffs: [] })}`,
      wantType: 'agent.logs_reachable_failed',
      wantMessage: 'Log review did not prove telemetry access: missing_telemetry_access',
      wantReason: 'missing_telemetry_access',
      wantRejections: [],
      wantDetail: undefined,
    },
  ];

  for (const c of logReviewValidationEventCases) {
    test(c.name, async () => {
      const operations: string[] = [];
      const events: Array<{ type: string; data?: Record<string, unknown>; message?: string }> = [];
      const session = fakeSession('only', operations, { readFileContent: c.finalMessage });
      const runner = fakeRunner([session], operations, {
        config: (config) => {
          config.mcp.grafana.enabled = false;
        },
      });
      const task: SandboxTask = { workflow: 'log_review', payload: {}, promptOverrides: {} };

      const result = await runner.run(
        fakeContext(events, new AbortController(), task, {
          ...fakeSandboxRun(),
          agentName: 'LogReviewer',
          workflowType: 'log_reviewer',
        }),
      );

      assert.equal(result.status, 'failed');
      assert.equal(result.error, c.wantReason);
      assert.ok(
        result.summary?.endsWith(`${c.wantMessage}.`),
        `summary should end with the failure reported to operators, got: ${result.summary}`,
      );
      assert.deepEqual(
        events
          .filter((event) => LOG_REVIEW_REPORTING_EVENTS.has(event.type))
          .map((event) => ({ type: event.type, message: event.message, data: event.data })),
        [
          {
            type: 'agent.implementation_reported',
            message: 'Parsed 0 implementation handoff(s).',
            data: {
              handoffs: 0,
              rejections: c.wantRejections,
              artifact: 'implementation-handoffs.json',
            },
          },
          {
            type: c.wantType,
            message: c.wantMessage,
            data: {
              reason: c.wantReason,
              detail: c.wantDetail,
            },
          },
        ],
      );
    });
  }

  test('When a complete scan reports no findings then should succeed', async () => {
    const operations: string[] = [];
    const events: Array<{ type: string; data?: Record<string, unknown>; message?: string }> = [];
    const session = fakeSession('only', operations, {
      readFileContent: `${HANDOFF_JSON_MARKER} ${JSON.stringify({
        telemetry_access: { status: 'ok', queries: ['{app="api"} |= "error"'] },
        candidates: [],
        verified_issues: [],
      })}`,
    });
    const runner = fakeRunner([session], operations, {
      config: (config) => {
        config.mcp.grafana.enabled = false;
      },
    });
    const task: SandboxTask = { workflow: 'log_review', payload: {}, promptOverrides: {} };

    const result = await runner.run(
      fakeContext(events, new AbortController(), task, {
        ...fakeSandboxRun(),
        agentName: 'LogReviewer',
        workflowType: 'log_reviewer',
      }),
    );

    assert.equal(result.status, 'succeeded');
    assert.equal(result.error, undefined);
    assert.deepEqual(result.implementationHandoffs, []);
    assert.deepEqual(result.implementationHandoffRejections, []);
  });
  const capacityCases = [
    {
      name: 'When the seat model is at capacity then should finish on the implementation model',
      codexExecResults: [
        { exitCode: 1, stdout: CAPACITY_STDOUT },
        { exitCode: 0, stdout: '' },
      ],
      wantStatus: 'succeeded',
      wantModels: ['gpt-5.6-terra', 'gpt-5.6-sol'],
      wantRetries: 1,
    },
    {
      name: 'When every model is at capacity then should report the failure',
      codexExecResults: [
        { exitCode: 1, stdout: CAPACITY_STDOUT },
        { exitCode: 1, stdout: CAPACITY_STDOUT },
      ],
      wantStatus: 'failed',
      wantModels: ['gpt-5.6-terra', 'gpt-5.6-sol'],
      wantRetries: 1,
      // One tail per run, so what both attempts printed is in it.
      wantTail: `${CAPACITY_STDOUT}\n${CAPACITY_STDOUT}\n`,
    },
    {
      name: 'When the run fails for another reason then should not try another model',
      codexExecResults: [{ exitCode: 1, stdout: 'error: repository checkout failed' }],
      wantStatus: 'failed',
      wantModels: ['gpt-5.6-terra'],
      wantRetries: 0,
      wantTail: 'error: repository checkout failed\n',
    },
  ];

  for (const c of capacityCases) {
    test(c.name, async () => {
      const operations: string[] = [];
      const events: Array<{ type: string; data?: Record<string, unknown>; message?: string }> = [];
      const artifacts: Array<{ name: string; content: string }> = [];
      const session = fakeSession('only', operations, {
        codexExecResults: c.codexExecResults,
        readFileContent: `${HANDOFF_JSON_MARKER} ${JSON.stringify({
          telemetry_access: { status: 'ok', queries: ['{app="api"} |= "error"'] },
          candidates: [],
          verified_issues: [],
          implementation_handoffs: [],
        })}`,
      });
      const runner = fakeRunner([session], operations, {
        config: (config) => {
          config.mcp.grafana.enabled = false;
        },
      });
      const task: SandboxTask = {
        workflow: 'log_review',
        payload: { repo: 'acme/webapp' },
        promptOverrides: {},
      };

      const result = await runner.run(
        fakeContext(
          events,
          new AbortController(),
          task,
          { ...fakeSandboxRun(), agentName: 'LogReviewer', workflowType: 'log_reviewer' },
          artifacts,
        ),
      );

      assert.equal(result.status, c.wantStatus);
      assert.deepEqual(
        events.filter((event) => event.type === 'agent.started').map((event) => event.data?.model),
        c.wantModels,
      );
      assert.equal(
        events.filter((event) => event.type === 'agent.model_at_capacity').length,
        c.wantRetries,
      );
      assert.equal(
        artifacts.find((artifact) => artifact.name === 'codex-output-tail.txt')?.content,
        c.wantTail,
      );
    });
  }
});

describe('the output tail of a codex run', () => {
  const cases: Array<{
    name: string;
    codexExecResults: Array<{ exitCode: number; stdout?: string }>;
    wantTail?: string;
  }> = [
    {
      name: 'When the run exited failing then should keep what it printed',
      codexExecResults: [{ exitCode: 1, stdout: 'error: repository checkout failed' }],
      wantTail: 'error: repository checkout failed\n',
    },
    {
      name: 'When the run succeeded then should keep nothing',
      codexExecResults: [{ exitCode: 0, stdout: 'thinking out loud' }],
    },
    {
      name: 'When the run printed nothing then should keep nothing',
      codexExecResults: [{ exitCode: 1 }],
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const operations: string[] = [];
      const events: Array<{ type: string; data?: Record<string, unknown>; message?: string }> = [];
      const artifacts: Array<{ name: string; content: string }> = [];
      const session = fakeSession('only', operations, { codexExecResults: c.codexExecResults });
      const runner = fakeRunner([session], operations);

      await runner.run(
        fakeContext(events, new AbortController(), fakeTask(), fakeSandboxRun(), artifacts),
      );

      assert.equal(
        artifacts.find((artifact) => artifact.name === 'codex-output-tail.txt')?.content,
        c.wantTail,
      );
    });
  }

  test('When the artifact cannot be written then should leave the failure as the run answer', async () => {
    const operations: string[] = [];
    const events: Array<{ type: string; data?: Record<string, unknown>; message?: string }> = [];
    const session = fakeSession('only', operations, {
      codexExecResults: [{ exitCode: 1, stdout: 'error: repository checkout failed' }],
    });
    const runner = fakeRunner([session], operations);
    const context = fakeContext(events);
    context.writeSandboxRunArtifact = (name) =>
      name === 'codex-output-tail.txt'
        ? Promise.reject(new Error('the artifacts directory is gone'))
        : Promise.resolve(name);

    const result = await runner.run(context);

    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'codex_exec_failed');
  });

  test('When the run died mid-stream then should keep what it printed and pass the failure on', async () => {
    const operations: string[] = [];
    const events: Array<{ type: string; data?: Record<string, unknown>; message?: string }> = [];
    const artifacts: Array<{ name: string; content: string }> = [];
    const session = fakeSession('only', operations, {
      codexExecResults: [{ exitCode: 0, stdout: 'the last thing it printed' }],
      codexExecError: new Error('sandbox run stream closed before exit'),
    });
    const runner = fakeRunner([session], operations);

    await assert.rejects(
      runner.run(
        fakeContext(events, new AbortController(), fakeTask(), fakeSandboxRun(), artifacts),
      ),
      /stream closed before exit/,
    );

    assert.equal(
      artifacts.find((artifact) => artifact.name === 'codex-output-tail.txt')?.content,
      'the last thing it printed\n',
    );
  });
});

describe('repo secret envs in the sandbox session', () => {
  const cases: Array<{
    name: string;
    secretEnvs: string[];
    orchestratorEnv: Record<string, string>;
    wantEnv: Record<string, string | undefined>;
  }> = [
    {
      name: 'When the repo declares a secret env and it is set then should pass it through',
      secretEnvs: ['ALPHA_KEY'],
      orchestratorEnv: { ALPHA_KEY: 'alpha-value' },
      wantEnv: { ALPHA_KEY: 'alpha-value' },
    },
    {
      name: 'When the secret env is not set on the orchestrator then should leave it unset',
      secretEnvs: ['ALPHA_KEY'],
      orchestratorEnv: {},
      wantEnv: { ALPHA_KEY: undefined },
    },
    {
      name: 'When the repo declares no secret env then should pass nothing extra',
      secretEnvs: [],
      orchestratorEnv: { ALPHA_KEY: 'alpha-value' },
      wantEnv: { ALPHA_KEY: undefined },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const operations: string[] = [];
      const creates: Array<Record<string, unknown>> = [];
      const runner = fakeRunner([fakeSession('first', operations)], operations, {
        captureCreates: creates,
        config: (config) => {
          config.worker.repos['acme/web.app'] = { secretEnvs: c.secretEnvs };
        },
        env: (env) => {
          Object.assign(env, c.orchestratorEnv);
        },
      });

      await runner.run(fakeContext([]));

      const sessionEnv = creates[0]?.env as Record<string, string> | undefined;
      for (const [name, want] of Object.entries(c.wantEnv)) {
        assert.equal(sessionEnv?.[name], want);
      }
    });
  }
});

describe('checking out the pull request a pass continues', () => {
  const cases: Array<{
    name: string;
    workflow: 'pr_maintain' | 'linear' | 'fix_implement';
    payload: Record<string, unknown>;
    headRef?: string | Error;
    wantFetched: boolean;
    wantCheckout?: string;
    wantUnresolvedEvent?: boolean;
  }> = [
    {
      name: 'When maintenance names a pull request then should fetch its head',
      workflow: 'pr_maintain',
      payload: { repo: 'acme/webapp', pr_number: 4166 },
      headRef: 'agent/linear-SUP-3003-abc123',
      wantFetched: true,
    },
    {
      name: 'When a linear revision names a pull request then should fetch its head',
      workflow: 'linear',
      payload: { repo: 'acme/webapp', pr_number: 4166 },
      headRef: 'agent/linear-SUP-3003-abc123',
      wantFetched: true,
    },
    {
      name: 'When a fix pass names a pull request then should fetch its head',
      workflow: 'fix_implement',
      payload: { repo: 'acme/webapp', pr_number: 4166 },
      headRef: 'agent/linear-SUP-3003-abc123',
      wantFetched: true,
    },
    {
      name: 'When the pass names no pull request then should leave the clone alone',
      workflow: 'linear',
      payload: { repo: 'acme/webapp' },
      wantFetched: false,
    },
    {
      name: 'When the pull request head resolves then should check out that branch',
      workflow: 'linear',
      payload: { repo: 'acme/webapp', pr_number: 4166 },
      headRef: 'agent/linear-SUP-3003-abc123',
      wantFetched: true,
      wantCheckout: `checkout -B 'agent/linear-SUP-3003-abc123'`,
    },
    {
      name: 'When the pull request head lookup fails then should check out a local name',
      workflow: 'linear',
      payload: { repo: 'acme/webapp', pr_number: 4166 },
      headRef: new Error('HTTP 404'),
      wantFetched: true,
      wantCheckout: `checkout -B 'pr-4166'`,
      wantUnresolvedEvent: true,
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const operations: string[] = [];
      const events: Array<{ type: string; data?: Record<string, unknown>; message?: string }> = [];
      const commands: string[] = [];
      const session = fakeSession('only', operations, { commands });
      const runner = fakeRunner([session], operations, {
        config: (config) => {
          config.mcp.grafana.enabled = false;
        },
        ...(c.headRef === undefined
          ? {}
          : {
              getPullRequestHead: async () => {
                if (c.headRef instanceof Error) throw c.headRef;
                return { nodeId: 'node-1', draft: true, headRef: c.headRef as string };
              },
            }),
      });
      const task: SandboxTask = { workflow: c.workflow, payload: c.payload, promptOverrides: {} };

      await runner.run(fakeContext(events, new AbortController(), task));

      assert.equal(
        events.some((event) => event.type === 'sandbox.fetching_pull_request'),
        c.wantFetched,
      );
      assert.equal(
        events.some((event) => event.type === 'sandbox.pull_request_head_unresolved'),
        c.wantUnresolvedEvent === true,
      );
      if (c.wantCheckout) {
        assert.ok(
          commands.some((command) => command.includes(c.wantCheckout!)),
          `no checkout matched ${c.wantCheckout}`,
        );
      }
    });
  }
});

describe('isCodexCapacityError', () => {
  const cases: Array<{ name: string; result: Record<string, string>; want: boolean }> = [
    {
      name: 'When the refusal is on stdout then should be a capacity error',
      result: { stdout: CAPACITY_STDOUT },
      want: true,
    },
    {
      name: 'When the refusal is on stderr then should be a capacity error',
      result: { stderr: 'error: Selected model is at capacity. Please try a different model.' },
      want: true,
    },
    {
      name: 'When the refusal is in the last message then should be a capacity error',
      result: { lastMessage: 'The model is at capacity right now.' },
      want: true,
    },
    {
      name: 'When the failure is another one then should not be a capacity error',
      result: { stderr: 'error: repository checkout failed' },
      want: false,
    },
    {
      name: 'When there is no output then should not be a capacity error',
      result: {},
      want: false,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.equal(isCodexCapacityError(c.result), c.want);
    });
  }
});

type FakeSession = {
  id: string;
  exec(
    command: string,
    options: { args?: string[]; onOutput?: (output: SandboxExecOutput) => void },
  ): Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }>;
  readFile(path: string): Promise<string>;
  waitReady(timeout?: unknown, signal?: AbortSignal): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  git?: { clone(url: string, options: unknown): Promise<void> };
};

type FakeSessionOptions = {
  waitReady?: (timeout?: unknown, signal?: AbortSignal) => Promise<void>;
  waitReadyError?: Error;
  gitCloneError?: Error;
  readFileContent?: string;
  codexExecResults?: Array<{ exitCode: number; stdout?: string }>;
  codexExecError?: Error;
  writeFileErrorOnCall?: number;
  writeFileError?: Error;
  abortBeforeWriteFileError?: boolean;
  commands?: string[];
};

function fakeRunner(
  sessions: FakeSession[],
  operations: string[],
  options: {
    terminateErrorSessionIds?: Set<string>;
    config?: (config: AppConfig) => void;
    env?: (env: NodeJS.ProcessEnv) => void;
    captureCreates?: Array<Record<string, unknown>>;
    getPullRequestHead?: SandboxWorkerRunnerDeps['getPullRequestHead'];
  } = {},
): SandboxWorkerRunner {
  const config = fakeConfig();
  options.config?.(config);
  const env = fakeEnv(config);
  options.env?.(env);
  let createIndex = 0;
  const provider: SandboxProvider = {
    name: 'Fake',
    apiTarget: 'fake.invalid',
    create: async (createOptions) => {
      const session = sessions[createIndex];
      createIndex += 1;
      if (!session) throw new Error('unexpected extra create');
      options.captureCreates?.push(createOptions);
      operations.push(`create:${session.id}`);
      return session as unknown as SandboxSession;
    },
    waitReady: (session, signal) =>
      (session as unknown as FakeSession).waitReady(undefined, signal),
    terminate: async (session) => {
      operations.push(`terminate:${session.id}`);
      if (options.terminateErrorSessionIds?.has(session.id)) {
        throw new Error('terminate failed');
      }
    },
  };

  return new SandboxWorkerRunner(config, env, provider, {
    sandboxReadyRetryDelayMs: () => 0,
    ...(options.getPullRequestHead ? { getPullRequestHead: options.getPullRequestHead } : {}),
  });
}

function fakeSession(
  id: string,
  operations: string[],
  options: FakeSessionOptions = {},
  controller?: AbortController,
): FakeSession {
  let writeFileCalls = 0;
  let codexCalls = 0;
  return {
    id,
    async exec(
      _command: string,
      _options: { args?: string[]; onOutput?: (output: SandboxExecOutput) => void },
    ) {
      operations.push(`exec:${id}`);
      options.commands?.push([_command, ...(_options.args ?? [])].join(' '));
      const isCodex = (_options.args ?? []).join(' ').includes('exec --json');
      if (isCodex) {
        const scripted = options.codexExecResults?.[codexCalls];
        codexCalls += 1;
        if (scripted) {
          _options.onOutput?.({
            data: new TextEncoder().encode(`${scripted.stdout ?? ''}\n`),
            isStderr: false,
            isFinal: true,
          });
        }
        if (options.codexExecError) throw options.codexExecError;
        if (scripted) return execResult(scripted.exitCode, scripted.stdout ?? '');
      }
      return execResult(0, '');
    },
    async readFile(_path: string) {
      return options.readFileContent ?? 'done';
    },
    async waitReady(timeout?: unknown, signal?: AbortSignal) {
      operations.push(`waitReady:${id}`);
      if (options.waitReady) return options.waitReady(timeout, signal);
      if (options.waitReadyError) throw options.waitReadyError;
    },
    async writeFile(_path: string, _content: string) {
      operations.push(`writeFile:${id}`);
      writeFileCalls += 1;
      if (options.writeFileErrorOnCall === writeFileCalls && options.writeFileError) {
        if (options.abortBeforeWriteFileError) controller?.abort();
        throw options.writeFileError;
      }
    },
    git: {
      async clone(_url: string, _options: unknown) {
        operations.push(`clone:${id}`);
        if (options.gitCloneError) throw options.gitCloneError;
      },
    },
  };
}

function fakeConfig(): AppConfig {
  const config = loadConfig();
  config.worker.codexAuthMode = 'api_key';
  return config;
}

function fakeEnv(config: AppConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  env[config.worker.githubTokenEnv] = 'gh-token';
  env[config.worker.codexApiKeyEnv] = 'codex-key';
  return env;
}

function fakeContext(
  events: Array<{ type: string; data?: Record<string, unknown>; message?: string }>,
  controller = new AbortController(),
  task: SandboxTask = fakeTask(),
  sandboxRun: SandboxRun = fakeSandboxRun(),
  artifacts: Array<{ name: string; content: string }> = [],
): SandboxRunContext {
  return {
    sandboxRun,
    task,
    maxWallClockMs: 1_000,
    signal: controller.signal,
    publishEvent: async (event) => {
      events.push({ type: event.type, data: event.data, message: event.message });
    },
    writeSandboxRunArtifact: async (name, content) => {
      artifacts.push({ name, content: content.toString() });
      return name;
    },
  };
}

function fakeSandboxRun(): SandboxRun {
  return {
    id: 'run-retry-test',
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

function execResult(exitCode: number, stdout: string) {
  const encoder = new TextEncoder();
  return { exitCode, stdout: encoder.encode(stdout), stderr: encoder.encode('') };
}
