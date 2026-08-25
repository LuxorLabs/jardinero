// Run ids are UUIDs minted by the orchestrator; anything else in a path segment
// is a probe, and rejecting it before a query keeps the value out of the audit
// log and the error message.
export function isSafeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
