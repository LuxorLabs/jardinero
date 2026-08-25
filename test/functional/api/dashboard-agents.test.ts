import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { PromptsResponse } from '../../../src/transport/dashboard/dashboard-api-types.js';
import { WORKFLOW_TYPES } from '../../../src/store/types.js';
import { AGENT_KINDS, MAX_PROMPT_LENGTH } from '../../../src/workflows/agents.js';
import { EDITABLE_PROMPT_SEGMENT } from '../../../src/workflows/prompt-segment.js';
import { createAgentsHttpFixture, postJson, readEvents } from '../../../src/testing/http.js';

describe('GET /dashboard/api/agents', () => {
  test('When no app session exists then should answer', async () => {
    const fixture = await createAgentsHttpFixture();
    try {
      const response = await fetch(`${fixture.baseUrl}/dashboard/api/agents`);
      assert.equal(response.status, 200);
    } finally {
      await fixture.cleanup();
    }
  });

  test('When a repository is only named by the Linear routing then should offer it as a scope', async () => {
    const fixture = await createAgentsHttpFixture((config) => {
      config.workflows.linearImplementer.teamRepos.ZZZ = 'acme/only-in-routing';
    });
    try {
      const response = await fetch(`${fixture.baseUrl}/dashboard/api/agents`);
      const body = (await response.json()) as PromptsResponse;
      assert(body.known_repos.includes('acme/only-in-routing'));
    } finally {
      await fixture.cleanup();
    }
  });

  test('When requested then should return the catalog with its seven agents', async () => {
    const fixture = await createAgentsHttpFixture();
    try {
      const response = await fetch(`${fixture.baseUrl}/dashboard/api/agents`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as PromptsResponse;
      assert.equal(body.agents.length, AGENT_KINDS.length);
      for (const entry of body.agents) {
        assert(AGENT_KINDS.includes(entry.agent as (typeof AGENT_KINDS)[number]));
        assert(entry.label.length > 0);
        assert(entry.segments.length > 0);
        assert(WORKFLOW_TYPES.includes(entry.workflow_type));
        assert(entry.workflow_label.length > 0);
        // Exactly one editable guidance segment; the rest (context, contract) are locked.
        const editable = entry.segments.filter((seg) => seg.editable);
        assert.equal(editable.length, 1);
        assert.equal(editable[0].key, EDITABLE_PROMPT_SEGMENT);
        assert(editable[0].text.length > 0);
      }
      assert.equal(body.max_instructions_length, MAX_PROMPT_LENGTH);
      assert.deepEqual(body.known_repos, ['acme/widgets']);
      assert.deepEqual(body.instructions, []);
      // Both agents of the ticket loop are grouped under the one workflow that runs them.
      const linear = body.agents.filter((entry) => entry.workflow_type === 'linear_implementer');
      assert.deepEqual(
        linear.map((entry) => entry.agent),
        ['linear_implementer', 'linear_verifier'],
      );
      assert.deepEqual(
        [...new Set(linear.map((entry) => entry.workflow_label))],
        ['LinearImplementer'],
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('POST /dashboard/api/agents/instructions', () => {
  const upsertValidationCases = [
    {
      name: 'When confirmed is missing then should return error',
      body: { repo: '*', agent: 'log_reviewer', instructions: 'text' },
      wantStatus: 400,
      wantError: 'instructions_confirmation_required',
    },
    {
      name: 'When agent is unknown then should return error',
      body: { repo: '*', agent: 'gardener', instructions: 'text', confirmed: true },
      wantStatus: 400,
      wantError: 'invalid_agent',
    },
    {
      name: 'When repo is not a slug then should return error',
      body: { repo: 'not a slug', agent: 'log_reviewer', instructions: 'text', confirmed: true },
      wantStatus: 400,
      wantError: 'invalid_repo',
    },
    {
      name: 'When instructions are missing then should return error',
      body: { repo: '*', agent: 'log_reviewer', confirmed: true },
      wantStatus: 400,
      wantError: 'invalid_instructions',
    },
    {
      name: 'When instructions are blank then should return error',
      body: { repo: '*', agent: 'log_reviewer', instructions: '   ', confirmed: true },
      wantStatus: 400,
      wantError: 'invalid_instructions',
    },
    {
      name: 'When instructions exceed cap then should return error',
      body: {
        repo: '*',
        agent: 'log_reviewer',
        instructions: 'x'.repeat(MAX_PROMPT_LENGTH + 1),
        confirmed: true,
      },
      wantStatus: 400,
      wantError: 'instructions_too_long',
    },
    {
      name: 'When enabled is not boolean then should return error',
      body: {
        repo: '*',
        agent: 'log_reviewer',
        instructions: 'text',
        enabled: 'yes',
        confirmed: true,
      },
      wantStatus: 400,
      wantError: 'invalid_enabled',
    },
  ];

  // One boot covers every rejection shape; a test per row would pay seven server
  // boots for a single validation pass.
  test('When the payload is invalid then should return the matching error', async () => {
    const fixture = await createAgentsHttpFixture();
    try {
      for (const testCase of upsertValidationCases) {
        const response = await postJson(
          `${fixture.baseUrl}/dashboard/api/agents/instructions`,
          testCase.body,
        );

        assert.equal(response.status, testCase.wantStatus, testCase.name);
        const body = (await response.json()) as { error: string };
        assert.equal(body.error, testCase.wantError, testCase.name);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the row is new then should create successfully', async () => {
    const fixture = await createAgentsHttpFixture();
    try {
      const response = await postJson(`${fixture.baseUrl}/dashboard/api/agents/instructions`, {
        repo: 'acme/Webapp',
        agent: 'pr_maintainer',
        instructions: 'Reference the Linear ticket in every reply.',
        confirmed: true,
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        ok: boolean;
        instruction: { repo: string; enabled: boolean; revision: string };
        revision: string;
      };
      assert.equal(body.ok, true);
      assert.equal(body.instruction.repo, 'acme/webapp');
      assert.equal(body.instruction.enabled, true);
      assert.equal(body.revision, body.instruction.revision);
      const upserts = readEvents(fixture.store, 'operator.prompt_saved');
      assert.equal(upserts.length, 1);
      const mutations = readEvents(fixture.store, 'operator.dashboard_write_requested');
      assert(mutations.some((entry) => entry.action === 'upsert_prompt'));
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the existing row lacks a revision then should return error', async () => {
    const fixture = await createAgentsHttpFixture();
    try {
      fixture.store.upsertPrompt({
        repo: '*',
        agent: 'log_reviewer',
        instructions: 'First.',
      });
      const response = await postJson(`${fixture.baseUrl}/dashboard/api/agents/instructions`, {
        repo: '*',
        agent: 'log_reviewer',
        instructions: 'Second.',
        confirmed: true,
      });
      assert.equal(response.status, 409);
      const body = (await response.json()) as { error: string; revision: string };
      assert.equal(body.error, 'instructions_revision_required');
      assert(body.revision.length > 0);
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the revision is stale then should return error', async () => {
    const fixture = await createAgentsHttpFixture();
    try {
      fixture.store.upsertPrompt({
        repo: '*',
        agent: 'log_reviewer',
        instructions: 'First.',
      });
      const response = await postJson(`${fixture.baseUrl}/dashboard/api/agents/instructions`, {
        repo: '*',
        agent: 'log_reviewer',
        instructions: 'Second.',
        confirmed: true,
        revision: '1',
      });
      assert.equal(response.status, 409);
      const body = (await response.json()) as { error: string };
      assert.equal(body.error, 'instructions_revision_conflict');
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the revision matches then should update successfully', async () => {
    const fixture = await createAgentsHttpFixture();
    try {
      const existing = fixture.store.upsertPrompt({
        repo: '*',
        agent: 'log_reviewer',
        instructions: 'First.',
      });
      const response = await postJson(`${fixture.baseUrl}/dashboard/api/agents/instructions`, {
        repo: '*',
        agent: 'log_reviewer',
        instructions: 'Second.',
        enabled: false,
        confirmed: true,
        revision: String(existing.updatedAt),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        instruction: { instructions: string; enabled: boolean };
      };
      assert.equal(body.instruction.instructions, 'Second.');
      assert.equal(body.instruction.enabled, false);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('POST /dashboard/api/agents/instructions/delete', () => {
  test('When the row is missing then should return error', async () => {
    const fixture = await createAgentsHttpFixture();
    try {
      const response = await postJson(
        `${fixture.baseUrl}/dashboard/api/agents/instructions/delete`,
        {
          repo: '*',
          agent: 'log_reviewer',
          confirmed: true,
        },
      );
      assert.equal(response.status, 404);
      const body = (await response.json()) as { error: string };
      assert.equal(body.error, 'instructions_not_found');
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the revision is stale then should return error', async () => {
    const fixture = await createAgentsHttpFixture();
    try {
      fixture.store.upsertPrompt({
        repo: '*',
        agent: 'log_reviewer',
        instructions: 'First.',
      });
      const response = await postJson(
        `${fixture.baseUrl}/dashboard/api/agents/instructions/delete`,
        {
          repo: '*',
          agent: 'log_reviewer',
          confirmed: true,
          revision: '1',
        },
      );
      assert.equal(response.status, 409);
    } finally {
      await fixture.cleanup();
    }
  });

  test('When the revision matches then should delete successfully', async () => {
    const fixture = await createAgentsHttpFixture();
    try {
      const existing = fixture.store.upsertPrompt({
        repo: '*',
        agent: 'log_reviewer',
        instructions: 'First.',
      });
      const response = await postJson(
        `${fixture.baseUrl}/dashboard/api/agents/instructions/delete`,
        {
          repo: '*',
          agent: 'log_reviewer',
          confirmed: true,
          revision: String(existing.updatedAt),
        },
      );
      assert.equal(response.status, 200);
      assert.equal(fixture.store.listPrompts().length, 0);
      const deletions = readEvents(fixture.store, 'operator.prompt_deleted');
      assert.equal(deletions.length, 1);
    } finally {
      await fixture.cleanup();
    }
  });
});
