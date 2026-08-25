export function nowMs(): number {
  return Date.now();
}

export function dayKey(timestampMs = Date.now()): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

export function minutes(value: number): number {
  return value * 60_000;
}

export function iso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}
