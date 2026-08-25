// Rotates the ChatGPT/Codex auth.json in place, so it never goes stale on the
// orchestrator host. Call it on a timer of your own: a cron entry, a systemd timer,
// a Kubernetes CronJob, whatever schedules things where you run Jardinero. Every
// two days is far inside the token's lifetime.
//
//   pnpm run codex:refresh
//
// Why it is needed, and what happens without it, is in docs/secrets.md.
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { refreshCodexAuth } from '../src/adapters/codex/codex-auth-refresh.js';
import { hostCodexAuthPath } from '../src/adapters/codex/codex-auth.js';

async function main(): Promise<void> {
  const authPath = hostCodexAuthPath();

  let contents: string;
  try {
    contents = readFileSync(authPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`No auth.json at ${authPath}. Run "codex login" there first.`);
    }
    throw error;
  }

  const refreshed = await refreshCodexAuth(contents);

  // Write beside the target and rename, so a crash mid-write cannot leave the host
  // holding half a file and no way back into the account.
  const pending = path.join(path.dirname(authPath), `.${path.basename(authPath)}.pending`);
  writeFileSync(pending, refreshed, { mode: 0o600 });
  renameSync(pending, authPath);
  chmodSync(authPath, 0o600);

  console.log(`Refreshed ${authPath} at ${JSON.parse(refreshed).last_refresh}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
