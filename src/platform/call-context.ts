/**
 * Adds human-readable context to errors thrown from external service calls.
 *
 * The orchestrator's run-level error catch (`src/dispatcher.ts`) only sees
 * whatever message bubbled up from the worker. Without context, that produces
 * Discord messages like "SSL alert number 80" with no indication of *who*
 * Jardinero was calling or *what step* we were on. This module wraps individual
 * external calls so that, when one fails, the error carries:
 *
 *   - `step`   — what we were trying to do (e.g. "create Tenki sandbox session")
 *   - `target` — who we were calling (e.g. "api.tenki.cloud")
 *   - `cause`  — the original error, preserved for debugging
 *
 * The wrapped error's `.message` is also formatted in a parseable shape so the
 * A notifier can split it back out into fields:
 *
 *   "[step|target] human cause: raw underlying message"
 */

export interface CallContext {
  step: string;
  target: string;
}

export class CallContextError extends Error {
  readonly step: string;
  readonly target: string;
  readonly humanCause: string;
  readonly rawMessage: string;
  readonly causeError: Error;

  constructor(context: CallContext, cause: Error) {
    const rawMessage = cause.message;
    const humanCause = classifyError(rawMessage);
    const message = `[${context.step}|${context.target}] ${humanCause}: ${rawMessage}`;
    super(message);
    this.name = 'CallContextError';
    this.step = context.step;
    this.target = context.target;
    this.humanCause = humanCause;
    this.rawMessage = rawMessage;
    this.causeError = cause;
  }
}

/**
 * Runs `fn()` and, if it throws, wraps the error with the supplied context.
 * Already-wrapped errors are re-thrown unchanged so the innermost context wins.
 */
export async function withCallContext<T>(context: CallContext, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof CallContextError) throw error;
    const cause = error instanceof Error ? error : new Error(String(error));
    throw new CallContextError(context, cause);
  }
}

/**
 * Maps known low-level error message patterns to a human-readable summary.
 * Returns the original message if no pattern matches.
 *
 * Add patterns here as we discover new failure shapes. Keep matches narrow so
 * we don't mis-categorise errors.
 */
export function classifyError(message: string): string {
  if (message.includes('SSL alert number 80') || message.includes('tlsv1 alert internal error')) {
    return 'TLS handshake failed (server-side internal error)';
  }
  if (message.includes('ECONNRESET')) {
    return 'Connection forcibly closed by the other side';
  }
  if (message.includes('NGHTTP2_REFUSED_STREAM')) {
    return 'HTTP/2 stream refused (rate-limited or load-balanced away)';
  }
  if (message.includes('received GOAWAY without any open streams')) {
    return 'HTTP/2 session closed by server';
  }
  if (message.includes('session entered terminal state: TERMINATED')) {
    return 'Tenki session terminated before command execution';
  }
  if (message.includes('session is not ready for command execution')) {
    return 'Tenki session not ready for command execution';
  }
  if (message.includes('ETIMEDOUT') || message.includes('socket hang up')) {
    return 'Network timeout';
  }
  if (message.includes('ENOTFOUND') || message.includes('EAI_AGAIN')) {
    return 'DNS lookup failed';
  }
  if (message.includes('ECONNREFUSED')) {
    return 'Connection refused (service down or unreachable)';
  }
  return 'Call failed';
}

/**
 * Re-builds the structured fields from a string previously produced by
 * `CallContextError.message` (or an equivalent format stored in
 * a run's error). Returns `undefined` if the string doesn't match the
 * expected shape — callers should fall back to treating it as a plain message.
 */
export function parseCallContextMessage(
  message: string,
): { step: string; target: string; humanCause: string; rawMessage: string } | undefined {
  const match = /^\[([^|\]]+)\|([^\]]+)\] ([^:]+): ([\s\S]*)$/.exec(message);
  if (!match) return undefined;
  return {
    step: match[1].trim(),
    target: match[2].trim(),
    humanCause: match[3].trim(),
    rawMessage: match[4].trim(),
  };
}
