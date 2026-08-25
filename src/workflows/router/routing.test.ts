import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseRouting, ROUTING_JSON_MARKER } from './routing.js';

describe('parseRouting', () => {
  const cases: RoutingCase[] = [
    {
      name: 'When the agent placed the request then should read every field it answered',
      answer: {
        subject_type: 'linear_issue',
        subject_external_id: 'JAR-58',
        repository_full_name: 'acme/web.app',
        resolution_note: null,
      },
      want: {
        routing: {
          subjectType: 'linear_issue',
          subjectExternalId: 'JAR-58',
          repositoryFullName: 'acme/web.app',
        },
      },
    },
    {
      // A request the agent could not place is an answer, not a failure: the note
      // is what gets sent back to whoever asked.
      name: 'When the agent could not place it then should read the note it wrote back',
      answer: { subject_type: null, resolution_note: 'which repository?' },
      want: { routing: { resolutionNote: 'which repository?' } },
    },
    {
      name: 'When the answer names a pull request then should read its number as text',
      answer: { subject_type: 'pull_request', subject_external_id: '4688' },
      want: { routing: { subjectType: 'pull_request', subjectExternalId: '4688' } },
    },
    {
      name: 'When the answer names a log target then should read the service',
      answer: { subject_type: 'log_target', subject_external_id: 'api' },
      want: { routing: { subjectType: 'log_target', subjectExternalId: 'api' } },
    },
    {
      name: 'When the subject type is not one we know then should refuse the answer',
      answer: { subject_type: 'whatever', subject_external_id: 'x' },
      want: { rejectionReason: 'invalid_subject_type' },
    },
    {
      // A subject type with no id identifies nothing to act on.
      name: 'When the subject has no id then should refuse the answer',
      answer: { subject_type: 'pull_request', resolution_note: 'no id' },
      want: { rejectionReason: 'subject_without_id' },
    },
    {
      name: 'When a field is blank then should read it as absent',
      answer: {
        subject_type: 'linear_issue',
        subject_external_id: 'JAR-58',
        repository_full_name: '   ',
        requested_action: '',
      },
      want: { routing: { subjectType: 'linear_issue', subjectExternalId: 'JAR-58' } },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const result = parseRouting(`done\n${ROUTING_JSON_MARKER} ${JSON.stringify(c.answer)}`);

      assert.equal(result.rejectionReason, c.want.rejectionReason);
      assert.deepEqual(routingWithoutRaw(result.routing), c.want.routing);
    });
  }

  const absentCases: AbsentCase[] = [
    { name: 'When there is no text then should read nothing', text: undefined },
    { name: 'When the text is blank then should read nothing', text: '   ' },
    { name: 'When the agent emitted no marker then should read nothing', text: 'all done' },
  ];

  for (const c of absentCases) {
    test(c.name, () => {
      const result = parseRouting(c.text);

      assert.deepEqual(result, {});
    });
  }

  // A marker the agent wrote and we cannot read is a broken answer, unlike no
  // marker at all.
  test('When the marker carries no readable object then should refuse the answer', () => {
    const result = parseRouting(`${ROUTING_JSON_MARKER} {not json`);

    assert.equal(result.rejectionReason, 'marker_invalid_json');
    assert.equal(result.routing, undefined);
  });

  // An answer is either a subject or the questions that stand in its way.
  test('When the object carries neither a subject nor a note then should refuse it', () => {
    const result = parseRouting(`${ROUTING_JSON_MARKER} {"something":"else"}`);

    assert.equal(result.rejectionReason, 'neither_subject_nor_note');
    assert.equal(result.routing, undefined);
  });

  // The whole object is kept so an operator can read what the agent really said.
  test('When the answer is read then should keep the object the agent emitted', () => {
    const result = parseRouting(
      `${ROUTING_JSON_MARKER} {"subject_type":"log_target","subject_external_id":"api"}`,
    );

    assert.deepEqual(result.routing?.raw, {
      subject_type: 'log_target',
      subject_external_id: 'api',
    });
  });
});

function routingWithoutRaw(
  routing: ReturnType<typeof parseRouting>['routing'],
): Record<string, unknown> | undefined {
  if (!routing) return undefined;
  const { raw: _raw, ...rest } = routing;
  return rest;
}

interface RoutingCase {
  name: string;
  answer: Record<string, unknown>;
  want: { routing?: Record<string, unknown>; rejectionReason?: string };
}

interface AbsentCase {
  name: string;
  text: string | undefined;
}
