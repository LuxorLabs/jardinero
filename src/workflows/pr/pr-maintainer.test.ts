import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isAgentPullRequest } from './pr-maintainer.js';

const RULE = { branchPrefix: 'agent/' };

describe('isAgentPullRequest', () => {
  const cases: Array<{
    name: string;
    facts: { headBranch?: string };
    rule?: { branchPrefix: string };
    want: boolean;
  }> = [
    {
      name: 'When the branch carries the agent prefix then should be ours',
      facts: { headBranch: 'agent/fix-1' },
      want: true,
    },
    {
      name: 'When the branch is somebody else`s then should not be ours',
      facts: { headBranch: 'darolpz/pool-service-mock' },
      want: false,
    },
    {
      name: 'When there is no branch then should not be ours',
      facts: {},
      want: false,
    },
    {
      name: 'When the rule carries no prefix then should be nobody`s',
      facts: { headBranch: 'agent/fix-1' },
      rule: { branchPrefix: '' },
      want: false,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.equal(isAgentPullRequest(c.facts, c.rule ?? RULE), c.want);
    });
  }
});
