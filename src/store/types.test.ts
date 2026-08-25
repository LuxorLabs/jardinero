import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { type WorkflowStateTone, workflowStateTone } from './types.js';

describe('workflowStateTone', () => {
  const cases: Array<{ name: string; workflowState: string; want: WorkflowStateTone }> = [
    {
      name: 'When the state waits for a person then should read as attention',
      workflowState: 'prm_attempts_exhausted',
      want: 'attention',
    },
    {
      name: 'When the state has a sandbox in flight then should read as working',
      workflowState: 'li_implementing',
      want: 'working',
    },
    {
      name: 'When the state ended without the result it was after then should read as closed',
      workflowState: 'prm_closed',
      want: 'closed',
    },
    {
      name: 'When the state was dismissed by a person then should read as closed',
      workflowState: 'li_dismissed',
      want: 'closed',
    },
    {
      name: 'When the state ended with the result it was after then should read as done',
      workflowState: 'prm_merged',
      want: 'done',
    },
    {
      name: 'When the state is none of those then should read as waiting',
      workflowState: 'li_waiting_pr',
      want: 'waiting',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(workflowStateTone(testCase.workflowState), testCase.want);
    });
  }
});
