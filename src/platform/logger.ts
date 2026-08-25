import { setTimeout as delay } from 'node:timers/promises';

import { iso, nowMs } from './time.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

type EmitLevel = Exclude<LogLevel, 'silent'>;

export interface LokiLogSinkConfig {
  enabled: boolean;
  pushUrl: string;
  authEnv: string;
  labels: Record<string, string>;
  minLevel: LogLevel;
  maxBatchEntries: number;
  flushIntervalMs: number;
  maxBufferEntries: number;
  maxRetryAttempts: number;
  retryInitialMs: number;
  maxRetryMs: number;
  pushTimeoutMs: number;
}

export interface LokiLogSinkOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

export interface LogEvent {
  timestampMs: number;
  // Optional on input: LokiLogSink.enqueue() always assigns the canonical,
  // monotonic value via nextTimestampNs(), discarding any caller-supplied one.
  timestampNs?: string;
  level: EmitLevel;
  scope: string;
  message: string;
  fields?: Record<string, unknown>;
}

// A queued event after enqueue() has stamped its monotonic timestampNs.
interface QueuedEvent extends LogEvent {
  timestampNs: string;
}

interface LokiStreamEntry {
  stream: Record<string, string>;
  values: [string, string][];
}

const LEVEL_WEIGHT: Record<EmitLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const THRESHOLD: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: Number.POSITIVE_INFINITY,
};

const LEVEL_TAG: Record<EmitLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

const COLOR: Record<EmitLevel | 'scope' | 'dim' | 'reset', string> = {
  debug: '\x1b[90m', // gray
  info: '\x1b[36m', // cyan
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
  scope: '\x1b[35m', // magenta
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

const FIELD_VALUE_LIMIT = 240;
// Cap the joined fields so a single event carrying a large structured payload
// (e.g. a worker's full codex result) cannot flood a terminal line.
const FIELDS_TOTAL_LIMIT = 600;
const ROOT_SCOPE = 'root';
const LOKI_PUSH_PATH = '/loki/api/v1/push';
const LOKI_PUSH_TIMEOUT_CAP_MS = 10_000;
export const LOKI_FINAL_FLUSH_DEADLINE_MS = 2_000;

function resolveLevel(env: NodeJS.ProcessEnv): LogLevel {
  const raw = env.LOG_LEVEL?.trim().toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' || raw === 'silent') {
    return raw;
  }
  // Stay quiet under the node:test runner unless a level is explicitly requested,
  // so the test output is not flooded with orchestrator logs.
  if (env.NODE_TEST_CONTEXT) return 'silent';
  return 'info';
}

const activeThreshold = THRESHOLD[resolveLevel(process.env)];
const useColor =
  process.env.NO_COLOR === undefined &&
  process.env.LOG_NO_COLOR === undefined &&
  process.stdout.isTTY === true;

function paint(color: string, text: string): string {
  return useColor ? `${color}${text}${COLOR.reset}` : text;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    const compact = value.replace(/\s+/g, ' ').trim();
    const clipped =
      compact.length > FIELD_VALUE_LIMIT ? `${compact.slice(0, FIELD_VALUE_LIMIT - 1)}…` : compact;
    return /\s/.test(clipped) || clipped.length === 0 ? JSON.stringify(clipped) : clipped;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? String(value);
  } catch {
    serialized = String(value);
  }
  return serialized.length > FIELD_VALUE_LIMIT
    ? `${serialized.slice(0, FIELD_VALUE_LIMIT - 1)}…`
    : serialized;
}

function formatFields(fields?: Record<string, unknown>): string {
  if (!fields) return '';
  const entries = Object.entries(fields).filter(
    ([, value]) => value !== undefined && value !== null,
  );
  const parts: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const [key, value] of entries) {
    const rendered = `${key}=${formatValue(value)}`;
    // Always keep the first field (its value is already capped); stop once the
    // running total would exceed the budget and report how many were dropped.
    if (parts.length > 0 && used + rendered.length + 1 > FIELDS_TOTAL_LIMIT) {
      dropped = entries.length - parts.length;
      break;
    }
    parts.push(rendered);
    used += rendered.length + 1;
  }
  if (dropped > 0) parts.push(`…(+${dropped} more)`);
  return parts.length === 0 ? '' : ` ${paint(COLOR.dim, parts.join(' '))}`;
}

let lokiSink: LokiLogSink | undefined;
let lastTimestampNs = 0n;

export function configureLokiLogSink(
  config: LokiLogSinkConfig,
  options: LokiLogSinkOptions = {},
): LokiLogSink | undefined {
  lokiSink?.dispose();
  lastTimestampNs = 0n;
  if (!config.enabled) {
    lokiSink = undefined;
    return undefined;
  }
  try {
    lokiSink = new LokiLogSink(config, options);
  } catch (error) {
    // Constructing the sink can throw (e.g. an invalid push URL). Loki is
    // best-effort observability, so degrade to no sink rather than crashing the
    // process at boot, and surface why.
    lokiSink = undefined;
    logger.warn('loki log sink disabled: invalid configuration', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return lokiSink;
}

export function resetLokiLogSink(): void {
  lokiSink?.dispose();
  lokiSink = undefined;
  lastTimestampNs = 0n;
}

export async function flushLokiLogSink(): Promise<void> {
  await lokiSink?.flush();
}

export async function flushLokiLogSinkWithDeadline(
  deadlineMs = LOKI_FINAL_FLUSH_DEADLINE_MS,
): Promise<void> {
  const activeSink = lokiSink;
  if (!activeSink) return;
  if (deadlineMs <= 0) {
    activeSink.dispose();
    if (lokiSink === activeSink) lokiSink = undefined;
    return;
  }

  let timeout: NodeJS.Timeout | undefined;
  let deadlineReached = false;
  try {
    await Promise.race([
      activeSink.flush(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          deadlineReached = true;
          resolve();
        }, deadlineMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (deadlineReached) {
      // Terminal flush gave up: dispose the sink and release the global handle
      // so "after the final flush there is no active sink" is an invariant, not
      // something the disposed guard has to keep papering over. The identity
      // check avoids clobbering a sink swapped in by a concurrent reconfigure.
      activeSink.dispose();
      if (lokiSink === activeSink) lokiSink = undefined;
    }
  }
}

export class LokiLogSink {
  private readonly pushUrl: string;
  private readonly authorization: string | undefined;
  private readonly labels: Record<string, string>;
  private readonly envLabel: string;
  private readonly fetchImpl: typeof fetch;
  private readonly minLevelWeight: number;
  private readonly pushTimeoutMs: number;
  private queue: QueuedEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private drainPromise: Promise<void> | undefined;
  private drainController: AbortController | undefined;
  private disposed = false;

  constructor(
    private readonly config: LokiLogSinkConfig,
    options: LokiLogSinkOptions = {},
  ) {
    this.pushUrl = resolveLokiPushUrl(config.pushUrl);
    const env = options.env ?? process.env;
    const token = config.authEnv ? env[config.authEnv]?.trim() : undefined;
    this.authorization = token ? `Bearer ${token}` : undefined;
    this.labels = { ...config.labels };
    this.envLabel = this.labels.env?.trim() || env.NODE_ENV?.trim() || 'development';
    this.fetchImpl = options.fetch ?? fetch;
    this.minLevelWeight = THRESHOLD[config.minLevel];
    this.pushTimeoutMs = Math.max(1, Math.min(config.pushTimeoutMs, LOKI_PUSH_TIMEOUT_CAP_MS));
  }

  enqueue(event: LogEvent): void {
    if (this.disposed) return;
    try {
      if (LEVEL_WEIGHT[event.level] < this.minLevelWeight) return;
      this.queue.push({ ...event, timestampNs: nextTimestampNs(event.timestampMs) });
      while (this.queue.length > this.config.maxBufferEntries) this.queue.shift();
      if (this.queue.length >= this.config.maxBatchEntries) {
        this.clearTimer();
        this.triggerDrain();
        return;
      }
      this.ensureTimer();
    } catch {
      // Loki is best-effort observability; logger callers must never observe
      // sink failures.
    }
  }

  async flush(): Promise<void> {
    try {
      this.clearTimer();
      await this.startDrain();
    } catch {
      // Best-effort shutdown flushing must not mask the original shutdown path.
    }
  }

  dispose(): void {
    try {
      // Mark disposed first so a queued drain microtask or timer callback that
      // fires after this becomes a no-op instead of resurrecting drain state on a
      // sink that has already been replaced or shut down.
      this.disposed = true;
      this.clearTimer();
      this.drainController?.abort();
      this.queue = [];
    } catch {
      // Disposal is best-effort cleanup, just like delivery.
    }
  }

  private ensureTimer(): void {
    if (this.disposed || this.timer || this.queue.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.triggerDrain();
    }, this.config.flushIntervalMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private triggerDrain(): void {
    queueMicrotask(() => {
      if (this.disposed) return;
      void this.startDrain();
    });
  }

  private startDrain(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.drainPromise) {
      const controller = new AbortController();
      this.drainController = controller;
      this.drainPromise = this.drain(controller.signal).finally(() => {
        if (this.drainController === controller) this.drainController = undefined;
        this.drainPromise = undefined;
        if (this.queue.length > 0) this.ensureTimer();
      });
    }
    return this.drainPromise;
  }

  private async drain(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted && this.queue.length > 0) {
        const batch = this.queue.splice(0, this.config.maxBatchEntries);
        await this.sendWithRetries(batch, signal);
      }
    } catch {
      // Drop the failed batch after retry exhaustion or serialization failure.
    }
  }

  private async sendWithRetries(batch: QueuedEvent[], signal: AbortSignal): Promise<void> {
    const body = JSON.stringify({ streams: this.toStreams(batch) });
    for (let attempt = 1; attempt <= this.config.maxRetryAttempts; attempt += 1) {
      if (signal.aborted) return;
      try {
        const response = await this.pushOnce(body, signal);
        if (response.ok) return;
        // Terminal client errors won't succeed on retry (RFC 7231 §6.5), so drop
        // the batch immediately instead of burning the retry budget while the
        // buffer evicts. 408 (timeout) and 429 (rate limited) stay retryable.
        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408 &&
          response.status !== 429
        ) {
          return;
        }
      } catch {
        // Retry below.
      }
      if (signal.aborted) return;
      if (attempt < this.config.maxRetryAttempts) {
        // node:timers/promises setTimeout rejects with an AbortError when the
        // signal fires; swallow it so an aborted retry wait just resolves, and
        // ref:false keeps the wait from holding the event loop open (as the old
        // hand-rolled sleep did via unref).
        await delay(this.retryDelayMs(attempt), undefined, { signal, ref: false }).catch(() => {});
      }
    }
  }

  private async pushOnce(body: string, signal: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      const cancel = () => {
        controller.abort();
        reject(new Error('Loki push cancelled'));
      };
      if (signal.aborted) {
        cancel();
        return;
      }
      abortListener = cancel;
      signal.addEventListener('abort', cancel, { once: true });
    });
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('Loki push timed out'));
      }, this.pushTimeoutMs);
      timeout.unref?.();
    });

    try {
      return await Promise.race([
        this.fetchImpl(this.pushUrl, {
          method: 'POST',
          headers: this.headers(),
          body,
          signal: controller.signal,
        }),
        timedOut,
        cancelled,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abortListener) signal.removeEventListener('abort', abortListener);
    }
  }

  private retryDelayMs(attempt: number): number {
    return Math.min(this.config.maxRetryMs, this.config.retryInitialMs * 2 ** (attempt - 1));
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.authorization) headers.authorization = this.authorization;
    return headers;
  }

  private toStreams(batch: QueuedEvent[]): LokiStreamEntry[] {
    const streams = new Map<string, LokiStreamEntry>();
    for (const event of batch) {
      const streamLabels = this.streamLabels(event);
      const key = JSON.stringify(
        Object.entries(streamLabels).sort(([a], [b]) => a.localeCompare(b)),
      );
      const stream = streams.get(key) ?? { stream: streamLabels, values: [] };
      stream.values.push([event.timestampNs, serializeLogLine(event)]);
      streams.set(key, stream);
    }
    return [...streams.values()];
  }

  private streamLabels(event: LogEvent): Record<string, string> {
    return {
      ...this.labels,
      app: 'jardinero',
      env: this.envLabel,
      level: event.level,
      scope: event.scope || ROOT_SCOPE,
    };
  }
}

function resolveLokiPushUrl(value: string): string {
  const url = new URL(value);
  const normalizedPath = url.pathname.replace(/\/+$/, '');
  if (normalizedPath.endsWith(LOKI_PUSH_PATH)) {
    url.pathname = normalizedPath;
    return url.toString();
  }
  url.pathname = `${normalizedPath}${LOKI_PUSH_PATH}`;
  return url.toString();
}

function nextTimestampNs(timestampMs: number): string {
  // Guard the public LogEvent API: a non-integer or non-finite timestampMs would
  // make BigInt(...) throw. Coerce to a safe integer so a bad timestamp gets a
  // monotonic bump instead of being silently dropped by enqueue's catch.
  const ms = Number.isFinite(timestampMs) ? Math.trunc(timestampMs) : 0;
  const candidate = BigInt(ms) * 1_000_000n;
  lastTimestampNs = candidate > lastTimestampNs ? candidate : lastTimestampNs + 1n;
  return lastTimestampNs.toString();
}

function serializeLogLine(event: LogEvent): string {
  try {
    return JSON.stringify(
      {
        timestamp: iso(event.timestampMs),
        level: event.level,
        scope: event.scope,
        message: event.message,
        fields: safeFields(event.fields),
      },
      jsonReplacer(),
    );
  } catch {
    return JSON.stringify({
      timestamp: iso(event.timestampMs),
      level: event.level,
      scope: event.scope,
      message: event.message,
      fields: { serialization_error: true },
    });
  }
}

function safeFields(fields?: Record<string, unknown>): Record<string, unknown> {
  if (!fields) return {};
  return fields;
}

function jsonReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, value) => {
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  };
}

function emit(
  scope: string | undefined,
  level: EmitLevel,
  message: string,
  fields?: Record<string, unknown>,
): void {
  const timestampMs = nowMs();
  if (LEVEL_WEIGHT[level] >= activeThreshold) {
    const time = paint(COLOR.dim, iso(timestampMs).slice(11, 23));
    const tag = paint(COLOR[level], LEVEL_TAG[level]);
    const scopeTag = scope ? ` ${paint(COLOR.scope, `[${scope}]`)}` : '';
    const line = `${time} ${tag}${scopeTag} ${message}${formatFields(fields)}\n`;
    const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
    stream.write(line);
  }
  lokiSink?.enqueue({
    timestampMs,
    level,
    scope: scope || ROOT_SCOPE,
    message,
    fields,
  });
}

function makeLogger(scope?: string): Logger {
  return {
    debug: (message, fields) => emit(scope, 'debug', message, fields),
    info: (message, fields) => emit(scope, 'info', message, fields),
    warn: (message, fields) => emit(scope, 'warn', message, fields),
    error: (message, fields) => emit(scope, 'error', message, fields),
    child: (childScope) => makeLogger(scope ? `${scope}:${childScope}` : childScope),
  };
}

export const logger = makeLogger();
