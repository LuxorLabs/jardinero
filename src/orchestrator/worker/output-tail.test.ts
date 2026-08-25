import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { OutputTail } from './output-tail.js';

describe('OutputTail.push', () => {
  const cases: Array<{ name: string; lines: string[]; maxLines: number; want: string }> = [
    {
      name: 'When the lines fit then should keep all of them in order',
      lines: ['first', 'second'],
      maxLines: 3,
      want: 'first\nsecond\n',
    },
    {
      name: 'When there are more lines than it holds then should keep the last ones',
      lines: ['first', 'second', 'third'],
      maxLines: 2,
      want: 'second\nthird\n',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const tail = new OutputTail(testCase.maxLines);

      for (const line of testCase.lines) tail.push(line);

      assert.equal(tail.text(), testCase.want);
    });
  }

  test('When the lines pass the byte cap then should keep only what fits', () => {
    const tail = new OutputTail(100, 14);

    tail.push('123456');
    tail.push('abcdef');

    assert.equal(tail.text(), '123456\nabcdef\n');

    tail.push('ghijkl');

    assert.equal(tail.text(), 'abcdef\nghijkl\n');
  });

  test('When one line is larger than the byte cap then should keep it', () => {
    const tail = new OutputTail(100, 4);

    tail.push('a line nobody can shorten');

    assert.equal(tail.text(), 'a line nobody can shorten\n');
  });
});

describe('OutputTail.isEmpty', () => {
  const cases: Array<{ name: string; lines: string[]; want: boolean }> = [
    { name: 'When nothing was pushed then should answer true', lines: [], want: true },
    { name: 'When a line was pushed then should answer false', lines: ['first'], want: false },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const tail = new OutputTail();

      for (const line of testCase.lines) tail.push(line);

      assert.equal(tail.isEmpty(), testCase.want);
    });
  }
});
