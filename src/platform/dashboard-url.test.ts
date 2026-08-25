import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { operationUrl } from './dashboard-url.js';

describe('operationUrl', () => {
  const cases: Array<{
    name: string;
    publicUrl: string;
    workflowInstanceId: string;
    sandboxRunId?: string | null;
    wantUrl?: string;
  }> = [
    {
      name: 'When the deployment has a public url then should link the instance',
      publicUrl: 'https://jardinero.example.test',
      workflowInstanceId: 'instance-1',
      wantUrl: 'https://jardinero.example.test/dashboard/operation?workflow_instance_id=instance-1',
    },
    {
      name: 'When the public url ends in slashes then should not double them',
      publicUrl: 'https://jardinero.example.test//',
      workflowInstanceId: 'instance-1',
      wantUrl: 'https://jardinero.example.test/dashboard/operation?workflow_instance_id=instance-1',
    },
    {
      name: 'When a sandbox run is named then should carry it too',
      publicUrl: 'https://jardinero.example.test',
      workflowInstanceId: 'instance-1',
      sandboxRunId: 'run-1',
      wantUrl:
        'https://jardinero.example.test/dashboard/operation?workflow_instance_id=instance-1&sandbox_run_id=run-1',
    },
    {
      name: 'When no sandbox run is named then should leave it out',
      publicUrl: 'https://jardinero.example.test',
      workflowInstanceId: 'instance-1',
      sandboxRunId: null,
      wantUrl: 'https://jardinero.example.test/dashboard/operation?workflow_instance_id=instance-1',
    },
    {
      // A local instance is not reachable, so there is no link to hand anybody.
      name: 'When the deployment has no public url then should answer no link',
      publicUrl: '   ',
      workflowInstanceId: 'instance-1',
      wantUrl: undefined,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(
        operationUrl(testCase.publicUrl, testCase.workflowInstanceId, testCase.sandboxRunId),
        testCase.wantUrl,
      );
    });
  }
});
