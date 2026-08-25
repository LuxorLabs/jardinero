import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { segment } from './prompt-segment.js';

describe('segment', () => {
  const cases: Array<{ name: string; lines: string[]; wantText: string }> = [
    {
      name: 'When several lines are given then should join them with newlines',
      lines: ['first', 'second'],
      wantText: 'first\nsecond',
    },
    {
      name: 'When a single line is given then should keep it as is',
      lines: ['only'],
      wantText: 'only',
    },
    { name: 'When no lines are given then should produce empty text', lines: [], wantText: '' },
    {
      // Blank lines are meaningful: the renderer relies on them to separate
      // paragraphs inside a segment.
      name: 'When a line is blank then should preserve it',
      lines: ['first', '', 'third'],
      wantText: 'first\n\nthird',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.deepEqual(segment('guidance', 'Guidance', true, testCase.lines), {
        key: 'guidance',
        title: 'Guidance',
        editable: true,
        text: testCase.wantText,
      });
    });
  }

  test('When the segment is locked then should carry the flag through', () => {
    assert.equal(segment('contract', 'Output contract', false, ['x']).editable, false);
  });
});
