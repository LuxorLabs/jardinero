import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import {
  configureLokiLogSink,
  flushLokiLogSink,
  flushLokiLogSinkWithDeadline,
  type LogEvent,
  type LokiLogSinkConfig,
  LokiLogSink,
  logger,
  resetLokiLogSink,
} from './logger.js';

describe('resetLokiLogSink', () => {
  test('When the sink is reconfigured then should reset the timestamp watermark', async () => {
    const firstRequests: PushRequest[] = [];
    const firstSink = new LokiLogSink(config({ maxBatchEntries: 1 }), {
      fetch: captureFetch(firstRequests),
    });
    firstSink.enqueue(event({ timestampMs: 2_000 }));
    await firstSink.flush();

    resetLokiLogSink();

    const secondRequests: PushRequest[] = [];
    const secondSink = new LokiLogSink(config({ maxBatchEntries: 1 }), {
      fetch: captureFetch(secondRequests),
    });
    secondSink.enqueue(event({ timestampMs: 1_000 }));
    await secondSink.flush();

    assert.equal(secondRequests[0]?.payload.streams[0]?.values[0]?.[0], '1000000000');
  });

  // A reconfigure has to dispose the previous sink, or its flush timer keeps the
  // process alive and it keeps pushing after the operator turned it off.
  test('When an active sink is reset then should stop pushing', async () => {
    const requests: PushRequest[] = [];
    configureLokiLogSink(config({ maxBatchEntries: 1 }), { fetch: captureFetch(requests) });

    resetLokiLogSink();
    logger.info('after reset');
    await flushLokiLogSink();

    assert.deepEqual(requests, []);
  });
});

// The line a sink pushes is what an operator greps in Loki, so its shape is part of
// the contract: the event envelope plus a nested `fields` record, and an Error
// serialized as a readable object instead of the `{}` JSON.stringify would give.
describe('the pushed log line', () => {
  const cases: Array<{
    name: string;
    fields?: Record<string, unknown>;
    check(line: { timestamp: string; fields?: Record<string, unknown> }): void;
  }> = [
    {
      // An event with no fields still carries an empty record, so a consumer never
      // has to guard the key.
      name: 'When the event carries no fields then should still carry the envelope',
      check: (line) => {
        assert.match(line.timestamp, /^\d{4}-\d{2}-\d{2}T/);
        assert.deepEqual(line.fields, {});
      },
    },
    {
      name: 'When the event carries scalar fields then should keep them as they are',
      fields: { run_id: 'run-1', attempt: 2, dry_run: false },
      check: (line) =>
        assert.deepEqual(line.fields, { run_id: 'run-1', attempt: 2, dry_run: false }),
    },
    {
      name: 'When a field is an error then should keep its name, message and stack',
      fields: { error: Object.assign(new Error('boom'), { stack: 'Error: boom at x' }) },
      check: (line) =>
        assert.deepEqual(line.fields?.error, {
          name: 'Error',
          message: 'boom',
          stack: 'Error: boom at x',
        }),
    },
    {
      // A field that cannot be serialized must not lose the whole line: the
      // envelope survives and the failure is stated in place of the fields.
      name: 'When a field cannot be serialized then should keep the envelope and flag it',
      fields: {
        get exploding() {
          throw new Error('cannot read this');
        },
      },
      check: (line) => assert.deepEqual(line.fields, { serialization_error: true }),
    },
    {
      name: 'When a field is a nested object then should keep its shape',
      fields: { budget: { maxWallClockMs: 1000 } },
      check: (line) => assert.deepEqual(line.fields?.budget, { maxWallClockMs: 1000 }),
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const requests: PushRequest[] = [];
      const sink = new LokiLogSink(config({ maxBatchEntries: 1 }), {
        fetch: captureFetch(requests),
      });

      sink.enqueue(event({ fields: testCase.fields }));
      await sink.flush();

      const raw = requests[0]?.payload.streams[0]?.values[0]?.[1];
      assert.ok(raw, 'the sink should have pushed a line');
      testCase.check(JSON.parse(raw) as Parameters<(typeof testCase)['check']>[0]);
    });
  }
});

describe('LokiLogSink', () => {
  test('When events are pushed then should send streams with stable labels', async () => {
    const requests: PushRequest[] = [];
    const sink = new LokiLogSink(
      config({
        labels: {
          app: 'wrong',
          env: 'staging',
          level: 'wrong',
          scope: 'wrong',
          team: 'platform',
        },
        maxBatchEntries: 1,
      }),
      { fetch: captureFetch(requests), env: {} },
    );

    sink.enqueue(event({ fields: { run_id: 'run-1', nested: { ok: true } } }));
    await sink.flush();

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, 'https://loki.example.test/loki/api/v1/push');
    assert.equal(requests[0]?.init.method, 'POST');
    assert.equal(header(requests[0]?.init.headers, 'content-type'), 'application/json');

    const stream = requests[0]?.payload.streams[0];
    assert.deepEqual(stream?.stream, {
      app: 'jardinero',
      env: 'staging',
      level: 'info',
      scope: 'worker',
      team: 'platform',
    });
    const value = stream?.values[0];
    assert.match(value?.[0] ?? '', /^\d+$/);
    assert.equal(typeof value?.[1], 'string');
    const line = JSON.parse(value?.[1] ?? '{}') as Record<string, unknown>;
    assert.equal(line.message, 'hello');
    assert.equal(line.level, 'info');
    assert.equal(line.scope, 'worker');
    assert.deepEqual(line.fields, { run_id: 'run-1', nested: { ok: true } });
    assert.equal(value?.[1].includes('\x1b['), false);
  });

  test('When a `min_level` is set then should filter independently of the terminal level', async () => {
    const requests: PushRequest[] = [];
    configureLokiLogSink(config({ minLevel: 'debug', maxBatchEntries: 1 }), {
      fetch: captureFetch(requests),
    });
    try {
      logger.child('loki-only').debug('terminal hidden by node test context');
      await flushLokiLogSink();
    } finally {
      resetLokiLogSink();
    }

    const line = JSON.parse(requests[0]?.payload.streams[0]?.values[0]?.[1] ?? '{}') as {
      message?: string;
    };
    assert.equal(line.message, 'terminal hidden by node test context');
  });

  test('When the `min_level` is silent then should drop every event', async () => {
    const requests: PushRequest[] = [];
    const sink = new LokiLogSink(config({ minLevel: 'warn' }), {
      fetch: captureFetch(requests),
    });

    sink.enqueue(event({ level: 'debug', message: 'debug' }));
    sink.enqueue(event({ level: 'info', message: 'info' }));
    sink.enqueue(event({ level: 'warn', message: 'warn' }));
    sink.enqueue(event({ level: 'error', message: 'error' }));
    await sink.flush();

    const messages = requests[0]?.payload.streams
      .flatMap((stream) => stream.values)
      .map(([, line]) => JSON.parse(line).message);
    assert.deepEqual(messages, ['warn', 'error']);

    const silentRequests: PushRequest[] = [];
    const silentSink = new LokiLogSink(config({ minLevel: 'silent' }), {
      fetch: captureFetch(silentRequests),
    });
    silentSink.enqueue(event({ level: 'error', message: 'not shipped' }));
    await silentSink.flush();

    assert.equal(silentRequests.length, 0);
  });

  test('When the `push_url` already has the path then should accept it', async () => {
    const requests: PushRequest[] = [];
    const sink = new LokiLogSink(
      config({ pushUrl: 'https://loki.example.test/custom/loki/api/v1/push' }),
      { fetch: captureFetch(requests) },
    );

    sink.enqueue(event());
    await sink.flush();

    assert.equal(requests[0]?.url, 'https://loki.example.test/custom/loki/api/v1/push');
  });

  test('When the batch reaches its max entries then should flush', async () => {
    const requests: PushRequest[] = [];
    const sink = new LokiLogSink(config({ maxBatchEntries: 2, flushIntervalMs: 60_000 }), {
      fetch: captureFetch(requests),
    });

    sink.enqueue(event({ message: 'one' }));
    assert.equal(requests.length, 0);
    sink.enqueue(event({ message: 'two' }));
    await eventually(() => requests.length === 1);

    const values = requests[0]?.payload.streams.flatMap((stream) => stream.values) ?? [];
    assert.equal(values.length, 2);
  });

  test('When the flush interval elapses then should flush pending entries', async () => {
    const requests: PushRequest[] = [];
    const sink = new LokiLogSink(config({ maxBatchEntries: 10, flushIntervalMs: 10 }), {
      fetch: captureFetch(requests),
    });

    sink.enqueue(event());
    await eventually(() => requests.length === 1);

    assert.equal(requests[0]?.payload.streams[0]?.values.length, 1);
  });

  // Retrying a 4xx cannot fix it, so only a 5xx consumes the attempt budget.
  const pushFailureCases: Array<{ name: string; status: number; wantAttempts: number }> = [
    {
      name: 'When a push keeps failing with a 5xx then should retry up to the cap and then discard',
      status: 503,
      wantAttempts: 3,
    },
    {
      name: 'When the push fails with a 4xx then should not retry',
      status: 401,
      wantAttempts: 1,
    },
  ];

  for (const testCase of pushFailureCases) {
    test(testCase.name, async () => {
      let attempts = 0;
      const sink = new LokiLogSink(
        config({ maxRetryAttempts: 3, retryInitialMs: 1, maxRetryMs: 1, maxBatchEntries: 1 }),
        {
          fetch: (async () => {
            attempts += 1;
            return new Response('', { status: testCase.status });
          }) as typeof fetch,
        },
      );

      sink.enqueue(event());
      await sink.flush();
      await sink.flush();

      assert.equal(attempts, testCase.wantAttempts);
    });
  }

  test('When the buffer is full then should drop the oldest entries', async () => {
    const requests: PushRequest[] = [];
    const sink = new LokiLogSink(config({ maxBatchEntries: 10, maxBufferEntries: 2 }), {
      fetch: captureFetch(requests),
    });

    sink.enqueue(event({ message: 'one' }));
    sink.enqueue(event({ message: 'two' }));
    sink.enqueue(event({ message: 'three' }));
    await sink.flush();

    const lines = requests[0]?.payload.streams.flatMap((stream) =>
      stream.values.map(([, line]) => JSON.parse(line).message),
    );
    assert.deepEqual(lines, ['two', 'three']);
  });

  test('When auth is missing or fetch fails then should not throw', async () => {
    const sink = new LokiLogSink(config({ authEnv: 'MISSING_TOKEN', maxRetryAttempts: 1 }), {
      env: {},
      fetch: (async () => {
        throw new Error('network unavailable');
      }) as typeof fetch,
    });

    assert.doesNotThrow(() => sink.enqueue(event()));
    await assert.doesNotReject(() => sink.flush());
  });

  test('When a push stalls then should still resolve the flush', async () => {
    let calls = 0;
    let receivedSignal = false;
    configureLokiLogSink(config({ maxRetryAttempts: 1, pushTimeoutMs: 1 }), {
      fetch: ((_url, init = {}) => {
        calls += 1;
        receivedSignal = init.signal instanceof AbortSignal;
        return new Promise<Response>(() => {
          // Simulate a stalled fetch implementation that never settles and does
          // not honor AbortSignal.
        });
      }) as typeof fetch,
    });

    try {
      logger.child('stalled-loki').info('flush should be bounded');
      const startedAt = Date.now();
      await assert.doesNotReject(() => flushLokiLogSink());

      assert.equal(calls, 1);
      assert.equal(receivedSignal, true);
      assert.equal(Date.now() - startedAt < 250, true);
    } finally {
      resetLokiLogSink();
    }
  });

  test('When events share a millisecond then should keep timestamps distinct', async () => {
    const requests: PushRequest[] = [];
    const sink = new LokiLogSink(config({ maxBatchEntries: 2 }), {
      fetch: captureFetch(requests),
    });

    sink.enqueue(event({ timestampMs: 1_700_000_000_000 }));
    sink.enqueue(event({ timestampMs: 1_700_000_000_000 }));
    await sink.flush();

    const timestamps = requests[0]?.payload.streams.flatMap((stream) =>
      stream.values.map(([timestamp]) => timestamp),
    );
    assert.equal(timestamps?.length, 2);
    assert.match(timestamps?.[0] ?? '', /^\d+$/);
    assert.match(timestamps?.[1] ?? '', /^\d+$/);
    assert.notEqual(timestamps?.[0], timestamps?.[1]);
  });

  test('When the sink is reconfigured then should reset the timestamp watermark', async () => {
    const firstRequests: PushRequest[] = [];
    const firstSink = configureLokiLogSink(config({ maxBatchEntries: 1 }), {
      fetch: captureFetch(firstRequests),
    });

    try {
      firstSink?.enqueue(event({ timestampMs: 2_000 }));
      await flushLokiLogSink();

      const secondRequests: PushRequest[] = [];
      const secondSink = configureLokiLogSink(config({ maxBatchEntries: 1 }), {
        fetch: captureFetch(secondRequests),
      });
      secondSink?.enqueue(event({ timestampMs: 1_000 }));
      await flushLokiLogSink();

      assert.equal(secondRequests[0]?.payload.streams[0]?.values[0]?.[0], '1000000000');
    } finally {
      resetLokiLogSink();
    }
  });

  test('When an event timestamp is not an integer then should tolerate it', async () => {
    const requests: PushRequest[] = [];
    const sink = new LokiLogSink(config({ maxBatchEntries: 1 }), { fetch: captureFetch(requests) });

    // Build the event inline: the event() helper itself does BigInt(timestampMs).
    // A fractional ms must reach nextTimestampNs and ship with a valid
    // decimal-nanosecond timestamp instead of being silently dropped.
    sink.enqueue({
      timestampMs: 1_700_000_000_123.5,
      timestampNs: '',
      level: 'info',
      scope: 'worker',
      message: 'fractional timestamp',
    });
    await sink.flush();

    const timestamp = requests[0]?.payload.streams[0]?.values[0]?.[0];
    assert.match(timestamp ?? '', /^\d+$/);
  });

  test('When the sink is disposed then should ignore further events', async () => {
    const requests: PushRequest[] = [];
    const sink = new LokiLogSink(config({ maxBatchEntries: 1 }), { fetch: captureFetch(requests) });

    sink.dispose();
    // Without the disposed guard this would re-queue, hit the batch threshold, and
    // trigger a fetch on a sink that has already been shut down.
    sink.enqueue(event());
    await sink.flush();

    assert.equal(requests.length, 0);
  });
});

describe('logger', () => {
  test('When the root logger emits then should use a stable scope', async () => {
    const requests: PushRequest[] = [];
    configureLokiLogSink(config({ maxBatchEntries: 1, authEnv: 'LOKI_TOKEN' }), {
      fetch: captureFetch(requests),
      env: { LOKI_TOKEN: 'secret-token' },
    });
    try {
      logger.info('root event');
      await flushLokiLogSink();
    } finally {
      configureLokiLogSink(config({ enabled: false }));
    }

    const stream = requests[0]?.payload.streams[0];
    assert.equal(stream?.stream.scope, 'root');
    assert.equal(header(requests[0]?.init.headers, 'authorization'), 'Bearer secret-token');
  });

  test('When loki is disabled then should keep terminal output unchanged', () => {
    const script = `
Date.now = () => 1704067200123;
const { configureLokiLogSink, logger } = await import('./dist/src/platform/logger.js');
configureLokiLogSink({
  enabled: false,
  pushUrl: '',
  authEnv: '',
  labels: {},
  minLevel: 'debug',
  maxBatchEntries: 100,
  flushIntervalMs: 5000,
  maxBufferEntries: 1000,
  maxRetryAttempts: 1,
  retryInitialMs: 1,
  maxRetryMs: 1,
  pushTimeoutMs: 10000,
});
const scoped = logger.child('api');
scoped.info('hello', { a: 1, b: 'two words' });
scoped.warn('careful', { bad: true });
`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LOG_LEVEL: 'debug',
        NO_COLOR: '1',
        LOG_NO_COLOR: undefined,
        NODE_TEST_CONTEXT: undefined,
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '00:00:00.123 INFO  [api] hello a=1 b="two words"\n');
    assert.equal(result.stderr, '00:00:00.123 WARN  [api] careful bad=true\n');
  });
});

describe('configureLokiLogSink', () => {
  test('When the sink is disabled then should leave no timers or requests', async () => {
    const requests: PushRequest[] = [];
    let timerCount = 0;
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      timerCount += 1;
      return originalSetTimeout(...args);
    }) as typeof setTimeout;

    try {
      configureLokiLogSink(config({ enabled: false }), { fetch: captureFetch(requests) });
      logger.child('disabled').debug('debug hidden from terminal but still a logger call');
      logger.child('disabled').info('info hidden under node test context');
      logger.child('disabled').warn('warn hidden under node test context');
      logger.child('disabled').error('error hidden under node test context');
      await flushLokiLogSink();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      resetLokiLogSink();
    }

    assert.equal(timerCount, 0);
    assert.equal(requests.length, 0);
  });

  test('When the `push_url` is invalid then should degrade to disabled', () => {
    try {
      const sink = configureLokiLogSink(config({ pushUrl: 'notaurl' }));
      assert.equal(sink, undefined);
      // Logging must stay safe even though the sink failed to construct.
      assert.doesNotThrow(() => logger.child('degraded').info('logging stays safe'));
    } finally {
      resetLokiLogSink();
    }
  });
});

describe('flushLokiLogSinkWithDeadline', () => {
  test('When batches stall at shutdown then should bound the drain', async () => {
    let calls = 0;
    configureLokiLogSink(
      config({ maxBatchEntries: 1, maxBufferEntries: 100, maxRetryMs: 60_000 }),
      {
        fetch: (() => {
          calls += 1;
          return new Promise<Response>(() => {
            // Simulate a stalled Loki client; shutdown must continue on its own
            // deadline instead of waiting for this request or later queued batches.
          });
        }) as typeof fetch,
      },
    );

    try {
      const scoped = logger.child('shutdown-loki');
      for (let index = 0; index < 50; index += 1) {
        scoped.info('queued shutdown log', { index });
      }

      const startedAt = Date.now();
      await assert.doesNotReject(() => flushLokiLogSinkWithDeadline(20));

      assert.equal(calls, 1);
      assert.equal(Date.now() - startedAt < 250, true);
    } finally {
      resetLokiLogSink();
    }
  });

  test('When the deadline passes then should cancel pending retry waits', async () => {
    let calls = 0;
    configureLokiLogSink(
      config({
        maxBatchEntries: 100,
        flushIntervalMs: 60_000,
        maxRetryAttempts: 3,
        retryInitialMs: 20,
        maxRetryMs: 20,
      }),
      {
        fetch: (async () => {
          calls += 1;
          return new Response('', { status: 503 });
        }) as typeof fetch,
      },
    );

    try {
      logger.child('shutdown-loki').info('queued retrying log');
      await assert.doesNotReject(() => flushLokiLogSinkWithDeadline(1));
      await new Promise((resolve) => setTimeout(resolve, 60));

      assert.equal(calls, 1);
    } finally {
      resetLokiLogSink();
    }
  });
});

interface PushRequest {
  url: string;
  init: RequestInit;
  payload: {
    streams: Array<{
      stream: Record<string, string>;
      values: [string, string][];
    }>;
  };
}

function config(overrides: Partial<LokiLogSinkConfig> = {}): LokiLogSinkConfig {
  return {
    enabled: true,
    pushUrl: 'https://loki.example.test',
    authEnv: '',
    labels: { app: 'jardinero', env: 'test' },
    minLevel: 'debug',
    maxBatchEntries: 100,
    flushIntervalMs: 5_000,
    maxBufferEntries: 1_000,
    maxRetryAttempts: 1,
    retryInitialMs: 1,
    maxRetryMs: 1,
    pushTimeoutMs: 10_000,
    ...overrides,
  };
}

function event(overrides: Partial<LogEvent> = {}): LogEvent {
  const timestampMs = overrides.timestampMs ?? Date.now();
  return {
    timestampMs,
    timestampNs: `${BigInt(timestampMs) * 1_000_000n}`,
    level: 'info',
    scope: 'worker',
    message: 'hello',
    ...overrides,
  };
}

function captureFetch(requests: PushRequest[]): typeof fetch {
  return (async (url, init = {}) => {
    const body = init.body?.toString() ?? '';
    requests.push({
      url: String(url),
      init,
      payload: JSON.parse(body),
    });
    return new Response('', { status: 204 });
  }) as typeof fetch;
}

function header(headers: RequestInit['headers'], name: string): string | undefined {
  if (!headers) return undefined;
  return new Headers(headers).get(name) ?? undefined;
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true);
}
