import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  isSameProblem,
  matchOpenImplementationPr,
  type OpenPullRequestText,
  type ProblemSignature,
} from './implementation-pr-dedup.js';

// A pull request of ours that spells out neither the fingerprint nor its tokens, so
// only the service and the environment are left to weigh.
const unfingerprinted = {
  title: 'fix: checkout-service payment retries',
  body: 'Source log review run id: old-run\nService/env: checkout-service / production',
  headBranch: 'agent/old-run',
};

describe('matchOpenImplementationPr', () => {
  const cases: MatchCase[] = [
    {
      name: 'When the pull request carries the fingerprint then should match it',
      prs: [openPr()],
      want: 77,
      wantTokens: ['fingerprint'],
    },
    {
      name: 'When the branch is not an agent one and nothing marks it then should not match it',
      prs: [openPr({ headBranch: 'feat/manual-work', body: 'checkout-service production' })],
      want: undefined,
    },
    ...['Source log review run id', 'Fix implementation run id', 'agent-run-id'].map((marker) => ({
      name: `When a branch of theirs is marked by \`${marker}\` then should match it`,
      prs: [
        openPr({
          headBranch: 'feat/manual-work',
          body: `${marker}: old-run\ncheckout-service-null-payment production`,
        }),
      ],
      want: 77,
      wantTokens: ['fingerprint'],
    })),
    {
      name: 'When the fingerprint is spelled out with the service alone then should match it',
      prs: [openPr({ title: undefined, body: 'checkout-service checkout-service-null-payment' })],
      want: 77,
      wantTokens: ['fingerprint'],
    },
    {
      name: 'When the fingerprint is spelled out with the environment alone then should match it',
      prs: [openPr({ title: undefined, body: 'production checkout-service-null-payment' })],
      want: 77,
      wantTokens: ['fingerprint'],
    },
    {
      name: 'When the pull request names another service then should not match it',
      signature: signature({ service: 'billing-service', fingerprint: 'billing-timeout-loop' }),
      prs: [openPr(unfingerprinted)],
      want: undefined,
    },
    {
      name: 'When the pull request names another environment then should not match it',
      signature: signature({ environment: 'staging' }),
      prs: [openPr(unfingerprinted)],
      want: undefined,
    },
    {
      // Nothing is left of the fingerprint once the service and the environment are
      // stripped, so there is no issue-specific token to weigh.
      name: 'When the fingerprint carries no issue specific token then should not match it',
      signature: signature({ fingerprint: 'production-checkout-service' }),
      prs: [openPr(unfingerprinted)],
      want: undefined,
    },
    {
      // Service and environment overlap alone is what every pull request of a
      // monorepo shares.
      name: 'When the overlap is generic then should not match it',
      signature: billingInvoicesSignature(),
      prs: [
        openPr({
          pullRequestNumber: 3581,
          title: '[agent] fix: accept legacy worker subaccounts',
          body: [
            'Source log review run id: c0f4aa87',
            'Service/env: api-gateway / production',
            'Changed backend/api-gateway/src/types/requests/pool.ts.',
          ].join('\n'),
          headBranch: 'agent/api-gateway-v2-pool-workers-BTC-411d16e4',
        }),
      ],
      want: undefined,
    },
    {
      name: 'When the overlap is issue specific then should match it',
      signature: billingInvoicesSignature(),
      prs: [
        openPr({
          pullRequestNumber: 3590,
          title: '[agent] fix: billing invoices premium feature permission handling',
          body: [
            'Source log review run id: another-run',
            'Service/env: api-gateway / production',
            'GET /v2/billing/invoices now returns 403 when the premium feature check receives permission_denied.',
          ].join('\n'),
          headBranch: 'agent/api-gateway-billing-invoices-premium-aaaa1111',
        }),
      ],
      want: 3590,
      wantTokens: ['billing', 'invoices', 'premium', 'feature', 'check', 'permission', 'denied'],
    },
    {
      name: 'When the tokens only share substrings then should not match it',
      signature: signature({ environment: 'prod' }),
      prs: [
        openPr({
          pullRequestNumber: 44,
          title: 'fix: checkout-service product barcode cleanup',
          body: 'Source log review run id: old-run\nService/env: checkout-service / product',
          headBranch: 'agent/old-run',
        }),
      ],
      want: undefined,
    },
    {
      name: 'When an earlier pull request does not match then should keep looking',
      prs: [openPr({ pullRequestNumber: 44, ...unfingerprinted }), openPr()],
      want: 77,
      wantTokens: ['fingerprint'],
    },
    {
      name: 'When nothing is open then should match nothing',
      prs: [],
      want: undefined,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const match = matchOpenImplementationPr(c.signature ?? signature(), c.prs);

      assert.equal(match?.number, c.want);
      assert.deepEqual(match?.matchedTokens, c.wantTokens);
    });
  }
});

describe('isSameProblem', () => {
  const cases: Array<{
    name: string;
    left: Partial<ProblemSignature>;
    right: Partial<ProblemSignature>;
    want: boolean;
  }> = [
    {
      name: 'When the error signal and the code location match then should be the same problem',
      left: {},
      right: {},
      want: true,
    },
    {
      name: 'When the fingerprint drifted but signal and location still match then should be the same problem',
      left: { fingerprint: 'checkout service null payment guard' },
      right: { fingerprint: 'checkout-service-null-payment' },
      want: true,
    },
    {
      name: 'When the same signal hits another code location then should be another problem',
      left: {
        fingerprint: 'auth-rejected-endpoint-a',
        likelyFilesOrSymbols: ['handlers/endpointA.ts'],
      },
      right: {
        fingerprint: 'auth-rejected-endpoint-b',
        likelyFilesOrSymbols: ['handlers/endpointB.ts'],
      },
      want: false,
    },
    {
      name: 'When the same code location carries another signal then should be another problem',
      left: {},
      right: { fingerprint: 'login-timeout-loop' },
      want: false,
    },
    {
      name: 'When neither signal nor location match then should be another problem',
      left: {},
      right: { fingerprint: 'login-timeout-loop', likelyFilesOrSymbols: ['AuthService'] },
      want: false,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.equal(isSameProblem(signature(c.left), signature(c.right)), c.want);
    });
  }
});

function signature(overrides: Partial<ProblemSignature> = {}): ProblemSignature {
  return {
    fingerprint: 'checkout-service-null-payment',
    service: 'checkout-service',
    environment: 'production',
    likelyFilesOrSymbols: ['CheckoutService'],
    ...overrides,
  };
}

function billingInvoicesSignature(): ProblemSignature {
  return {
    fingerprint:
      'api-gateway:/v2/billing/invoices:premium-feature-check-permission-denied-wrapped-as-500',
    service: 'api-gateway',
    environment: 'production',
    likelyFilesOrSymbols: ['backend/api-gateway/src/plugins/premium-feature-check.ts'],
  };
}

function openPr(overrides: Partial<OpenPullRequestText> = {}): OpenPullRequestText {
  return {
    pullRequestNumber: 77,
    title: 'fix: checkout-service null payment handling',
    body: [
      'Source log review run id: old-run',
      'Service/env: checkout-service / production',
      'Fingerprint: checkout-service-null-payment',
    ].join('\n'),
    headBranch: 'agent/checkout-service-null-payment',
    ...overrides,
  };
}

interface MatchCase {
  name: string;
  signature?: ProblemSignature;
  prs: OpenPullRequestText[];
  want: number | undefined;
  wantTokens?: string[];
}
