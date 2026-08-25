import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

// The host paths are derived from homedir() when the module loads, and on POSIX
// homedir() reads HOME. Pointing HOME at a temp dir before the import is the only
// seam this module has, so the import has to stay dynamic and below this line.
const HOME = mkdtempSync(path.join(tmpdir(), 'jardinero-codex-home-'));
process.env.HOME = HOME;
const CODEX_DIR = path.join(HOME, '.codex');
const AUTH_PATH = path.join(CODEX_DIR, 'auth.json');
const CREDENTIALS_PATH = path.join(CODEX_DIR, '.credentials.json');
const REMOTE_AUTH = '/home/tenki/.codex/auth.json';
const REMOTE_CREDENTIALS = '/home/tenki/.codex/.credentials.json';

const {
  forwardHostCodexAuthToSandbox,
  hostCodexAuthExists,
  hostCodexAuthPath,
  resetCodexAuthCacheForTest,
} = await import('./codex-auth.js');

beforeEach(() => {
  rmSync(CODEX_DIR, { recursive: true, force: true });
  mkdirSync(CODEX_DIR, { recursive: true });
  resetCodexAuthCacheForTest();
});

afterEach(() => {
  rmSync(CODEX_DIR, { recursive: true, force: true });
});

describe('hostCodexAuthPath', () => {
  test('When the path is read then should point at the host codex auth file', () => {
    assert.equal(hostCodexAuthPath(), AUTH_PATH);
  });
});

describe('hostCodexAuthExists', () => {
  const cases: Array<{ name: string; arrange?(): void; want: boolean }> = [
    {
      name: 'When the file is missing then should return false',
      want: false,
    },
    {
      // An empty auth.json is what a failed `codex login` leaves behind, and
      // forwarding it would make the sandbox fail with an unrelated error.
      name: 'When the file is empty then should return false',
      arrange: () => writeFileSync(AUTH_PATH, ''),
      want: false,
    },
    {
      name: 'When the path is a directory then should return false',
      arrange: () => mkdirSync(AUTH_PATH),
      want: false,
    },
    {
      name: 'When the file has contents then should return true',
      arrange: () => writeAuth(),
      want: true,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      testCase.arrange?.();

      assert.equal(hostCodexAuthExists(), testCase.want);
    });
  }
});

describe('forwardHostCodexAuthToSandbox', () => {
  const rejectionCases: Array<{
    name: string;
    arrange?(): void;
    session?: FakeSessionOptions;
    wantError: RegExp;
  }> = [
    {
      name: 'When there is no host auth then should return error naming the login',
      wantError:
        /Codex capsule auth requires .*auth\.json. Run "codex login" on the orchestrator host first\./,
    },
    {
      name: 'When the auth file is too large then should return error refusing to forward it',
      arrange: () => writeFileSync(AUTH_PATH, 'x'.repeat(65_537)),
      wantError: /auth\.json is unexpectedly large \(65537 bytes\); refusing to forward it/,
    },
    {
      name: 'When the remote directory cannot be created then should return error',
      arrange: writeAuth,
      session: { mkdirError: new Error('permission denied') },
      wantError: /permission denied/,
    },
    {
      name: 'When the session exposes no exec then should return error',
      arrange: writeAuth,
      session: { withoutExec: true },
      wantError:
        /Tenki session does not expose exec; Codex auth forwarding requires shell execution\./,
    },
    {
      name: 'When the install command fails then should return error with its exit code',
      arrange: writeAuth,
      session: { exitCode: 1, stderr: 'chown: invalid user' },
      wantError: /install Codex auth failed with exit code 1: chown: invalid user/,
    },
  ];

  for (const testCase of rejectionCases) {
    test(testCase.name, async () => {
      testCase.arrange?.();

      await assert.rejects(
        () => forwardHostCodexAuthToSandbox(fakeSession(testCase.session).session),
        testCase.wantError,
      );
    });
  }

  // Without credentials the remote file has to be removed, or a sandbox reused
  // across logins keeps serving the credentials of the previous one.
  const writeCases: Array<{
    name: string;
    withCredentials: boolean;
    wantPaths: string[];
    wantCommand: RegExp[];
    wantNotInCommand?: RegExp;
  }> = [
    {
      name: 'When only auth is present then should write it and remove the remote credentials',
      withCredentials: false,
      wantPaths: [REMOTE_AUTH],
      wantCommand: [
        /sudo rm -f '\/home\/tenki\/\.codex\/\.credentials\.json' && /,
        /chown tenki:tenki '\/home\/tenki\/\.codex'/,
        /chmod 600 '\/home\/tenki\/\.codex\/auth\.json'/,
      ],
    },
    {
      name: 'When credentials are present then should write both and chmod them',
      withCredentials: true,
      wantPaths: [REMOTE_AUTH, REMOTE_CREDENTIALS],
      wantCommand: [/chmod 600 .*auth\.json.* .*\.credentials\.json'/],
      wantNotInCommand: /rm -f/,
    },
  ];

  for (const testCase of writeCases) {
    test(testCase.name, async () => {
      writeAuth();
      if (testCase.withCredentials) writeFileSync(CREDENTIALS_PATH, '{"refresh":"r"}');
      const fake = fakeSession();

      await forwardHostCodexAuthToSandbox(fake.session);

      assert.deepEqual(fake.mkdirs, ['/home/tenki/.codex']);
      assert.deepEqual(
        fake.writes.map((write) => write.path),
        testCase.wantPaths,
      );
      assert.deepEqual(
        fake.writes.map((write) => write.mode),
        testCase.wantPaths.map(() => 0o600),
      );
      for (const pattern of testCase.wantCommand) assert.match(fake.commands[0], pattern);
      if (testCase.wantNotInCommand) {
        assert.doesNotMatch(fake.commands[0], testCase.wantNotInCommand);
      }
    });
  }

  // Re-pushing an unchanged auth.json on every step would cost a shell round trip
  // per run, so the snapshot hash is remembered per session and only that exact
  // snapshot is skipped.
  const repushCases: Array<{
    name: string;
    session?: FakeSessionOptions;
    act(session: TenkiSessionArg): Promise<void>;
    wantWrites: number;
    check?(fake: FakeSession): void;
  }> = [
    {
      name: 'When the auth has not changed then should not push it again',
      act: async (session) => {
        await forwardHostCodexAuthToSandbox(session);
        await forwardHostCodexAuthToSandbox(session);
      },
      wantWrites: 1,
    },
    {
      name: 'When the push is forced then should push the unchanged auth again',
      act: async (session) => {
        await forwardHostCodexAuthToSandbox(session);
        await forwardHostCodexAuthToSandbox(session, true);
      },
      wantWrites: 2,
    },
    {
      name: 'When the auth changed then should push the new contents',
      act: async (session) => {
        await forwardHostCodexAuthToSandbox(session);
        writeAuth('b');
        await forwardHostCodexAuthToSandbox(session);
      },
      wantWrites: 2,
      check: (fake) =>
        assert.deepEqual(
          fake.writes.map((write) => write.contents),
          [authContents('a'), authContents('b')],
        ),
    },
    {
      // The remote directory usually exists already, so only a failure that is not
      // about existence may abort the push.
      name: 'When the remote directory already exists then should keep pushing',
      session: { mkdirError: new Error('file already exists') },
      act: (session) => forwardHostCodexAuthToSandbox(session),
      wantWrites: 1,
    },
    {
      // A failed install must not be remembered, or the retry is skipped as a no-op
      // and the sandbox keeps running without auth.
      name: 'When the install failed then should push again on the next call',
      session: { exitCode: 1 },
      act: async (session) => {
        await assert.rejects(() => forwardHostCodexAuthToSandbox(session));
        await assert.rejects(() => forwardHostCodexAuthToSandbox(session));
      },
      wantWrites: 2,
    },
    {
      name: 'When the cache is reset then should forget what the session already has',
      act: async (session) => {
        await forwardHostCodexAuthToSandbox(session);
        resetCodexAuthCacheForTest();
        await forwardHostCodexAuthToSandbox(session);
      },
      wantWrites: 2,
    },
  ];

  for (const testCase of repushCases) {
    test(testCase.name, async () => {
      writeAuth();
      const fake = fakeSession(testCase.session);

      await testCase.act(fake.session);

      assert.equal(fake.writes.length, testCase.wantWrites);
      testCase.check?.(fake);
    });
  }
});

function authContents(id: string): string {
  return `{"tokens":{"id":"${id}"}}`;
}

function writeAuth(id = 'a'): void {
  writeFileSync(AUTH_PATH, authContents(id));
}

interface FakeSessionOptions {
  mkdirError?: Error;
  exitCode?: number;
  stderr?: string;
  withoutExec?: boolean;
}

type TenkiSessionArg = Parameters<typeof forwardHostCodexAuthToSandbox>[0];

interface FakeSession {
  session: TenkiSessionArg;
  mkdirs: string[];
  writes: Array<{ path: string; contents: string; mode: unknown }>;
  commands: string[];
}

function fakeSession(options: FakeSessionOptions = {}): FakeSession {
  const mkdirs: string[] = [];
  const writes: Array<{ path: string; contents: string; mode: unknown }> = [];
  const commands: string[] = [];

  const session = {
    id: 'session-1',
    fs: {
      mkdir: async (remotePath: string) => {
        mkdirs.push(remotePath);
        if (options.mkdirError) throw options.mkdirError;
      },
      writeStream: async (
        remotePath: string,
        stream: ReadableStream<Uint8Array>,
        writeOptions: { mode?: number },
      ) => {
        writes.push({
          path: remotePath,
          contents: await new Response(stream).text(),
          mode: writeOptions.mode,
        });
      },
    },
    ...(options.withoutExec
      ? {}
      : {
          exec: async (_command: string, execOptions: { args: string[] }) => {
            commands.push(execOptions.args[1]);
            return { exitCode: options.exitCode ?? 0, stderr: options.stderr ?? '' };
          },
        }),
  };

  return { session: session as unknown as TenkiSessionArg, mkdirs, writes, commands };
}
