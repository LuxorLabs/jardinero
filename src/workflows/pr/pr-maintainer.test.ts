import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isAgentPullRequest } from './pr-maintainer.js';

const RULE = { branchPrefix: 'agent/' };

describe('isAgentPullRequest', () => {
  const cases: Array<{
    name: string;
    facts: { headBranch?: string; fromFork: boolean };
    rule?: { branchPrefix: string };
    want: boolean;
  }> = [
    {
      name: 'When the rule carries no prefix then should be nobody`s',
      facts: { headBranch: 'agent/fix-1', fromFork: false },
      rule: { branchPrefix: '' },
      want: false,
    },
    {
      name: 'When the branch lives in a fork then should not be ours',
      facts: { headBranch: 'agent/fix-1', fromFork: true },
      want: false,
    },
    {
      name: 'When the branch carries the agent prefix then should be ours',
      facts: { headBranch: 'agent/fix-1', fromFork: false },
      want: true,
    },
    {
      name: 'When the branch is somebody else`s then should not be ours',
      facts: { headBranch: 'darolpz/pool-service-mock', fromFork: false },
      want: false,
    },
    {
      name: 'When there is no branch then should not be ours',
      facts: { fromFork: false },
      want: false,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.equal(isAgentPullRequest(c.facts, c.rule ?? RULE), c.want);
    });
  }
});
