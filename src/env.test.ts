import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

const KEYS = ['ENV_FILE', 'JARDINERO_ENV_TEST_FROM_FILE', 'JARDINERO_ENV_TEST_PRESET'] as const;
const ORIGINAL_CWD = process.cwd();

let dir = '';
let importCount = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jardinero-env-'));
  process.chdir(dir);
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
  process.chdir(ORIGINAL_CWD);
  rmSync(dir, { recursive: true, force: true });
});

describe('env file loading at import', () => {
  const cases: EnvCase[] = [
    {
      name: 'When `ENV_FILE` is unset then should load `.env` from the working directory',
      setup: (d) => {
        writeFileSync(join(d, '.env'), 'JARDINERO_ENV_TEST_FROM_FILE=file\n');
        return undefined;
      },
      preset: 'environment',
      want: { fromFile: 'file', preset: 'environment' },
    },
    {
      name: 'When the env file is readable then should load it without overriding a preset variable',
      setup: (d) => {
        const path = join(d, 'app.env');
        writeFileSync(path, 'JARDINERO_ENV_TEST_FROM_FILE=file\nJARDINERO_ENV_TEST_PRESET=file\n');
        return path;
      },
      preset: 'environment',
      want: { fromFile: 'file', preset: 'environment' },
    },
    {
      name: 'When the env file is missing then should boot on the real environment',
      setup: (d) => join(d, 'missing.env'),
      preset: 'environment',
      want: { fromFile: undefined, preset: 'environment' },
    },
    {
      name: 'When the env file cannot be read then should boot on the real environment',
      setup: (d) => {
        const path = join(d, 'directory.env');
        mkdirSync(path);
        return path;
      },
      preset: 'environment',
      want: { fromFile: undefined, preset: 'environment' },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const envFile = c.setup(dir);
      if (envFile !== undefined) process.env.ENV_FILE = envFile;
      process.env.JARDINERO_ENV_TEST_PRESET = c.preset;

      await importEnv();

      assert.deepEqual(
        {
          fromFile: process.env.JARDINERO_ENV_TEST_FROM_FILE,
          preset: process.env.JARDINERO_ENV_TEST_PRESET,
        },
        c.want,
      );
    });
  }
});

// A fresh query string makes each case run the module's top-level code again.
async function importEnv(): Promise<void> {
  importCount++;
  await import(`./env.js?case=${importCount}`);
}

interface EnvCase {
  name: string;
  // Returns the `ENV_FILE` to set, or undefined to leave it unset.
  setup: (dir: string) => string | undefined;
  preset: string;
  want: { fromFile: string | undefined; preset: string };
}
