import type { Store } from '../../store/store.js';
import { hostCodexAuthFingerprint } from './codex-auth.js';

// The reason a host-level Codex login death is stored and shown. Sandboxes cannot
// recover from it; an operator has to log in again and replace auth.json.
export const CODEX_AUTH_REVOKED = 'codex_auth_revoked';

export const CODEX_AUTH_REVOKED_MESSAGE =
  'Codex login is revoked. An operator needs to run `codex login` and write the new auth.json into the secret store. I will not start more sandboxes until that file changes.';

const AUTH_REVOKED = /workspace routing discovery unauthorized|invalid_grant/i;

// isCodexAuthRevokedOutput answers whether Codex refused because the ChatGPT login
// is dead, which is a host problem and not a task the next sandbox can finish.
export function isCodexAuthRevokedOutput(result: {
  stdout?: string;
  stderr?: string;
  lastMessage?: string;
}): boolean {
  return [result.stdout, result.stderr, result.lastMessage].some((text) =>
    AUTH_REVOKED.test(text ?? ''),
  );
}

export function isCodexAuthRevokedError(error: string | undefined): boolean {
  return error === CODEX_AUTH_REVOKED;
}

// codexAuthIsBlocked is the halt: a stored revocation still matches the file we
// would forward. A new auth.json changes the fingerprint and clears it.
export function codexAuthIsBlocked(
  store: Pick<Store, 'getHostBlock' | 'clearHostBlock'>,
  fingerprint: string = hostCodexAuthFingerprint(),
): boolean {
  const block = store.getHostBlock();
  if (!block) return false;
  if (block.authFingerprint !== fingerprint) {
    store.clearHostBlock();
    return false;
  }
  return true;
}

export function recordCodexAuthRevoked(store: Pick<Store, 'setHostBlock'>): void {
  store.setHostBlock({
    reason: CODEX_AUTH_REVOKED,
    authFingerprint: hostCodexAuthFingerprint(),
  });
}
