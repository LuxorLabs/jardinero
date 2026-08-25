import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { type AppConfig, loadConfig } from '../config.js';
import type { Store } from '../store/store.js';
import type { WorkflowType } from '../store/types.js';
import { createTestStore } from '../testing/store.js';
import type { ImplementationHandoff, WorkerResult } from '../types.js';
import type { Finding } from './state-machines/fix-implementer/events.js';
import { ROUTING_JSON_MARKER } from '../workflows/router/routing.js';
import {
  InstanceSandboxRunOutcomeReporter,
  type OutcomeReportingEngines,
} from './sandbox-run-outcome-reporter.js';

const CONFIG = loadConfig();

let store: Store;
let cleanup: () => void;
let engines: RecordingEngines;
let reporter: InstanceSandboxRunOutcomeReporter;

beforeEach(() => {
  ({ store, cleanup } = createTestStore());
  engines = createEngines();
  reporter = new InstanceSandboxRunOutcomeReporter(store, CONFIG, () => engines);
});

afterEach(() => {
  cleanup();
});

describe('InstanceSandboxRunOutcomeReporter.reportSucceeded', () => {
  const cases: SucceededCase[] = [
    {
      name: 'When a routing run succeeded then should hand the machine what the agent placed',
      workflowType: 'request_router',
      result: succeeded(
        `${ROUTING_JSON_MARKER} {"subject_type":"pull_request","subject_external_id":"4688"}`,
      ),
      engineOf: (all) => all.requestRouter,
      want: { subjectType: 'pull_request', subjectExternalId: '4688' },
    },
    {
      // The router names a repository and the machine stores ids, so the name is
      // resolved before the machine sees it.
      name: 'When the routing names a repository then should hand over its id',
      workflowType: 'request_router',
      arrange: () => ({ repositoryId: store.upsertRepository('acme/web.app').id }),
      result: succeeded(
        `${ROUTING_JSON_MARKER} {"subject_type":"log_target","subject_external_id":"api","repository_full_name":"acme/web.app","requested_action":"scan"}`,
      ),
      engineOf: (all) => all.requestRouter,
      want: { subjectType: 'log_target', subjectExternalId: 'api' },
    },
    {
      name: 'When the routing answer cannot be read then should hand over why',
      workflowType: 'request_router',
      result: succeeded('all done'),
      engineOf: (all) => all.requestRouter,
      want: { resolutionNote: 'no_routing_answer' },
    },
    {
      name: 'When an implementer run opened a pull request then should hand over its number',
      workflowType: 'linear_implementer',
      result: {
        ...succeeded('done'),
        openedPrUrl: 'https://github.com/acme/web.app/pull/4688',
      },
      engineOf: (all) => all.linearImplementer,
      want: { pullRequestNumber: 4688, hasVerdict: false },
    },
    {
      name: 'When a verifier run produced a verdict then should hand it over with its issues',
      workflowType: 'linear_implementer',
      result: {
        ...succeeded('done'),
        linearVerification: {
          verdict: 'reject',
          criteria: [],
          issues: ['tests missing', 'no changelog'],
          followedProcedures: true,
          raw: {},
        },
      },
      engineOf: (all) => all.linearImplementer,
      want: { verdict: 'reject', hasVerdict: true, verifierIssues: 'tests missing\nno changelog' },
    },
    {
      // A run that produced no readable verdict is broken, not negative.
      name: 'When a verifier run produced no verdict then should say so',
      workflowType: 'linear_implementer',
      result: succeeded('done'),
      engineOf: (all) => all.linearImplementer,
      want: { hasVerdict: false },
    },
    {
      name: 'When a fix run refused the finding then should hand over the reason',
      workflowType: 'fix_implementer',
      result: {
        ...succeeded('done'),
        noPrOutcome: { outcome: 'no_pr', reason: 'false_positive', evidence: [], raw: {} },
      },
      engineOf: (all) => all.fixImplementer,
      want: { discardReason: 'false_positive' },
    },
    {
      name: 'When a maintenance run succeeded then should hand over nothing but the run',
      workflowType: 'pr_maintainer',
      result: succeeded('done'),
      engineOf: (all) => all.prMaintainer,
      want: undefined,
    },
    {
      name: 'When a scan succeeded then should hand over how many findings it produced',
      workflowType: 'log_reviewer',
      result: {
        ...succeeded('done'),
        implementationHandoffs: [handoff(), handoff()],
      },
      engineOf: (all) => all.logReviewer,
      want: { findingCount: 2 },
    },
    {
      name: 'When a scan produced no findings then should hand over none',
      workflowType: 'log_reviewer',
      result: succeeded('done'),
      engineOf: (all) => all.logReviewer,
      want: { findingCount: 0 },
    },
    {
      name: 'When a scan hands over findings then should open a fix for each one',
      workflowType: 'log_reviewer',
      arrange: () => registerRepository(),
      result: {
        ...succeeded('done'),
        implementationHandoffs: [
          handoff({ fingerprint: 'fp-1' }),
          handoff({ fingerprint: 'fp-2' }),
        ],
      },
      engineOf: (all) => all.logReviewer,
      want: { findingCount: 2 },
      wantOpenedFixes: ['fp-1', 'fp-2'],
    },
    {
      name: 'When a finding is not ready for implementation then should open no fix for it',
      workflowType: 'log_reviewer',
      arrange: () => registerRepository(),
      result: {
        ...succeeded('done'),
        implementationHandoffs: [handoff({ readyForImplementation: false })],
      },
      engineOf: (all) => all.logReviewer,
      want: { findingCount: 1 },
      wantOpenedFixes: [],
    },
    {
      name: 'When a finding is below the investigation threshold then should open no fix for it',
      workflowType: 'log_reviewer',
      arrange: () => registerRepository(),
      result: { ...succeeded('done'), implementationHandoffs: [handoff({ confidence: 0.1 })] },
      engineOf: (all) => all.logReviewer,
      want: { findingCount: 1 },
      wantOpenedFixes: [],
    },
    {
      name: 'When the scan only previewed its findings then should open no fix',
      workflowType: 'log_reviewer',
      arrange: () => registerRepository(),
      result: {
        ...succeeded('done'),
        implementationHandoffs: [handoff({ dispatchBlockedByDryRun: true })],
      },
      engineOf: (all) => all.logReviewer,
      want: { findingCount: 1 },
      wantOpenedFixes: [],
    },
    {
      name: 'When the workflow runs dry then should open no fix',
      workflowType: 'log_reviewer',
      arrange: () => registerRepository(),
      configure: (config) => {
        config.workflows.logReviewer.dryRun = true;
      },
      result: { ...succeeded('done'), implementationHandoffs: [handoff()] },
      engineOf: (all) => all.logReviewer,
      want: { findingCount: 1 },
      wantOpenedFixes: [],
    },
    {
      name: 'When a finding names a repository we do not know then should open no fix for it',
      workflowType: 'log_reviewer',
      result: {
        ...succeeded('done'),
        implementationHandoffs: [handoff({ repo: 'acme/nowhere' })],
      },
      engineOf: (all) => all.logReviewer,
      want: { findingCount: 1 },
      wantOpenedFixes: [],
    },
    {
      name: 'When more findings arrive than the cap then should stop at the cap',
      workflowType: 'log_reviewer',
      arrange: () => registerRepository(),
      configure: (config) => {
        config.workflows.fixImplementer.maxHandoffsPerRun = 1;
      },
      result: {
        ...succeeded('done'),
        implementationHandoffs: [
          handoff({ fingerprint: 'fp-1' }),
          handoff({ fingerprint: 'fp-2' }),
        ],
      },
      engineOf: (all) => all.logReviewer,
      want: { findingCount: 2 },
      wantOpenedFixes: ['fp-1'],
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const arranged = c.arrange?.() ?? {};
      const sandboxRunId = startSandboxRun(c.workflowType);

      await reporterWith(c.configure).reportSucceeded(sandboxRunId, c.result);

      const engine = c.engineOf(engines);
      const want = c.want && { ...c.want, ...arranged };
      assert.deepEqual(engine.succeeded, [{ sandboxRunId, outcome: want }]);
      assert.deepEqual(engine.failed, []);
      assert.deepEqual(
        engines.fixImplementer.findings.map((reported) => reported.finding.findingFingerprint),
        c.wantOpenedFixes ?? [],
      );
      for (const reported of engines.fixImplementer.findings) {
        assert.equal(reported.logReviewerId, store.getSandboxRun(sandboxRunId)?.workflowInstanceId);
      }
    });
  }

  test('When the run is unknown then should hand nothing to anyone', async () => {
    await reporter.reportSucceeded('missing', succeeded('done'));

    assert.deepEqual(everyReport(engines), []);
  });

  // The machines answer with their failure instead of throwing, and the periodic
  // check reaches the instance again, so the report is dropped.
  test('When the machine refuses the outcome then should not throw', async () => {
    const sandboxRunId = startSandboxRun('pr_maintainer');
    engines.prMaintainer.answers = new Error('refused');

    await assert.doesNotReject(() => reporter.reportSucceeded(sandboxRunId, succeeded('done')));
  });
});

describe('InstanceSandboxRunOutcomeReporter.reportFailed', () => {
  const cases: FailedCase[] = [
    {
      name: 'request router',
      workflowType: 'request_router',
      engineOf: (all) => all.requestRouter,
    },
    {
      name: 'linear implementer',
      workflowType: 'linear_implementer',
      engineOf: (all) => all.linearImplementer,
    },
    {
      name: 'fix implementer',
      workflowType: 'fix_implementer',
      engineOf: (all) => all.fixImplementer,
    },
    { name: 'pr maintainer', workflowType: 'pr_maintainer', engineOf: (all) => all.prMaintainer },
    { name: 'log reviewer', workflowType: 'log_reviewer', engineOf: (all) => all.logReviewer },
  ];

  for (const c of cases) {
    test(`When a ${c.name} run failed then should tell its machine`, async () => {
      const sandboxRunId = startSandboxRun(c.workflowType);

      await reporter.reportFailed(sandboxRunId);

      assert.deepEqual(c.engineOf(engines).failed, [sandboxRunId]);
      assert.deepEqual(c.engineOf(engines).succeeded, []);
    });
  }

  test('When the run is unknown then should hand nothing to anyone', async () => {
    await reporter.reportFailed('missing');

    assert.deepEqual(everyReport(engines), []);
  });
});

function startSandboxRun(workflowType: WorkflowType): string {
  return store.startSandboxRun({
    agentName: 'Agent',
    workflowType,
    workflowInstanceId: 'instance-1',
  }).id;
}

function succeeded(summary: string): WorkerResult {
  return { status: 'succeeded', costUsd: null, summary };
}

// reporterWith answers a reporter reading a config a case bent, so the caps and the dry
// run are exercised through the same act as the rest of the table.
function reporterWith(configure?: (config: AppConfig) => void): InstanceSandboxRunOutcomeReporter {
  if (!configure) return reporter;
  const config = loadConfig();
  configure(config);
  return new InstanceSandboxRunOutcomeReporter(store, config, () => engines);
}

function registerRepository(): Record<string, unknown> {
  store.upsertRepository('acme/web.app');
  return {};
}

function handoff(fields: Partial<ImplementationHandoff> = {}): ImplementationHandoff {
  return {
    repo: 'acme/web.app',
    service: 'api',
    environment: 'production',
    fingerprint: 'fp-1',
    severity: 'high',
    confidence: 0.9,
    userImpact: 'checkout fails',
    evidence: [],
    representativeLogs: [],
    evidenceLinks: [],
    suspectedRootCause: 'null payment method',
    likelyFilesOrSymbols: [],
    reproductionSteps: [],
    acceptanceCriteria: [],
    suggestedTests: [],
    sourceLogReviewRunId: 'run-1',
    readyForImplementation: true,
    dispatchBlockedByDryRun: false,
    raw: {},
    ...fields,
  };
}

// Records what the reporter handed over, and lets a test make a machine refuse.
class RecordingEngine {
  readonly findings: Array<{ finding: Finding; logReviewerId?: string }> = [];
  readonly succeeded: Array<{ sandboxRunId: string; outcome: unknown }> = [];
  readonly failed: string[] = [];
  answers: Error | undefined;

  onSandboxRunSucceeded(sandboxRunId: string, outcome?: unknown): Promise<Error | undefined> {
    this.succeeded.push({ sandboxRunId, outcome });
    return Promise.resolve(this.answers);
  }

  onSandboxRunFailed(sandboxRunId: string): Promise<Error | undefined> {
    this.failed.push(sandboxRunId);
    return Promise.resolve(this.answers);
  }

  onFindingReported(finding: Finding, logReviewerId?: string): Promise<Error | undefined> {
    this.findings.push({ finding, logReviewerId });
    return Promise.resolve(this.answers);
  }
}

interface RecordingEngines extends OutcomeReportingEngines {
  requestRouter: RecordingEngine;
  linearImplementer: RecordingEngine;
  fixImplementer: RecordingEngine;
  prMaintainer: RecordingEngine;
  logReviewer: RecordingEngine;
}

function createEngines(): RecordingEngines {
  return {
    requestRouter: new RecordingEngine(),
    linearImplementer: new RecordingEngine(),
    fixImplementer: new RecordingEngine(),
    prMaintainer: new RecordingEngine(),
    logReviewer: new RecordingEngine(),
  } as RecordingEngines;
}

function everyReport(all: RecordingEngines): unknown[] {
  return [
    ...all.requestRouter.succeeded,
    ...all.requestRouter.failed,
    ...all.linearImplementer.succeeded,
    ...all.linearImplementer.failed,
    ...all.fixImplementer.succeeded,
    ...all.fixImplementer.failed,
    ...all.prMaintainer.succeeded,
    ...all.prMaintainer.failed,
    ...all.logReviewer.succeeded,
    ...all.logReviewer.failed,
  ];
}

interface SucceededCase {
  name: string;
  workflowType: WorkflowType;
  arrange?: () => Record<string, unknown>;
  configure?: (config: AppConfig) => void;
  result: WorkerResult;
  engineOf: (all: RecordingEngines) => RecordingEngine;
  want: Record<string, unknown> | undefined;
  wantOpenedFixes?: string[];
}

interface FailedCase {
  name: string;
  workflowType: WorkflowType;
  engineOf: (all: RecordingEngines) => RecordingEngine;
}
