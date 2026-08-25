import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { linearIssueConversationKey, linearIssueOfConversationKey } from './work-announcer.js';

describe('linearIssueConversationKey', () => {
  const cases: Array<{ name: string; linearIssueIdentifier: string; wantKey: string }> = [
    {
      name: 'When the ticket is named then should file the conversation under it',
      linearIssueIdentifier: 'JAR-58',
      wantKey: 'linear_issue:JAR-58',
    },
    {
      // Whoever asks writes the identifier by hand, and both doors have to agree on the key.
      name: 'When it is written in lower case then should file it as Linear writes it',
      linearIssueIdentifier: 'jar-58',
      wantKey: 'linear_issue:JAR-58',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(linearIssueConversationKey(testCase.linearIssueIdentifier), testCase.wantKey);
    });
  }
});

describe('linearIssueOfConversationKey', () => {
  const cases: Array<{ name: string; conversationKey: string; wantIdentifier?: string }> = [
    {
      name: 'When the key is a ticket then should answer the ticket',
      conversationKey: 'linear_issue:JAR-58',
      wantIdentifier: 'JAR-58',
    },
    {
      name: 'When the key is a pull request then should answer nothing',
      conversationKey: 'pull_request:repository-1:4688',
      wantIdentifier: undefined,
    },
    {
      name: 'When the key names no subject then should answer nothing',
      conversationKey: 'fix_implementer:instance-1',
      wantIdentifier: undefined,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(linearIssueOfConversationKey(testCase.conversationKey), testCase.wantIdentifier);
    });
  }
});
