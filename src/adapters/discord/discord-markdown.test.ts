import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { loadConfig } from '../../config.js';
import { discordPlainText, linearIssueMention, pullRequestMention } from './discord-markdown.js';

describe('linearIssueMention', () => {
  const cases: Array<{ name: string; workspaceUrl: string; want: string }> = [
    {
      name: 'When the Linear workspace is configured then should link the ticket',
      workspaceUrl: 'https://linear.app/acme',
      want: '[JAR-58](https://linear.app/acme/issue/JAR-58)',
    },
    {
      name: 'When the workspace url ends in a slash then should link the ticket without doubling it',
      workspaceUrl: 'https://linear.app/acme/',
      want: '[JAR-58](https://linear.app/acme/issue/JAR-58)',
    },
    {
      name: 'When the Linear workspace is not configured then should name the ticket bare',
      workspaceUrl: '',
      want: 'JAR-58',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const config = loadConfig();
      config.workflows.linearImplementer.workspaceUrl = testCase.workspaceUrl;

      assert.equal(linearIssueMention(config, 'JAR-58'), testCase.want);
    });
  }
});

describe('pullRequestMention', () => {
  const cases: Array<{ name: string; repositoryFullName?: string; want: string }> = [
    {
      name: 'When the repository is known then should link the pull request',
      repositoryFullName: 'acme/orchestrator',
      want: '[#4688](https://github.com/acme/orchestrator/pull/4688)',
    },
    {
      name: 'When the repository is not known then should name the pull request bare',
      want: '#4688',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(pullRequestMention(testCase.repositoryFullName, 4688), testCase.want);
    });
  }
});

describe('discordPlainText', () => {
  const cases: Array<{ name: string; text: string; want: string }> = [
    {
      name: 'When the text carries no markup then should leave it as is',
      text: 'fix the typo in the miners tab',
      want: 'fix the typo in the miners tab',
    },
    {
      name: 'When the text carries markdown then should escape every mark',
      text: '\\ ` * _ ~ | [link](https://elsewhere.example) # heading',
      want: '\\\\ \\` \\* \\_ \\~ \\| \\[link\\](https://elsewhere.example) \\# heading',
    },
    {
      name: 'When the text carries a mention then should escape it',
      text: '<@2002> and <#3003>',
      want: '\\<@2002> and \\<\\#3003>',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      assert.equal(discordPlainText(testCase.text), testCase.want);
    });
  }
});
