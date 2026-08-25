import { createPublicKey, verify } from 'node:crypto';

// 32 raw bytes of key and 64 of signature, hex-encoded.
const ED25519_PUBLIC_KEY_HEX_LENGTH = 64;
const ED25519_SIGNATURE_HEX_LENGTH = 128;

// verifyDiscordSignature checks an interaction against the application's public key.
// Unlike GitHub and Linear, Discord signs with Ed25519 rather than HMAC, over the ASCII
// timestamp header followed by the raw body. A malformed key or signature answers false
// instead of throwing, so an unauthenticated caller can never take the process down.
export function verifyDiscordSignature(
  publicKeyHex: string | undefined,
  body: Buffer,
  signature: string | null,
  timestamp: string | null,
): boolean {
  if (!publicKeyHex || !signature || !timestamp) return false;
  if (publicKeyHex.length !== ED25519_PUBLIC_KEY_HEX_LENGTH) return false;
  if (signature.length !== ED25519_SIGNATURE_HEX_LENGTH) return false;

  const publicKeyBytes = decodeHex(publicKeyHex);
  const signatureBytes = decodeHex(signature);
  if (!publicKeyBytes || !signatureBytes) return false;

  const publicKey = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyBytes.toString('base64url') },
    format: 'jwk',
  });
  // Ed25519 carries its own digest, which is what the null algorithm says here.
  return verify(
    null,
    Buffer.concat([Buffer.from(timestamp, 'utf8'), body]),
    publicKey,
    signatureBytes,
  );
}

// isFreshDiscordInteractionTimestamp is the replay guard on the signed timestamp, which
// Discord sends as unix seconds.
export function isFreshDiscordInteractionTimestamp(
  timestamp: string | null,
  nowMs: number,
  toleranceMs = 300_000,
): boolean {
  if (!timestamp) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  return Math.abs(nowMs - seconds * 1_000) <= toleranceMs;
}

// Buffer.from drops non-hex characters instead of failing, which would turn a corrupt
// header into a short buffer and a confusing verification error.
function decodeHex(value: string): Buffer | undefined {
  if (!/^[0-9a-fA-F]+$/.test(value)) return undefined;
  return Buffer.from(value, 'hex');
}
