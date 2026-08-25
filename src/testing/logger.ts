import type { Logger } from '../platform/logger.js';

export interface CapturedLogEvent {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields?: Record<string, unknown>;
}

// captureLogs swaps a subsystem's scoped logger for a recorder, so a test can assert
// on the fields a log carries instead of on stdout. A subsystem with more than one
// scope names the one to capture.
export function captureLogs(target: object, field = 'log'): CapturedLogEvent[] {
  const events: CapturedLogEvent[] = [];
  const log: Logger = {
    debug: (message, fields) => events.push({ level: 'debug', message, fields }),
    info: (message, fields) => events.push({ level: 'info', message, fields }),
    warn: (message, fields) => events.push({ level: 'warn', message, fields }),
    error: (message, fields) => events.push({ level: 'error', message, fields }),
    child: () => log,
  };
  (target as Record<string, Logger>)[field] = log;
  return events;
}
