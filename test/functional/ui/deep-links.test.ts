import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

interface LinkingTabCase {
  name: string;
  source: string;
}

// The link to one workflow instance is what an operator copies out of the dashboard, so a
// tab that builds that URL by hand is how one of them ends up naming a parameter Operation
// does not read.
const cases: LinkingTabCase[] = [
  { name: 'the factory overview', source: 'web/src/tabs/OverviewTab.tsx' },
  { name: 'the event feed', source: 'web/src/tabs/EventsTab.tsx' },
  { name: 'Operation', source: 'web/src/tabs/OperationTab.tsx' },
];

for (const testCase of cases) {
  test(`When ${testCase.name} links a workflow instance then should build the link with operationHref`, () => {
    const source = read(testCase.source);

    assert.match(source, /import \{ operationHref \} from '@\/lib\/links'/);
    assert.doesNotMatch(source, /\/dashboard\/operation\?workflow_instance_id/);
  });
}

test('When a link opens Operation then should carry the parameter the tab reads', () => {
  assert.match(read('web/src/lib/links.ts'), /workflow_instance_id: workflowInstanceId/);
  assert.match(read('web/src/tabs/OperationTab.tsx'), /searchParam\('workflow_instance_id'\)/);
});

function read(relative: string): string {
  return readFileSync(path.resolve(process.cwd(), relative), 'utf8');
}
