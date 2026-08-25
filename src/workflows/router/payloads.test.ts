import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { RequestRouter } from '../../store/types.js';
import { requestRouterPayload } from './payloads.js';

describe('requestRouterPayload', () => {
  const cases: RouterCase[] = [
    {
      name: 'When the request carries text then should carry it with its source',
      instance: { requestText: 'look at the failing checks' },
      want: { request_source: 'discord', request_text: 'look at the failing checks' },
    },
    {
      // A cron request has no text, and the agent is told the source instead of
      // being handed an empty field.
      name: 'When the request carries no text then should carry only the source',
      instance: { requestSource: 'cron' },
      want: { request_source: 'cron' },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const payload = requestRouterPayload(request(c.instance));

      assert.deepEqual(payload, c.want);
    });
  }
});

function request(overrides: Partial<RequestRouter> = {}): RequestRouter {
  return {
    id: 'instance-1',
    requestSource: 'discord',
    workflowState: 'rr_pending',
    requestText: null,
    requesterExternalId: null,
    replyTargetType: null,
    replyTargetId: null,
    repositoryId: null,
    subjectType: null,
    subjectExternalId: null,
    resolutionNote: null,
    workflowType: null,
    workflowInstanceId: null,
    consumedAt: null,
    sandboxRunId: null,
    lastStateCheckedAt: null,
    stateChangedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

interface RouterCase {
  name: string;
  instance?: Partial<RequestRouter>;
  want: Record<string, unknown>;
}
