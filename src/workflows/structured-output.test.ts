import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { findMarkedJsonObject, findShapedJsonObject } from './structured-output.js';

const MARKER = 'RESULT_JSON:';

describe('findMarkedJsonObject', () => {
  const cases: Array<{
    name: string;
    text: string;
    shaped?: (value: Record<string, unknown>) => boolean;
    want?: Record<string, unknown>;
  }> = [
    {
      name: 'When one payload follows the marker then should return it',
      text: `${MARKER} {"ok":true}`,
      want: { ok: true },
    },
    {
      name: 'When there is no marker then should return undefined',
      text: 'just prose',
    },
    {
      // Agents narrate the marker ("I will end with RESULT_JSON:") long before the
      // real block, so the last occurrence is the payload.
      name: 'When the marker is narrated first then should take the last occurrence',
      text: `I will end with ${MARKER} soon.\nDone.\n${MARKER} {"real":true}`,
      want: { real: true },
    },
    {
      name: 'When the payload is fenced then should unwrap the fence',
      text: `${MARKER}\n\`\`\`json\n{"fenced":true}\n\`\`\``,
      want: { fenced: true },
    },
    {
      name: 'When the payload nests objects then should keep the whole block',
      text: `${MARKER} {"a":{"b":1}}`,
      want: { a: { b: 1 } },
    },
    {
      // Braces inside a string must not close the object early.
      name: 'When a string holds a brace then should not cut the object short',
      text: `${MARKER} {"text":"} not the end","ok":true}`,
      want: { text: '} not the end', ok: true },
    },
    {
      name: 'When a string holds an escaped quote then should keep parsing',
      text: `${MARKER} {"text":"say \\"hi\\"","ok":true}`,
      want: { text: 'say "hi"', ok: true },
    },
    {
      name: 'When the payload is malformed then should return undefined',
      text: `${MARKER} {not json`,
    },
    {
      name: 'When the payload is an array then should return undefined',
      text: `${MARKER} [1,2]`,
    },
    {
      // An unrelated object the agent printed must not shadow the payload, so a
      // shaped candidate wins over an earlier one.
      name: 'When an unshaped object comes first then should prefer the shaped one',
      text: `${MARKER} {"config":1} and then {"verdict":"accept"}`,
      shaped: (value) => 'verdict' in value,
      want: { verdict: 'accept' },
    },
    {
      name: 'When nothing matches the shape then should fall back to the payload',
      text: `${MARKER} {"config":1}`,
      shaped: (value) => 'verdict' in value,
      want: { config: 1 },
    },
    {
      name: 'When the payload is malformed then should not fall back to a piece of it',
      text: `${MARKER} {"telemetry":{"ok":true},"candidates":[{"service":"api"}],}}`,
      shaped: (value) => 'verdict' in value,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.deepEqual(findMarkedJsonObject(testCase.text, MARKER, testCase.shaped), testCase.want);
    });
  }
});

describe('findShapedJsonObject', () => {
  const cases: Array<{ name: string; text: string; want?: Record<string, unknown> }> = [
    {
      // The fallback for agents that emit the payload without its marker.
      name: 'When a shaped object appears anywhere then should return it',
      text: 'prose {"verdict":"accept"} more prose',
      want: { verdict: 'accept' },
    },
    {
      name: 'When the shaped object is fenced then should unwrap the fence',
      text: '```\n{"verdict":"reject"}\n```',
      want: { verdict: 'reject' },
    },
    { name: 'When no object matches the shape then should return undefined', text: '{"other":1}' },
    { name: 'When there is no object at all then should return undefined', text: 'nothing here' },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.deepEqual(
        findShapedJsonObject(testCase.text, (value) => 'verdict' in value),
        testCase.want,
      );
    });
  }
});
