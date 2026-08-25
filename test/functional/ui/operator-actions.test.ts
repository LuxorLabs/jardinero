import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

interface OperatorActionCase {
  name: string;
  source: string;
  offers: RegExp;
}

// The queue and Operation act on the same instance through the same endpoints, and the
// only thing keeping them from offering different buttons, or offering one the endpoint
// refuses, is a test that reads what each renders.
const cases: OperatorActionCase[] = [
  {
    name: 'When the actions offer to retry a verification then should offer it only for the Linear implementer',
    source: 'web/src/components/WorkflowInstanceActions.tsx',
    offers:
      /instance\.workflow_type === 'linear_implementer' && \(\s*<button[\s\S]*?'retry-verification'/,
  },
  {
    name: 'When the queue lists an instance that needs a person then should offer the shared actions',
    source: 'web/src/tabs/OverviewTab.tsx',
    offers: /action=\{\(instance\) => <WorkflowInstanceActions instance=\{instance\} \/>\}/,
  },
  {
    name: 'When Operation opens an instance that needs a person then should offer the shared actions',
    source: 'web/src/tabs/OperationTab.tsx',
    offers: /instance\.requires_attention && <WorkflowInstanceActions instance=\{instance\} \/>/,
  },
];

for (const testCase of cases) {
  test(testCase.name, () => {
    assert.match(read(testCase.source), testCase.offers);
  });
}

function read(relative: string): string {
  return readFileSync(path.resolve(process.cwd(), relative), 'utf8');
}
