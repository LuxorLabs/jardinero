import { createHmac, timingSafeEqual } from 'node:crypto';

// verifyGitHubSignature checks a delivery against the App's webhook secret: GitHub
// signs the raw body with HMAC-SHA256 and sends it in x-hub-signature-256.
export function verifyGitHubSignature(
  secret: string | undefined,
  body: Buffer,
  header: string | null,
): boolean {
  if (!secret) return false;
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
