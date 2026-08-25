import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MAX_PROMPT_LENGTH } from '../workflows/agents.js';
import { EDITABLE_PROMPT_SEGMENT } from '../workflows/prompt-segment.js';
import type { Store } from './store.js';
import { createTestStore } from '../testing/store.js';

describe('Store.upsertPrompt', () => {
  test('When new repo agent pair then should create successfully', () => {
    const fixture = createTestStore();
    try {
      const row = fixture.store.upsertPrompt({
        repo: 'Owner/Repo',
        agent: 'log_reviewer',
        instructions: 'Check the runbook first.',
      });
      assert.equal(row.repo, 'owner/repo');
      assert.equal(row.agent, 'log_reviewer');
      assert.equal(row.instructions, 'Check the runbook first.');
      assert.equal(row.enabled, true);
      assert.equal(row.createdAt, row.updatedAt);
    } finally {
      fixture.cleanup();
    }
  });

  test('When existing pair upserted then should update and keep `created_at`', () => {
    const fixture = createTestStore();
    try {
      const created = fixture.store.upsertPrompt({
        repo: 'owner/repo',
        agent: 'log_reviewer',
        instructions: 'First version.',
      });
      const updated = fixture.store.upsertPrompt({
        repo: 'owner/repo',
        agent: 'log_reviewer',
        instructions: 'Second version.',
        enabled: false,
      });
      assert.equal(updated.instructions, 'Second version.');
      assert.equal(updated.enabled, false);
      assert.equal(updated.createdAt, created.createdAt);
      assert(updated.updatedAt >= created.updatedAt);
      assert.equal(fixture.store.listPrompts().length, 1);
    } finally {
      fixture.cleanup();
    }
  });

  test('When instructions exceed cap then should return error', () => {
    const fixture = createTestStore();
    try {
      assert.throws(
        () =>
          fixture.store.upsertPrompt({
            repo: 'owner/repo',
            agent: 'log_reviewer',
            instructions: 'x'.repeat(MAX_PROMPT_LENGTH + 1),
          }),
        /exceed/,
      );
      assert.equal(fixture.store.listPrompts().length, 0);
    } finally {
      fixture.cleanup();
    }
  });

  test('When writing audit then should record lengths not text', () => {
    const fixture = createTestStore();
    try {
      fixture.store.upsertPrompt({
        repo: 'owner/repo',
        agent: 'pr_maintainer',
        instructions: 'Secret internal context.',
      });
      fixture.store.deletePrompt('owner/repo', 'pr_maintainer');
      const saved = readEventMetadata(fixture.store, 'operator.prompt_saved');
      assert.equal(saved.repo, 'owner/repo');
      assert.equal(saved.agent, 'pr_maintainer');
      assert.equal(saved.enabled, true);
      assert.equal(saved.length, 'Secret internal context.'.length);
      assert.equal('instructions' in saved, false);
      const deleted = readEventMetadata(fixture.store, 'operator.prompt_deleted');
      assert.equal(deleted.repo, 'owner/repo');
      assert.equal(deleted.agent, 'pr_maintainer');
    } finally {
      fixture.cleanup();
    }
  });
});

describe('Store.deletePrompt', () => {
  test('When row is missing then should return false', () => {
    const fixture = createTestStore();
    try {
      assert.equal(fixture.store.deletePrompt('owner/repo', 'log_reviewer'), false);
    } finally {
      fixture.cleanup();
    }
  });

  test('When row exists then should delete successfully', () => {
    const fixture = createTestStore();
    try {
      fixture.store.upsertPrompt({
        repo: 'owner/repo',
        agent: 'log_reviewer',
        instructions: 'Some text.',
      });
      assert.equal(fixture.store.deletePrompt('Owner/Repo', 'log_reviewer'), true);
      assert.equal(fixture.store.listPrompts().length, 0);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('Store.promptsVersion', () => {
  test('When any row is deleted then should change marker', () => {
    const fixture = createTestStore();
    try {
      // The non-latest row is the interesting case: MAX(updated_at) alone would
      // not move when it is deleted, so the marker must also track the count.
      fixture.store.upsertPrompt({
        repo: 'owner/older',
        agent: 'log_reviewer',
        instructions: 'older',
      });
      fixture.store.upsertPrompt({
        repo: 'owner/newer',
        agent: 'log_reviewer',
        instructions: 'newer',
      });
      const before = fixture.store.promptsVersion();
      fixture.store.deletePrompt('owner/older', 'log_reviewer');
      assert.notEqual(fixture.store.promptsVersion(), before);
    } finally {
      fixture.cleanup();
    }
  });

  test('When no rows exist then should return zero marker', () => {
    const fixture = createTestStore();
    try {
      assert.equal(fixture.store.promptsVersion(), '0.0');
    } finally {
      fixture.cleanup();
    }
  });
});

describe('Store.resolvePromptOverrides', () => {
  // Override semantics: the guidance segment resolves most-specific-wins. A repo
  // override replaces the global default, which replaces the built-in guidance; a
  // disabled or blank row is ignored so the built-in guidance stays in force.
  const resolutionCases = [
    {
      name: 'When global and repo both set then should prefer repo',
      rows: [
        { repo: '*', instructions: 'global' },
        { repo: 'owner/repo', instructions: 'repo' },
      ],
      resolveRepo: 'owner/repo' as string | undefined,
      want: 'repo' as string | undefined,
    },
    {
      name: 'When repo is disabled then should fall back to global',
      rows: [
        { repo: '*', instructions: 'global' },
        { repo: 'owner/repo', instructions: 'repo', enabled: false },
      ],
      resolveRepo: 'owner/repo' as string | undefined,
      want: 'global' as string | undefined,
    },
    {
      name: 'When repo text is blank then should fall back to global',
      rows: [
        { repo: '*', instructions: 'global' },
        { repo: 'owner/repo', instructions: '   \n  ' },
      ],
      resolveRepo: 'owner/repo' as string | undefined,
      want: 'global' as string | undefined,
    },
    {
      name: 'When global is disabled and repo set then should return repo',
      rows: [
        { repo: '*', instructions: 'global', enabled: false },
        { repo: 'owner/repo', instructions: 'repo' },
      ],
      resolveRepo: 'owner/repo' as string | undefined,
      want: 'repo' as string | undefined,
    },
    {
      name: 'When repo is undefined then should return global',
      rows: [
        { repo: '*', instructions: 'global' },
        { repo: 'owner/repo', instructions: 'repo' },
      ],
      resolveRepo: undefined as string | undefined,
      want: 'global' as string | undefined,
    },
    {
      name: 'When repo case differs then should match case insensitively',
      rows: [{ repo: 'owner/repo', instructions: 'repo' }],
      resolveRepo: 'Owner/Repo' as string | undefined,
      want: 'repo' as string | undefined,
    },
    {
      name: 'When both scopes disabled then should return no override',
      rows: [
        { repo: '*', instructions: 'global', enabled: false },
        { repo: 'owner/repo', instructions: 'repo', enabled: false },
      ],
      resolveRepo: 'owner/repo' as string | undefined,
      want: undefined as string | undefined,
    },
    {
      name: 'When no rows exist then should return no override',
      rows: [] as { repo: string; instructions: string; enabled?: boolean }[],
      resolveRepo: 'owner/repo' as string | undefined,
      want: undefined as string | undefined,
    },
  ];

  for (const c of resolutionCases) {
    test(c.name, () => {
      const fixture = createTestStore();
      try {
        for (const row of c.rows) {
          fixture.store.upsertPrompt({ agent: 'log_reviewer', ...row });
        }
        assert.deepEqual(
          fixture.store.resolvePromptOverrides(c.resolveRepo, 'log_reviewer'),
          c.want === undefined ? {} : { [EDITABLE_PROMPT_SEGMENT]: c.want },
        );
      } finally {
        fixture.cleanup();
      }
    });
  }
});

function readEventMetadata(store: Store, eventType: string): Record<string, unknown> {
  const [row] = store.queryReadOnly('SELECT metadata FROM event_log WHERE event_type = ?', [
    eventType,
  ]) as Array<{ metadata: string }>;
  return JSON.parse(row.metadata) as Record<string, unknown>;
}
