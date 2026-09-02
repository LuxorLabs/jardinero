import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LineBuffer, codexEventDetail, isCodexMilestone } from './sandbox-worker.js';

const encoder = new TextEncoder();

describe('LineBuffer', () => {
  const lineBufferCases = [
    {
      name: 'When chunk has no newline then should buffer until a line completes',
      chunks: [
        { text: 'partial', final: false, want: [] },
        { text: ' line\n', final: false, want: ['partial line'] },
      ],
    },
    {
      name: 'When a line is split across chunks then should reassemble it',
      chunks: [
        { text: '{"a":1}\n{"b"', final: false, want: ['{"a":1}'] },
        { text: ':2}\n', final: false, want: ['{"b":2}'] },
      ],
    },
    {
      name: 'When stream is final with a remainder then should flush the remainder',
      chunks: [{ text: 'no-trailing-newline', final: true, want: ['no-trailing-newline'] }],
    },
    {
      name: 'When output has blank lines then should drop them',
      chunks: [{ text: '\n\nkept\n\n', final: false, want: ['kept'] }],
    },
  ];

  for (const c of lineBufferCases) {
    test(c.name, () => {
      const buffer = new LineBuffer();
      for (const chunk of c.chunks) {
        assert.deepEqual(buffer.push(encoder.encode(chunk.text), chunk.final), chunk.want);
      }
    });
  }

  test('When an undelimited line exceeds the cap then should drop it', () => {
    const buffer = new LineBuffer(10);
    assert.deepEqual(buffer.push(encoder.encode('x'.repeat(20)), false), []);
    // the oversized in-progress line is discarded, so the next complete line survives
    assert.deepEqual(buffer.push(encoder.encode('ok\n'), false), ['ok']);
  });
});

describe('codexEventDetail', () => {
  const detailCases = [
    {
      name: 'When event wraps a command item then should surface command and status',
      input: {
        type: 'item.completed',
        item: { item_type: 'command_execution', command: 'pnpm checks', status: 'in_progress' },
      },
      want: { item: 'command_execution', command: 'pnpm checks', status: 'in_progress' },
    },
    {
      name: 'When item has an `exit_code` then should include it',
      input: { type: 'item.completed', item: { type: 'command_execution', exit_code: 0 } },
      want: { item: 'command_execution', exit_code: 0 },
    },
    {
      name: 'When details live on the event root then should read from the root',
      input: { type: 'turn.started', status: 'active' },
      want: { status: 'active' },
    },
    {
      name: 'When command exceeds the limit then should truncate with an ellipsis',
      input: { type: 'item.started', item: { command: 'x'.repeat(600) } },
      want: { command: `${'x'.repeat(500)}…` },
    },
    {
      name: 'When item is an agent message then should surface its text',
      input: {
        type: 'item.completed',
        item: { type: 'agent_message', text: 'done fixing the query' },
      },
      want: { item: 'agent_message', text: 'done fixing the query' },
    },
    {
      name: 'When event is not an object then should return no detail',
      input: 'plain text',
      want: {},
    },
  ];

  for (const c of detailCases) {
    test(c.name, () => {
      assert.deepEqual(codexEventDetail(c.input), c.want);
    });
  }
});

describe('isCodexMilestone', () => {
  const milestoneCases = [
    {
      name: 'When type is item started then should be a milestone',
      type: 'agent.item.started',
      want: true,
    },
    {
      name: 'When type is item completed then should be a milestone',
      type: 'agent.item.completed',
      want: true,
    },
    {
      name: 'When type is thread started then should be a milestone',
      type: 'agent.thread.started',
      want: true,
    },
    {
      name: 'When type is turn completed then should be a milestone',
      type: 'agent.turn.completed',
      want: true,
    },
    {
      name: 'When type is item updated then should not be a milestone',
      type: 'agent.item.updated',
      want: false,
    },
    {
      name: 'When type is generic event then should not be a milestone',
      type: 'agent.event',
      want: false,
    },
  ];

  for (const c of milestoneCases) {
    test(c.name, () => {
      assert.equal(isCodexMilestone(c.type), c.want);
    });
  }
});
