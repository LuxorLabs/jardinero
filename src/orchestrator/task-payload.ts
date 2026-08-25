import type { SandboxTask } from './sandbox-pool.js';

// Typed readers for untyped task payloads. Absent or mistyped values read as
// undefined/empty so prompt builders degrade to their own fallbacks.

export function stringPayload(task: SandboxTask, key: string): string | undefined {
  const value = task.payload[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function numberPayload(task: SandboxTask, key: string): number | undefined {
  const value = task.payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function recordPayload(task: SandboxTask, key: string): Record<string, unknown> | undefined {
  const value = task.payload[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function stringArrayPayload(
  record: Record<string, unknown> | undefined,
  key: string,
): string[] {
  const value = record?.[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}
