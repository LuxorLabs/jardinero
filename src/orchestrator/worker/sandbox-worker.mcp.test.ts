import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normalizeRemotePath, remoteJoin } from './sandbox-utils.js';
import {
  buildAuthenticatedFetchPrCommand,
  buildDockerSocketGrantCommand,
  buildGitHubCredentialHelperCommand,
  mcpListIncludesServer,
  mcpListServerRequiresLogin,
  parseDockerSocketStatus,
} from './sandbox-worker.js';

describe('normalizeRemotePath', () => {
  test('When path has outer whitespace and trailing slashes then should succeed', () => {
    assert.equal(normalizeRemotePath('  /home/tenki/workspace///  '), '/home/tenki/workspace');
    assert.equal(normalizeRemotePath('/'), '/');
  });

  test('When path is blank then should fall back to default workspace', () => {
    assert.equal(normalizeRemotePath(''), '/home/tenki/workspace');
    assert.equal(normalizeRemotePath('   '), '/home/tenki/workspace');
  });
});

describe('remoteJoin', () => {
  test('When parts have extra slashes then should succeed', () => {
    assert.equal(
      remoteJoin('/home/tenki/workspace//', '/context/', ' artifacts ', '/shot.png'),
      '/home/tenki/workspace/context/artifacts/shot.png',
    );
    assert.equal(
      remoteJoin('/home/tenki/workspace', '', '/', 'repo'),
      '/home/tenki/workspace/repo',
    );
    assert.equal(remoteJoin('/home/tenki/workspace//'), '/home/tenki/workspace');
  });

  test('When root is slash then should not double slash', () => {
    assert.equal(remoteJoin('/', 'context', 'artifacts'), '/context/artifacts');
  });
});

describe('mcpListServerRequiresLogin', () => {
  test('When another mcp server is unauthenticated then should ignore it', () => {
    const output = [
      'Name       Url                              Bearer Token Env Var  Status   Auth',
      'grafana    https://grafana.example/mcp       -                     enabled  OAuth',
      'linear     https://linear.example/mcp        -                     enabled  Not logged in',
    ].join('\n');

    assert.equal(mcpListIncludesServer(output, 'grafana'), true);
    assert.equal(mcpListServerRequiresLogin(output, 'grafana'), false);
  });

  test('When the target server is listed then should detect its login state', () => {
    const output = [
      'Name       Url                              Bearer Token Env Var  Status   Auth',
      'grafana    https://grafana.example/mcp       -                     enabled  Not logged in',
      'linear     https://linear.example/mcp        -                     enabled  OAuth',
    ].join('\n');

    assert.equal(mcpListIncludesServer(output, 'grafana'), true);
    assert.equal(mcpListServerRequiresLogin(output, 'grafana'), true);
  });
});

describe('buildAuthenticatedFetchPrCommand', () => {
  const REPO_DIR = '/home/tenki/workspace/repo';
  const PREAMBLE = [
    `if [ -z "\${GITHUB_TOKEN:-}" ]; then echo 'GITHUB_TOKEN is required to fetch PR refs' >&2; exit 1; fi`,
    `tmpcfg=$(umask 077 && mktemp)`,
    `trap 'rm -f "$tmpcfg"' EXIT`,
    `basic_auth=$(printf 'x-access-token:%s' "\${GITHUB_TOKEN}" | base64 | tr -d '\\n')`,
    `printf '[http "https://github.com/"]\\n\\textraheader = AUTHORIZATION: basic %s\\n' "\${basic_auth}" > "\${tmpcfg}"`,
    `chmod 600 "\${tmpcfg}"`,
    `git -C '${REPO_DIR}' -c include.path="\${tmpcfg}" fetch origin 'pull/42/head'`,
  ];

  const cases: Array<{ name: string; headRef?: string; want: string[] }> = [
    {
      name: 'When the pull request head is known then should check it out and point the push at it',
      headRef: 'agent/linear-JAR-58-abc123',
      want: [
        `git -C '${REPO_DIR}' checkout -B 'agent/linear-JAR-58-abc123' FETCH_HEAD`,
        `git -C '${REPO_DIR}' config 'branch.agent/linear-JAR-58-abc123.remote' origin`,
        `git -C '${REPO_DIR}' config 'branch.agent/linear-JAR-58-abc123.merge' 'refs/heads/agent/linear-JAR-58-abc123'`,
      ],
    },
    {
      name: 'When the pull request head is unknown then should check out a local name and set no push target',
      want: [`git -C '${REPO_DIR}' checkout -B 'pr-42' FETCH_HEAD`],
    },
    {
      name: 'When the pull request head is blank then should check out a local name',
      headRef: '   ',
      want: [`git -C '${REPO_DIR}' checkout -B 'pr-42' FETCH_HEAD`],
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const command = buildAuthenticatedFetchPrCommand({
        repoDir: REPO_DIR,
        prNumber: 42,
        ...(c.headRef === undefined ? {} : { headRef: c.headRef }),
      });

      assert.equal(command, [...PREAMBLE, ...c.want].join(' && '));
    });
  }

  test('When the pr number is not a positive integer then should return error', () => {
    assert.throws(
      () => buildAuthenticatedFetchPrCommand({ repoDir: REPO_DIR, prNumber: 0 }),
      /pr number must be > 0/,
    );
  });
});

describe('buildGitHubCredentialHelperCommand', () => {
  test('When credentials are needed then should install an env-backed github helper', () => {
    const command = buildGitHubCredentialHelperCommand();

    assert.equal(
      command,
      [
        `if [ -z "\${GITHUB_TOKEN:-}" ]; then echo 'GITHUB_TOKEN is required to configure GitHub credentials' >&2; exit 1; fi`,
        `git config --global credential.https://github.com.helper '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=\${GITHUB_TOKEN}"; }; f'`,
      ].join(' && '),
    );
    assert.doesNotMatch(command, /github_pat_|gh[opsru]_/);
  });

  test('When the token env name is unsafe then should return error', () => {
    assert.throws(
      () => buildGitHubCredentialHelperCommand({ tokenEnv: 'GITHUB_TOKEN; rm -rf /' }),
      /invalid token env var/,
    );
  });
});

describe('buildDockerSocketGrantCommand', () => {
  test('When the docker socket is granted then should be idempotent and fail soft', () => {
    const command = buildDockerSocketGrantCommand();

    // Always exits 0 (best-effort), only chmods when a socket and sudo exist, and
    // prints exactly one parseable status for every branch.
    assert.equal(
      command,
      [
        `if [ ! -S '/var/run/docker.sock' ]; then echo 'docker_socket=absent';`,
        `elif ! command -v sudo >/dev/null 2>&1; then echo 'docker_socket=no_sudo';`,
        `elif sudo -n chmod 666 '/var/run/docker.sock' 2>/dev/null; then echo 'docker_socket=granted';`,
        `else echo 'docker_socket=grant_failed'; fi`,
      ].join(' '),
    );
  });

  test('When the socket path is custom then should quote it so it cannot break out', () => {
    const command = buildDockerSocketGrantCommand('/tmp/evil; rm -rf /');

    assert.ok(command.includes(`'/tmp/evil; rm -rf /'`));
    assert.ok(!command.includes('; rm -rf /;'));
  });
});

describe('parseDockerSocketStatus', () => {
  test('When the status output is unknown then should degrade instead of failing', () => {
    assert.equal(parseDockerSocketStatus('docker_socket=granted'), 'granted');
    assert.equal(parseDockerSocketStatus('noise\ndocker_socket=absent\nmore'), 'absent');
    assert.equal(parseDockerSocketStatus('docker_socket=grant_failed'), 'grant_failed');
    assert.equal(parseDockerSocketStatus('docker_socket=no_sudo'), 'no_sudo');
    assert.equal(parseDockerSocketStatus('nothing useful here'), 'unknown');
    assert.equal(parseDockerSocketStatus(''), 'unknown');
  });
});
