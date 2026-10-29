import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { SandboxRunContext } from '../sandbox-pool.js';
import { finalAgentMessageText, redactingContext } from './sandbox-worker.js';

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

describe('redactingContext', () => {
  const cases: Array<{
    name: string;
    act(context: SandboxRunContext): Promise<unknown>;
    want: Recorded;
  }> = [
    {
      name: 'When an event carries the secret in its message and data then should mask both',
      act: (context) =>
        context.publishEvent({
          type: 'agent.finished',
          message: 'printed age-secret-key-1',
          data: { stdout: ['SUPERAPP_DEV_AGE_KEY=age-secret-key-1'] },
        }),
      want: {
        events: [
          {
            type: 'agent.finished',
            message: 'printed [*****]',
            data: { stdout: ['SUPERAPP_DEV_AGE_KEY=[*****]'] },
          },
        ],
        artifacts: [],
      },
    },
    {
      name: 'When an event has no message nor data then should publish it as it is',
      act: (context) => context.publishEvent({ type: 'agent.cost_unknown' }),
      want: {
        events: [{ type: 'agent.cost_unknown', message: undefined, data: undefined }],
        artifacts: [],
      },
    },
    {
      name: 'When a text artifact carries the secret then should mask it',
      act: (context) =>
        context.writeSandboxRunArtifact('prompt.txt', 'SUPERAPP_DEV_AGE_KEY=age-secret-key-1'),
      want: {
        events: [],
        artifacts: [{ name: 'prompt.txt', content: 'SUPERAPP_DEV_AGE_KEY=[*****]' }],
      },
    },
    {
      name: 'When a binary artifact is written then should keep its bytes',
      act: (context) =>
        context.writeSandboxRunArtifact('evidence.png', Buffer.from('age-secret-key-1')),
      want: {
        events: [],
        artifacts: [{ name: 'evidence.png', content: Buffer.from('age-secret-key-1') }],
      },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const recorded: Recorded = { events: [], artifacts: [] };

      await c.act(
        redactingContext(recordingContext(recorded), (text) =>
          text.replaceAll('age-secret-key-1', '[*****]'),
        ),
      );

      assert.deepEqual(recorded, c.want);
    });
  }
});

interface Recorded {
  events: Array<{ type: string; message?: string; data?: Record<string, unknown> }>;
  artifacts: Array<{ name: string; content: string | Buffer }>;
}

function recordingContext(recorded: Recorded): SandboxRunContext {
  return {
    sandboxRun: {
      id: 'run-redacting-test',
      agentName: 'PrMaintainer',
      runState: 'running',
      workflowType: 'pr_maintainer',
      workflowInstanceId: 'instance-1',
      sandboxSessionId: null,
      costUsd: null,
      errorMessage: null,
      startedAt: 0,
      endedAt: null,
    },
    task: { workflow: 'pr_maintain', payload: {}, promptOverrides: {} },
    maxWallClockMs: 60_000,
    signal: new AbortController().signal,
    isStopping: () => false,
    publishEvent: async (event) => {
      recorded.events.push(event);
    },
    writeSandboxRunArtifact: async (name, content) => {
      recorded.artifacts.push({ name, content });
      return name;
    },
  };
}
