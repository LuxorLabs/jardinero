import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isSafeUuid } from './ids.js';

describe('isSafeUuid', () => {
  const cases: Array<{ name: string; value: string; want: boolean }> = [
    {
      name: 'When the value is a v4 uuid then should accept it',
      value: '6208e9eb-1490-4288-8547-5ccb7d214b91',
      want: true,
    },
    {
      name: 'When the value is uppercase then should accept it',
      value: '6208E9EB-1490-4288-8547-5CCB7D214B91',
      want: true,
    },
    {
      name: 'When the version nibble is zero then should return error',
      value: '6208e9eb-1490-0288-8547-5ccb7d214b91',
      want: false,
    },
    {
      name: 'When the variant nibble is out of range then should return error',
      value: '6208e9eb-1490-4288-0547-5ccb7d214b91',
      want: false,
    },
    {
      name: 'When the value is a path traversal then should return error',
      value: '../../etc/passwd',
      want: false,
    },
    {
      // A prefix match would let a probe ride along after a valid id.
      name: 'When a valid uuid carries a suffix then should return error',
      value: '6208e9eb-1490-4288-8547-5ccb7d214b91/../secrets',
      want: false,
    },
    { name: 'When the value is empty then should return error', value: '', want: false },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(isSafeUuid(testCase.value), testCase.want);
    });
  }
});
