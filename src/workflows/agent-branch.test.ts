import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { computeAgentBranch, runIdShort } from './agent-branch.js';

const RUN_ID = '99f74e3d-bda2-41d5-b028-8f7a1f84ddda';

describe('computeAgentBranch', () => {
  const cases: Array<{ name: string; fingerprint: string | undefined; want: string }> = [
    {
      // 49 chars once cleaned, so it truncates at the last dash that fits.
      name: 'When the fingerprint is dotted then should build a slug first branch',
      fingerprint: 'web.inventory.permission_denied.dashboard_actions',
      want: 'agent/web-inventory-permission-denied-99f74e3d',
    },
    {
      name: 'When the fingerprint has code identifiers then should preserve their casing',
      fingerprint: 'OrderService.GetSubscriptionStatus route not found',
      want: 'agent/OrderService-GetSubscriptionStatus-99f74e3d',
    },
    {
      name: 'When the slug exceeds the cap then should truncate at the last dash',
      fingerprint:
        'web/account-service:startUpdateMember:Cannot delete ACCOUNT UNSPECIFIED membership',
      want: 'agent/web-account-service-startUpdateMember-99f74e3d',
    },
    {
      name: 'When separators repeat then should collapse and trim them',
      fingerprint: '...foo  ::  bar---baz...',
      want: 'agent/foo-bar-baz-99f74e3d',
    },
    {
      name: 'When the fingerprint is undefined then should fall back to unspecified',
      fingerprint: undefined,
      want: 'agent/unspecified-99f74e3d',
    },
    {
      name: 'When the fingerprint is empty then should fall back to unspecified',
      fingerprint: '',
      want: 'agent/unspecified-99f74e3d',
    },
    {
      name: 'When the fingerprint is blank then should fall back to unspecified',
      fingerprint: '   ',
      want: 'agent/unspecified-99f74e3d',
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.equal(computeAgentBranch(RUN_ID, c.fingerprint), c.want);
    });
  }

  test('When the slug has no dash boundary then should hard truncate at the cap', () => {
    const branch = computeAgentBranch(
      RUN_ID,
      'thisIsOneVeryLongCamelCaseTokenWithNoSeparatorsAtAll-now',
    );

    assert.ok(slugOf(branch).length <= 40, `slug ${slugOf(branch).length} chars exceeded cap`);
    assert.ok(branch.startsWith('agent/thisIsOneVeryLong'));
    assert.ok(branch.endsWith('-99f74e3d'));
  });

  test('When the fingerprint is long then should keep the slug within the cap', () => {
    const branch = computeAgentBranch(
      RUN_ID,
      'web/workspace-service:startUpdateMember:Cannot delete WORKSPACE UNSPECIFIED membership',
    );

    assert.ok(slugOf(branch).length <= 40, `slug ${slugOf(branch).length} chars exceeded cap`);
  });
});

describe('runIdShort', () => {
  const cases = [
    {
      name: 'When the `run_id` is a uuid then should return its first eight hex chars',
      runId: '99f74e3d-bda2-41d5-b028-8f7a1f84ddda',
      want: '99f74e3d',
    },
    {
      name: 'When the `run_id` is all zeroes then should return eight zeroes',
      runId: '00000000-0000-0000-0000-000000000000',
      want: '00000000',
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.equal(runIdShort(c.runId), c.want);
    });
  }
});

function slugOf(branch: string): string {
  return branch.replace(/^agent\//, '').replace(/-[a-f0-9]{8}$/, '');
}
