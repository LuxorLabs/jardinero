export function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!isPlainObject(parsed)) {
    throw new Error('Expected JSON object');
  }
  return parsed;
}

// The building block for every guard below: a non-null, non-array object. Array.isArray
// is the load-bearing check, since `typeof [] === 'object'` and arrays would otherwise pass.
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function objectValue(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// GitHub numeric identifiers (PR numbers, comment ids) are always positive; reject
// zero, negatives, and non-integers so a malformed API payload can't slip through.
export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
