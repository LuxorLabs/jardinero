import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CodexOutputFile,
  LineBuffer,
  codexEventDetail,
  isCodexMilestone,
  parseCodexExitCode,
} from './sandbox-worker.js';

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

describe('parseCodexExitCode', () => {
  const cases = [
    { name: 'When the file holds an exit code then should read it', text: '137\n', want: 137 },
    { name: 'When the file is still empty then should read no exit', text: '', want: undefined },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.equal(parseCodexExitCode(c.text), c.want);
    });
  }
});

describe('CodexOutputFile', () => {
  const cases = [
    {
      name: 'When a read ends in whole lines then should take them and read on past them',
      reads: [{ text: 'one\ntwo\n', final: false }],
      want: { taken: ['one\ntwo\n'], nextLine: 3, text: 'one\ntwo\n' },
    },
    {
      name: 'When a read ends inside a line then should leave that line for the next read',
      reads: [
        { text: 'one\ntw', final: false },
        { text: 'two\n', final: false },
      ],
      want: { taken: ['one\n', 'two\n'], nextLine: 3, text: 'one\ntwo\n' },
    },
    {
      name: 'When Codex has exited then should take the last line with no newline too',
      reads: [{ text: 'one\ntwo', final: true }],
      want: { taken: ['one\ntwo'], nextLine: 3, text: 'one\ntwo' },
    },
    {
      name: 'When a read has nothing new then should take nothing',
      reads: [{ text: '', final: false }],
      want: { taken: [''], nextLine: 1, text: '' },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const file = new CodexOutputFile('codex-stdout.log', false);

      const taken = c.reads.map((read) => file.take(read.text, read.final));

      assert.deepEqual({ taken, nextLine: file.nextLine(), text: file.text() }, c.want);
    });
  }
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
