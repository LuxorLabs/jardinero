import { type KeyObject, generateKeyPairSync, sign } from 'node:crypto';

export interface SignedDiscordInteraction {
  publicKeyHex: string;
  body: string;
  headers: Record<string, string>;
}

// createDiscordSigner keeps one key pair, which is what a test signing several interactions
// against one running receiver needs: the public key is configured once.
export function createDiscordSigner(): {
  publicKeyHex: string;
  sign(payload: unknown): SignedDiscordInteraction;
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const publicKeyHex = Buffer.from(jwk.x, 'base64url').toString('hex');
  return {
    publicKeyHex,
    sign: (payload) => signWith(privateKey, publicKeyHex, JSON.stringify(payload)),
  };
}

// signDiscordInteraction signs a payload the way Discord does, so a receiver test can
// exercise everything behind the signature instead of stubbing the check away.
export function signDiscordInteraction(
  payload: unknown,
  timestampSeconds = Math.floor(Date.now() / 1_000),
): SignedDiscordInteraction {
  return signDiscordInteractionBody(JSON.stringify(payload), timestampSeconds);
}

// signDiscordInteractionBody signs bytes rather than a payload, which is the only way to
// deliver a body the receiver can authenticate and still not parse.
export function signDiscordInteractionBody(
  body: string,
  timestampSeconds = Math.floor(Date.now() / 1_000),
): SignedDiscordInteraction {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return signWith(
    privateKey,
    Buffer.from(jwk.x, 'base64url').toString('hex'),
    body,
    timestampSeconds,
  );
}

function signWith(
  privateKey: KeyObject,
  publicKeyHex: string,
  body: string,
  timestampSeconds = Math.floor(Date.now() / 1_000),
): SignedDiscordInteraction {
  const timestamp = String(timestampSeconds);
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(timestamp, 'utf8'), Buffer.from(body)]),
    privateKey,
  );
  return {
    publicKeyHex,
    body,
    headers: {
      'content-type': 'application/json',
      'x-signature-ed25519': signature.toString('hex'),
      'x-signature-timestamp': timestamp,
    },
  };
}

// discordCommandPayload is the interaction Discord posts for a command, with only the
// members the reader looks at.
export function discordCommandPayload(options: {
  commandName: string;
  options?: Array<{ name: string; value: string }>;
  roleIds?: string[];
  channelId?: string;
  interactionId?: string;
}): Record<string, unknown> {
  return {
    type: 2,
    id: options.interactionId ?? 'interaction-1',
    token: 'interaction-token',
    channel_id: options.channelId ?? 'channel-1',
    member: {
      user: { id: '1001', username: 'octo' },
      roles: options.roleIds ?? ['role-1'],
    },
    data: { name: options.commandName, options: options.options ?? [] },
  };
}
