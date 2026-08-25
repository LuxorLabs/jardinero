import { createHmac, timingSafeEqual } from 'node:crypto';

// verifyLinearSignature checks a delivery against the webhook secret: Linear signs the
// raw body with HMAC-SHA256, hex and unprefixed, in linear-signature.
export function verifyLinearSignature(
  secret: string | undefined,
  body: Buffer,
  header: string | null,
): boolean {
  if (!secret || !header) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('hex'));
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// isFreshLinearWebhookTimestamp is the replay guard: the signed body carries a
// webhookTimestamp that Linear documents as within about a minute of receipt.
export function isFreshLinearWebhookTimestamp(
  timestamp: unknown,
  nowMs: number,
  toleranceMs = 60_000,
): boolean {
  return (
    typeof timestamp === 'number' &&
    Number.isFinite(timestamp) &&
    Math.abs(nowMs - timestamp) <= toleranceMs
  );
}
