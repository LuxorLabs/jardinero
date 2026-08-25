import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readPackageVersion(): string {
  const raw = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== 'string') {
    throw new Error('package.json version must be a string');
  }
  return parsed.version;
}

// App version baked into the image at build time: the semver release tag, or
// `v0.0.0-<short-sha>` for continuous builds. Falls back to package.json for
// local runs where no image was built.
export function resolveAppVersion(env: NodeJS.ProcessEnv): string {
  const buildVersion = env.JARDINERO_BUILD_VERSION?.trim();
  return buildVersion || readPackageVersion();
}
