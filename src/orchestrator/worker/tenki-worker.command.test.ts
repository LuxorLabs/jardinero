import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadConfig } from '../../config.js';
import { TenkiWorkerRunner } from './tenki-worker.js';
import type { SandboxRun } from '../../store/types.js';
import type { SandboxRunContext } from '../sandbox-pool.js';
import type { Workflow } from '../../types.js';

describe('codexCommand', () => {
  // The seat's model and effort must reach the CLI as `-m <model>` and
  // `-c model_reasoning_effort=<effort>`.
  const cases: Array<{
    name: string;
    workflow: Workflow;
    payload: Record<string, unknown>;
    wantModel: string;
    wantEffort: string;
  }> = [
    {
      name: 'When repo generation is 5 6 and seat is implementation then should use sol',
      workflow: 'pr_maintain',
      payload: { repo: 'acme/ledger' },
      wantModel: 'gpt-5.6-sol',
      wantEffort: 'xhigh',
    },
    {
      name: 'When repo generation is 5 6 and seat is triage then should use terra',
      workflow: 'log_review',
      payload: { repo: 'acme/ledger' },
      wantModel: 'gpt-5.6-terra',
      wantEffort: 'medium',
    },
    {
      // Linear's implement role normalizes onto the implementation seat.
      name: 'When the linear role is implement then should use the implementation seat',
      workflow: 'linear',
      payload: { repo: 'acme/ledger', role: 'implement' },
      wantModel: 'gpt-5.6-sol',
      wantEffort: 'xhigh',
    },
    {
      // The verify seat has no generation entry, so it inherits the implementation tier
      // while keeping its own pinned effort.
      name: 'When the linear role is verify then should inherit the implementation tier',
      workflow: 'linear',
      payload: { repo: 'acme/ledger', role: 'verify', effort: 'high' },
      wantModel: 'gpt-5.6-sol',
      wantEffort: 'high',
    },
    {
      // The payload asks for max, but the repo caps effort at xhigh.
      name: 'When seat effort exceeds the repo cap then should clamp to xhigh',
      workflow: 'fix_implement',
      payload: { repo: 'acme/ledger', effort: 'max' },
      wantModel: 'gpt-5.6-sol',
      wantEffort: 'xhigh',
    },
    {
      name: 'When repo is unmapped then should use the default generation',
      workflow: 'pr_maintain',
      payload: { repo: 'acme/unmapped-repo' },
      wantModel: 'gpt-5.6-sol',
      wantEffort: 'xhigh',
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const runner = new TenkiWorkerRunner(loadConfig(), {});
      const command = (runner as unknown as CommandProbe).codexCommand(
        makeContext(c.workflow, c.payload),
      );

      assert.ok(command.includes(`-m '${c.wantModel}'`), command);
      assert.ok(command.includes(`'model_reasoning_effort=${c.wantEffort}'`), command);
    });
  }
});

// codexCommand is private; it composes the `codex exec` invocation, so we probe it
// directly rather than driving a full sandboxed run.
type CommandProbe = { codexCommand(context: SandboxRunContext): string };

function makeContext(workflow: Workflow, payload: Record<string, unknown>): SandboxRunContext {
  const sandboxRun: SandboxRun = {
    id: 'run-command-test',
    agentName: 'Agent',
    runState: 'running',
    workflowType: 'pr_maintainer',
    workflowInstanceId: 'instance-1',
    sandboxSessionId: null,
    costUsd: null,
    errorMessage: null,
    startedAt: 0,
    endedAt: null,
  };
  return {
    sandboxRun,
    task: { workflow, payload, promptOverrides: {} },
    maxWallClockMs: 60_000,
    signal: new AbortController().signal,
    publishEvent: async () => {},
    writeSandboxRunArtifact: async () => 'artifact',
  };
}
