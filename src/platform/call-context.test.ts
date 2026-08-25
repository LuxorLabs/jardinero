import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CallContextError,
  classifyError,
  parseCallContextMessage,
  withCallContext,
} from './call-context.js';

describe('CallContextError', () => {
  test('When an error is wrapped then should serialise the step target cause shape', () => {
    const error = new CallContextError(
      { step: 'create Tenki sandbox', target: 'api.tenki.cloud' },
      new Error(
        '001D4F92267F0000:error:0A000438:SSL routines:ssl3_read_bytes:tlsv1 alert internal error',
      ),
    );

    assert.match(
      error.message,
      /^\[create Tenki sandbox\|api\.tenki\.cloud\] TLS handshake failed.*: 001D4F92267F0000/,
    );
  });
});

describe('withCallContext', () => {
  test('When the call succeeds then should pass the value through', async () => {
    assert.equal(await withCallContext({ step: 'noop', target: 'localhost' }, async () => 42), 42);
  });

  test('When the call throws then should wrap it with the step and target', async () => {
    const original = new Error('boom');

    await assert.rejects(
      withCallContext({ step: 'create Tenki sandbox', target: 'api.tenki.cloud' }, async () => {
        throw original;
      }),
      (error: unknown) => {
        assert.ok(error instanceof CallContextError);
        assert.equal(error.step, 'create Tenki sandbox');
        assert.equal(error.target, 'api.tenki.cloud');
        assert.equal(error.rawMessage, 'boom');
        assert.equal(error.causeError, original);
        return true;
      },
    );
  });

  test('When the error is already wrapped then should keep the innermost context', async () => {
    // The inner context is the most specific call site, so it must win.
    await assert.rejects(
      withCallContext({ step: 'outer step', target: 'outer.example.com' }, async () =>
        withCallContext({ step: 'inner step', target: 'inner.example.com' }, async () => {
          throw new Error('root cause');
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof CallContextError);
        assert.equal(error.step, 'inner step');
        assert.equal(error.target, 'inner.example.com');
        return true;
      },
    );
  });
});

describe('classifyError', () => {
  const cases = [
    {
      name: 'When the message is a tls alert then should report a handshake failure',
      message:
        '001D4F92267F0000:error:0A000438:SSL routines:ssl3_read_bytes:tlsv1 alert internal error',
      want: 'TLS handshake failed (server-side internal error)',
    },
    {
      name: 'When the connection was reset then should report it',
      message: 'read ECONNRESET',
      want: 'Connection forcibly closed by the other side',
    },
    {
      name: 'When an http2 stream was refused then should report it',
      message: 'Stream closed with error code NGHTTP2_REFUSED_STREAM',
      want: 'HTTP/2 stream refused (rate-limited or load-balanced away)',
    },
    {
      name: 'When the http2 session closed then should report it',
      message: 'ConnectError: [canceled] received GOAWAY without any open streams',
      want: 'HTTP/2 session closed by server',
    },
    {
      name: 'When the session terminated then should report it',
      message: 'session entered terminal state: TERMINATED',
      want: 'Tenki session terminated before command execution',
    },
    {
      name: 'When the session is not ready then should report it',
      message: '[failed_precondition] session is not ready for command execution',
      want: 'Tenki session not ready for command execution',
    },
    {
      name: 'When the socket hung up then should report a timeout',
      message: 'Error: socket hang up',
      want: 'Network timeout',
    },
    {
      name: 'When dns resolution failed then should report it',
      message: 'getaddrinfo ENOTFOUND api.example.com',
      want: 'DNS lookup failed',
    },
    {
      name: 'When the connection was refused then should report it',
      message: 'connect ECONNREFUSED 127.0.0.1:8080',
      want: 'Connection refused (service down or unreachable)',
    },
    {
      name: 'When no pattern matches then should return a generic label',
      message: 'some unfamiliar gibberish',
      want: 'Call failed',
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.equal(classifyError(c.message), c.want);
    });
  }
});

describe('parseCallContextMessage', () => {
  test('When the message came from a call context error then should round trip it', () => {
    const error = new CallContextError(
      { step: 'wait for Tenki sandbox to become ready', target: 'api.tenki.cloud' },
      new Error('SSL alert number 80'),
    );

    const parsed = parseCallContextMessage(error.message);

    assert.ok(parsed);
    assert.equal(parsed.step, 'wait for Tenki sandbox to become ready');
    assert.equal(parsed.target, 'api.tenki.cloud');
    assert.equal(parsed.humanCause, 'TLS handshake failed (server-side internal error)');
    assert.equal(parsed.rawMessage, 'SSL alert number 80');
  });

  test('When the raw body spans several lines then should keep all of them', () => {
    const parsed = parseCallContextMessage(
      '[create Tenki sandbox|api.tenki.cloud] TLS handshake failed: line one\nline two\nline three',
    );

    assert.ok(parsed);
    assert.equal(parsed.rawMessage, 'line one\nline two\nline three');
  });

  const plainCases = [
    {
      name: 'When the message is plain prose then should return undefined',
      message: 'Run failed before completion.',
    },
    {
      name: 'When the message is a bare reason then should return undefined',
      message: 'wall_clock_budget_exceeded',
    },
    { name: 'When the message is empty then should return undefined', message: '' },
  ];

  for (const c of plainCases) {
    test(c.name, () => {
      assert.equal(parseCallContextMessage(c.message), undefined);
    });
  }
});
