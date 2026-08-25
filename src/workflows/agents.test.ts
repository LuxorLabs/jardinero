import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { agentKindForTask, taskRepo } from './agents.js';
import type { Workflow } from '../types.js';
import type { SandboxTask } from '../orchestrator/sandbox-pool.js';

describe('agentKindForTask', () => {
  const agentKindCases = [
    {
      name: 'When workflow is `log_review` then should return `log_reviewer`',
      task: task('log_review'),
      want: 'log_reviewer',
    },
    {
      name: 'When workflow is `fix_implement` then should return `fix_implementer`',
      task: task('fix_implement'),
      want: 'fix_implementer',
    },
    {
      name: 'When workflow is `pr_maintain` then should return `pr_maintainer`',
      task: task('pr_maintain'),
      want: 'pr_maintainer',
    },
    {
      name: 'When workflow is linear without verify role then should return linear implementer',
      task: task('linear'),
      want: 'linear_implementer',
    },
    {
      name: 'When workflow is linear with verify role then should return linear verifier',
      task: task('linear', { role: 'verify' }),
      want: 'linear_verifier',
    },
    {
      name: 'When workflow is `request_router` then should return `request_router`',
      task: task('request_router'),
      want: 'request_router',
    },
  ];

  for (const c of agentKindCases) {
    test(c.name, () => {
      assert.equal(agentKindForTask(c.task), c.want);
    });
  }
});

describe('taskRepo', () => {
  const taskRepoCases = [
    {
      name: 'When payload repo is set then should return it',
      payload: { repo: 'Owner/Repo' },
      want: 'Owner/Repo',
    },
    {
      name: 'When payload repo is missing then should return undefined',
      payload: {},
      want: undefined,
    },
    {
      name: 'When payload repo is blank then should return undefined',
      payload: { repo: '   ' },
      want: undefined,
    },
    {
      name: 'When payload repo is not a string then should return undefined',
      payload: { repo: 42 },
      want: undefined,
    },
  ];

  for (const c of taskRepoCases) {
    test(c.name, () => {
      assert.equal(taskRepo(task('log_review', c.payload)), c.want);
    });
  }
});

function task(workflow: Workflow, payload: Record<string, unknown> = {}): SandboxTask {
  return {
    workflow,
    payload,
    promptOverrides: {},
  };
}
