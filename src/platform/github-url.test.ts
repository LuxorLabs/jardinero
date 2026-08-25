import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  canonicalPullRequestFrom,
  extractGitHubPullRequestUrl,
  extractGitHubPullRequestUrls,
  formatGitHubPullRequestUrl,
  isGitHubTimestamp,
  parseGitHubPullRequestUrl,
  sameGitHubRepo,
} from './github-url.js';

describe('parseGitHubPullRequestUrl', () => {
  const parseCases = [
    {
      name: 'When url is canonical then should return repo and number',
      input: 'https://github.com/acme/webapp/pull/123',
      want: { repo: 'acme/webapp', number: 123 },
    },
    {
      name: 'When url has trailing path then should ignore it',
      input: 'https://github.com/acme/webapp/pull/123/files?w=1#diff',
      want: { repo: 'acme/webapp', number: 123 },
    },
    {
      name: 'When url carries userinfo then should still parse',
      input: 'https://x-access-token:secret@github.com/acme/webapp/pull/123',
      want: { repo: 'acme/webapp', number: 123 },
    },
    {
      name: 'When host casing differs then should still parse',
      input: 'https://GitHub.com/acme/webapp/pull/123',
      want: { repo: 'acme/webapp', number: 123 },
    },
    {
      name: 'When scheme is not https then should return undefined',
      input: 'http://github.com/acme/webapp/pull/123',
      want: undefined,
    },
    {
      name: 'When host is not github then should return undefined',
      input: 'https://example.com/acme/webapp/pull/123',
      want: undefined,
    },
    {
      name: 'When host is lookalike then should return undefined',
      input: 'https://github.com.evil.test/acme/webapp/pull/123',
      want: undefined,
    },
    {
      name: 'When path is not a pull then should return undefined',
      input: 'https://github.com/acme/webapp/issues/123',
      want: undefined,
    },
    {
      name: 'When number is not numeric then should return undefined',
      input: 'https://github.com/acme/webapp/pull/abc',
      want: undefined,
    },
    {
      name: 'When number is zero then should return undefined',
      input: 'https://github.com/acme/webapp/pull/0',
      want: undefined,
    },
    {
      name: 'When number overflows safe integer then should return undefined',
      input: 'https://github.com/acme/webapp/pull/99999999999999999999',
      want: undefined,
    },
    {
      name: 'When url is not a url then should return undefined',
      input: 'not a url',
      want: undefined,
    },
  ];

  for (const c of parseCases) {
    test(c.name, () => {
      assert.deepEqual(parseGitHubPullRequestUrl(c.input), c.want);
    });
  }
});

describe('formatGitHubPullRequestUrl', () => {
  test('When a repo and number are given then should build the canonical pr url', () => {
    assert.equal(
      formatGitHubPullRequestUrl('acme/webapp', 123),
      'https://github.com/acme/webapp/pull/123',
    );
  });
});

describe('extractGitHubPullRequestUrls', () => {
  test('When the text carries userinfo in the url then should still capture it', () => {
    const urls = extractGitHubPullRequestUrls(
      'see https://x-access-token:secret@github.com/acme/webapp/pull/7 for context',
    );
    assert.deepEqual(urls, ['https://x-access-token:secret@github.com/acme/webapp/pull/7']);
  });

  test('When the value is nested then should walk every branch of it', () => {
    assert.deepEqual(
      extractGitHubPullRequestUrls({
        stdout: 'schema note https://github.com/acme/schema/pull/538',
        lastMessage: 'opened https://github.com/acme/webapp/pull/3563',
      }),
      ['https://github.com/acme/schema/pull/538', 'https://github.com/acme/webapp/pull/3563'],
    );
  });

  test('When the structure is circular then should not overflow', () => {
    const circularArray: unknown[] = ['opened https://github.com/acme/webapp/pull/3563'];
    circularArray.push(circularArray);
    const circularObject: Record<string, unknown> = {
      note: 'schema note https://github.com/acme/schema/pull/538',
    };
    circularObject.self = circularObject;
    circularObject.list = circularArray;

    assert.deepEqual(extractGitHubPullRequestUrls(circularObject), [
      'https://github.com/acme/schema/pull/538',
      'https://github.com/acme/webapp/pull/3563',
    ]);
  });
});

describe('extractGitHubPullRequestUrl', () => {
  test('When a worker result nests several urls then should return the first', () => {
    assert.equal(
      extractGitHubPullRequestUrl({
        output: ['opened https://github.com/acme/web.app/pull/123'],
      }),
      'https://github.com/acme/web.app/pull/123',
    );
  });

  test('When no url is present then should return undefined', () => {
    assert.equal(extractGitHubPullRequestUrl({ output: ['no pull request opened'] }), undefined);
  });
});

describe('isGitHubTimestamp', () => {
  const timestampCases = [
    {
      name: 'When value is a utc second timestamp then should accept',
      input: '2026-06-19T12:00:00Z',
      want: true,
    },
    {
      name: 'When value has fractional seconds then should accept',
      input: '2026-06-19T12:00:00.000Z',
      want: true,
    },
    {
      name: 'When value has a numeric offset then should reject',
      input: '2026-06-19T12:00:00+00:00',
      want: false,
    },
    {
      name: 'When value is not a timestamp then should reject',
      input: 'not-a-date',
      want: false,
    },
    {
      name: 'When value is empty then should reject',
      input: '',
      want: false,
    },
  ];

  for (const c of timestampCases) {
    test(c.name, () => {
      assert.equal(isGitHubTimestamp(c.input), c.want);
    });
  }
});

describe('sameGitHubRepo', () => {
  const sameRepoCases: Array<{
    name: string;
    left: string | undefined;
    right: string | undefined;
    want: boolean;
  }> = [
    {
      name: 'When repos are identical then should return true',
      left: 'acme/webapp',
      right: 'acme/webapp',
      want: true,
    },
    {
      name: 'When repos differ only by case then should return true',
      left: 'acme/webapp',
      right: 'acme/WebApp',
      want: true,
    },
    {
      name: 'When repos are different then should return false',
      left: 'acme/webapp',
      right: 'acme/other',
      want: false,
    },
    {
      name: 'When left is undefined then should return false',
      left: undefined,
      right: 'acme/webapp',
      want: false,
    },
    {
      name: 'When right is undefined then should return false',
      left: 'acme/webapp',
      right: undefined,
      want: false,
    },
    {
      name: 'When both are undefined then should return false',
      left: undefined,
      right: undefined,
      want: false,
    },
  ];

  for (const c of sameRepoCases) {
    test(c.name, () => {
      assert.equal(sameGitHubRepo(c.left, c.right), c.want);
    });
  }
});

describe('canonicalPullRequestFrom', () => {
  const canonicalCases: Array<{
    name: string;
    htmlUrl: unknown;
    claimedNumber: unknown;
    expectedRepo: string;
    want: { repo: string; number: number } | undefined;
  }> = [
    {
      name: 'When url number and repo all agree then should return canonical',
      htmlUrl: 'https://github.com/acme/webapp/pull/42',
      claimedNumber: 42,
      expectedRepo: 'acme/webapp',
      want: { repo: 'acme/webapp', number: 42 },
    },
    {
      name: 'When repo casing differs then should return expected casing',
      htmlUrl: 'https://github.com/acme/webapp/pull/42',
      claimedNumber: 42,
      expectedRepo: 'acme/webapp',
      want: { repo: 'acme/webapp', number: 42 },
    },
    {
      name: 'When url carries userinfo then should return canonical',
      htmlUrl: 'https://x-access-token:secret@github.com/acme/webapp/pull/42',
      claimedNumber: 42,
      expectedRepo: 'acme/webapp',
      want: { repo: 'acme/webapp', number: 42 },
    },
    {
      name: 'When claimed number disagrees with url then should return undefined',
      htmlUrl: 'https://github.com/acme/webapp/pull/42',
      claimedNumber: 7,
      expectedRepo: 'acme/webapp',
      want: undefined,
    },
    {
      name: 'When url repo differs from expected then should return undefined',
      htmlUrl: 'https://github.com/other/repo/pull/42',
      claimedNumber: 42,
      expectedRepo: 'acme/webapp',
      want: undefined,
    },
    {
      name: 'When url is not a `pull_request` then should return undefined',
      htmlUrl: 'https://github.com/acme/webapp/issues/42',
      claimedNumber: 42,
      expectedRepo: 'acme/webapp',
      want: undefined,
    },
    {
      name: 'When `html_url` is blank then should return undefined',
      htmlUrl: '   ',
      claimedNumber: 42,
      expectedRepo: 'acme/webapp',
      want: undefined,
    },
    {
      name: 'When `html_url` is not a string then should return undefined',
      htmlUrl: 42,
      claimedNumber: 42,
      expectedRepo: 'acme/webapp',
      want: undefined,
    },
    {
      name: 'When claimed number is zero then should return undefined',
      htmlUrl: 'https://github.com/acme/webapp/pull/42',
      claimedNumber: 0,
      expectedRepo: 'acme/webapp',
      want: undefined,
    },
    {
      name: 'When claimed number is not an integer then should return undefined',
      htmlUrl: 'https://github.com/acme/webapp/pull/42',
      claimedNumber: 42.5,
      expectedRepo: 'acme/webapp',
      want: undefined,
    },
    {
      name: 'When claimed number is not a number then should return undefined',
      htmlUrl: 'https://github.com/acme/webapp/pull/42',
      claimedNumber: '42',
      expectedRepo: 'acme/webapp',
      want: undefined,
    },
  ];

  for (const c of canonicalCases) {
    test(c.name, () => {
      assert.deepEqual(
        canonicalPullRequestFrom(c.htmlUrl, c.claimedNumber, c.expectedRepo),
        c.want,
      );
    });
  }
});
