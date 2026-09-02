import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { finalAgentMessageText } from './sandbox-worker.js';

describe('finalAgentMessageText', () => {
  const cases: Array<{ name: string; events: unknown[]; want: string | undefined }> = [
    {
      name: 'When several agent messages completed then should return the last one',
      events: [
        { type: 'item.completed', item: { type: 'agent_message', text: 'I will inspect it.' } },
        { type: 'item.completed', item: { type: 'agent_message', text: 'Done inspecting.' } },
      ],
      want: 'Done inspecting.',
    },
    {
      name: 'When other item types are interleaved then should ignore them',
      events: [
        { type: 'item.completed', item: { type: 'agent_message', text: 'the handoff' } },
        { type: 'item.completed', item: { type: 'command_execution', text: 'npm test' } },
        { type: 'turn.completed', usage: {} },
      ],
      want: 'the handoff',
    },
    {
      name: 'When no agent message is present then should return undefined',
      events: [{ type: 'item.completed', item: { type: 'command_execution', text: 'npm test' } }],
      want: undefined,
    },
    {
      name: 'When the event list is empty then should return undefined',
      events: [],
      want: undefined,
    },
    {
      name: 'When an event is not an object then should ignore it',
      events: [
        'nope',
        null,
        { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } },
      ],
      want: 'ok',
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.equal(finalAgentMessageText(c.events), c.want);
    });
  }
});
