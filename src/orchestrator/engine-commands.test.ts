import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { type AppConfig, loadConfig } from '../config.js';
import type { Store } from '../store/store.js';
import type { WorkflowType } from '../store/types.js';
import { type StoreFixture, createTestStore } from '../testing/store.js';
import { createEngineCommands } from './engine-commands.js';
import type { EngineCommandDeps, EngineCommands, OperatorCommandable } from './engine-commands.js';
import type { PrMaintainerStateEngineInterface } from './state-machines/pr-maintainer/service.js';

const REPOSITORY = 'acme/web.app';

let fixture: StoreFixture;
let store: Store;
let config: AppConfig;
let calls: string[];
let scans: ScanRequest[];
let scanError: Error | undefined;
let retryError: Error | undefined;
let dismissError: Error | undefined;
let commands: EngineCommands;
let executingSandboxRuns: Set<string>;
let abortedSandboxRuns: string[];

beforeEach(() => {
  fixture = createTestStore();
  store = fixture.store;
  config = loadConfig();
  calls = [];
  scans = [];
  scanError = undefined;
  retryError = undefined;
  dismissError = undefined;
  executingSandboxRuns = new Set();
  abortedSandboxRuns = [];
  commands = createEngineCommands({
    config,
    store,
    engines: recordingEngines(),
    delegateTicket: async () => undefined,
    openTicketForRequest: async () => ({ identifier: 'JAR-58', linearIssueId: 'issue-uuid' }),
    operatedWorkflows: {
      linear_implementer: operated('linearImplementer'),
      fix_implementer: operated('fixImplementer'),
      pr_maintainer: operated('prMaintainer'),
    },
    pool: {
      isExecuting: (sandboxRunId) => executingSandboxRuns.has(sandboxRunId),
      abort: (sandboxRunId) => {
        abortedSandboxRuns.push(sandboxRunId);
      },
    },
  });
});

afterEach(() => {
  fixture.cleanup();
});

describe('createEngineCommands', () => {
  test('When a github delivery is handed over then should answer what the adapter read', async () => {
    store.upsertRepository(REPOSITORY);

    const outcome = await commands.deliverGitHubWebhook({
      eventName: 'pull_request',
      payload: {
        action: 'ready_for_review',
        repository: { full_name: REPOSITORY },
        pull_request: { number: 7 },
      },
    });

    assert.deepEqual(outcome, { handled: true });
    assert.deepEqual(calls, ['onPrReadyForReview']);
  });

  test('When a linear delivery is handed over then should answer what the adapter read', async () => {
    const outcome = await commands.deliverLinearWebhook({
      payload: { type: 'IssueEvent' },
      nowMs: 1,
    });

    assert.deepEqual(outcome, {
      handled: false,
      reason: 'event_not_supported',
      sessionId: undefined,
      issueIdentifier: undefined,
    });
  });
});

describe('EngineCommands.announceLogReview', () => {
  // A target with no repository row has nothing to hang a scan off, and a machine
  // that refuses is not an announcement either.
  const cases: Array<{
    name: string;
    registered: boolean;
    scanFails: boolean;
    askedBy?: 'cron' | 'operator';
    wantAnnounced: string[];
    wantUnknown: string[];
    wantAskSource: string | undefined;
  }> = [
    {
      name: 'When the clock asks for a registered target then should announce it as cron',
      registered: true,
      scanFails: false,
      askedBy: 'cron',
      wantAnnounced: [`${REPOSITORY}:production`],
      wantUnknown: [],
      wantAskSource: 'cron',
    },
    {
      name: 'When nobody says who asked then should record it as an operator',
      registered: true,
      scanFails: false,
      wantAnnounced: [`${REPOSITORY}:production`],
      wantUnknown: [],
      wantAskSource: 'operator',
    },
    {
      name: 'When the repository is not registered then should name it instead',
      registered: false,
      scanFails: false,
      wantAnnounced: [],
      wantUnknown: [REPOSITORY],
      wantAskSource: undefined,
    },
    {
      name: 'When the machine refuses the scan then should announce nothing',
      registered: true,
      scanFails: true,
      wantAnnounced: [],
      wantUnknown: [],
      wantAskSource: 'operator',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      config.workflows.logReviewer.repos = [
        { repo: REPOSITORY, namespace: 'production', clusters: [], services: [] },
      ];
      if (testCase.registered) store.upsertRepository(REPOSITORY);
      if (testCase.scanFails) scanError = new Error('the machine refused it');

      const announcement = await commands.announceLogReview({ askedBy: testCase.askedBy });

      assert.deepEqual(announcement.announced, testCase.wantAnnounced);
      assert.deepEqual(announcement.unknownRepositories, testCase.wantUnknown);
      const [ask] = store.queryReadOnly(
        'SELECT request_source, subject_type, subject_external_id FROM request_router',
      ) as Array<{ request_source: string; subject_type: string; subject_external_id: string }>;
      assert.equal(ask?.request_source, testCase.wantAskSource);
      assert.equal(ask?.subject_type, testCase.wantAskSource && 'log_target');
      assert.equal(ask?.subject_external_id, testCase.wantAskSource && 'production');
    });
  }

  test('When a target repeats across entries then should name it once', async () => {
    config.workflows.logReviewer.repos = [
      { repo: REPOSITORY, namespace: 'production', clusters: [], services: [] },
      { repo: REPOSITORY, namespace: 'staging', clusters: [], services: [] },
    ];

    const announcement = await commands.announceLogReview({ repo: REPOSITORY });

    assert.deepEqual(announcement.unknownRepositories, [REPOSITORY]);
  });

  test('When the scope names a repository then should announce each of its entries', async () => {
    config.workflows.logReviewer.repos = [
      { repo: REPOSITORY, namespace: 'production', clusters: [], services: [] },
      { repo: REPOSITORY, namespace: 'staging', clusters: [], services: [] },
      { repo: 'acme/webapp', namespace: 'production', clusters: [], services: [] },
    ];
    store.upsertRepository(REPOSITORY);
    store.upsertRepository('acme/webapp');

    const announcement = await commands.announceLogReview({ repo: REPOSITORY });

    assert.deepEqual(announcement.announced, [`${REPOSITORY}:production`, `${REPOSITORY}:staging`]);
  });
});

describe('EngineCommands.killSandboxRun', () => {
  const cases: Array<{
    name: string;
    known: boolean;
    executing: boolean;
    wantAccepted: boolean;
    wantReason?: string;
  }> = [
    {
      name: 'When the run is executing then should cut it short',
      known: true,
      executing: true,
      wantAccepted: true,
    },
    {
      name: 'When the run is not executing then should refuse',
      known: true,
      executing: false,
      wantAccepted: false,
      wantReason: 'sandbox_run_not_executing',
    },
    {
      name: 'When the run is unknown then should refuse',
      known: false,
      executing: false,
      wantAccepted: false,
      wantReason: 'unknown_sandbox_run',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      const run = store.startSandboxRun({
        agentName: 'PrMaintainer',
        workflowType: 'pr_maintainer',
        workflowInstanceId: 'instance-1',
      });
      const sandboxRunId = testCase.known ? run.id : 'missing';
      if (testCase.executing) executingSandboxRuns.add(sandboxRunId);

      const outcome = commands.killSandboxRun(sandboxRunId);

      assert.equal(outcome.accepted, testCase.wantAccepted);
      assert.equal(outcome.reason, testCase.wantReason);
      assert.deepEqual(abortedSandboxRuns, testCase.wantAccepted ? [sandboxRunId] : []);
      assert.deepEqual(
        store.listEventsForSandboxRun(run.id).map((event) => event.eventType),
        testCase.wantAccepted ? ['operator.sandbox_run_killed'] : [],
      );
    });
  }
});

describe('EngineCommands.retryWorkflowInstance', () => {
  const cases: Array<{
    name: string;
    open(repositoryId: string): { workflowType: WorkflowType; id: string };
    retryFails?: boolean;
    wantAccepted: boolean;
    wantReason?: string;
    wantCall?: string;
  }> = [
    {
      name: 'When a pull request is retried then should hand it to its machine',
      open: (repositoryId) => ({
        workflowType: 'pr_maintainer',
        id: store.openPrMaintainer({ repositoryId, pullRequestNumber: 7 }).id,
      }),
      wantAccepted: true,
      wantCall: 'prMaintainer.onOperatorRetry',
    },
    {
      name: 'When a ticket is retried then should hand it to its machine',
      open: (repositoryId) => ({
        workflowType: 'linear_implementer',
        id: store.openLinearImplementer({
          repositoryId,
          linearIssueId: 'iss-1',
          linearIssueIdentifier: 'JAR-61',
        }).id,
      }),
      wantAccepted: true,
      wantCall: 'linearImplementer.onOperatorRetry',
    },
    {
      name: 'When a finding is retried then should hand it to its machine',
      open: (repositoryId) => ({
        workflowType: 'fix_implementer',
        id: store.openFixImplementer({ repositoryId, findingFingerprint: 'a finding' }).id,
      }),
      wantAccepted: true,
      wantCall: 'fixImplementer.onOperatorRetry',
    },
    {
      name: 'When a scan is retried then should refuse, because it has no retry',
      open: (repositoryId) => ({
        workflowType: 'log_reviewer',
        id: store.openLogReviewer({ repositoryId }).id,
      }),
      wantAccepted: false,
      wantReason: 'workflow_cannot_be_retried',
    },
    {
      name: 'When the instance is unknown then should refuse',
      open: () => ({ workflowType: 'pr_maintainer', id: 'missing' }),
      wantAccepted: false,
      wantReason: 'unknown_workflow_instance',
    },
    {
      name: 'When the machine refuses then should answer why',
      open: (repositoryId) => ({
        workflowType: 'pr_maintainer',
        id: store.openPrMaintainer({ repositoryId, pullRequestNumber: 7 }).id,
      }),
      retryFails: true,
      wantAccepted: false,
      wantReason: 'the machine refused it',
      wantCall: 'prMaintainer.onOperatorRetry',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const repositoryId = store.upsertRepository(REPOSITORY).id;
      const instance = testCase.open(repositoryId);
      if (testCase.retryFails === true) retryError = new Error('the machine refused it');

      const outcome = await commands.retryWorkflowInstance(instance.workflowType, instance.id);

      assert.equal(outcome.accepted, testCase.wantAccepted);
      assert.equal(outcome.reason, testCase.wantReason);
      assert.deepEqual(calls, testCase.wantCall === undefined ? [] : [testCase.wantCall]);
      assert.deepEqual(
        store
          .listEventsForInstance(instance.workflowType, instance.id)
          .map((event) => event.eventType),
        testCase.wantCall === undefined ? [] : ['operator.workflow_instance_retried'],
      );
    });
  }
});

describe('EngineCommands.dismissWorkflowInstance', () => {
  const cases: Array<{
    name: string;
    workflowType: WorkflowType;
    unknownInstance?: boolean;
    dismissFails?: boolean;
    wantAccepted: boolean;
    wantReason?: string;
    wantCall?: string;
  }> = [
    {
      name: 'When a parked ticket is dismissed then should hand it to its machine',
      workflowType: 'linear_implementer',
      wantAccepted: true,
      wantCall: 'linearImplementer.onOperatorDismiss',
    },
    {
      name: 'When the machine takes no orders then should refuse it',
      workflowType: 'log_reviewer',
      wantAccepted: false,
      wantReason: 'workflow_cannot_be_dismissed',
    },
    {
      name: 'When the instance is unknown then should refuse it',
      workflowType: 'linear_implementer',
      unknownInstance: true,
      wantAccepted: false,
      wantReason: 'unknown_workflow_instance',
    },
    {
      name: 'When the machine refuses then should leave the audit log alone',
      workflowType: 'linear_implementer',
      dismissFails: true,
      wantAccepted: false,
      wantReason: 'the machine refused it',
      wantCall: 'linearImplementer.onOperatorDismiss',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, async () => {
      const repositoryId = store.upsertRepository(REPOSITORY).id;
      const ticket = store.openLinearImplementer({
        repositoryId,
        linearIssueId: 'iss-1',
        linearIssueIdentifier: 'JAR-61',
      });
      const scan = store.openLogReviewer({ repositoryId, serviceName: 'jardinero' });
      const id = testCase.workflowType === 'log_reviewer' ? scan.id : ticket.id;
      if (testCase.dismissFails === true) dismissError = new Error('the machine refused it');

      const outcome = await commands.dismissWorkflowInstance(
        testCase.workflowType,
        testCase.unknownInstance ? 'gone' : id,
      );

      assert.equal(outcome.accepted, testCase.wantAccepted);
      assert.equal(outcome.reason, testCase.wantReason);
      assert.deepEqual(calls, testCase.wantCall === undefined ? [] : [testCase.wantCall]);
      assert.deepEqual(
        store
          .listEventsForInstance(testCase.workflowType, id)
          .map((event) => event.eventType)
          .filter((eventType) => eventType === 'operator.workflow_instance_dismissed'),
        testCase.wantAccepted ? ['operator.workflow_instance_dismissed'] : [],
      );
    });
  }
});

// operated stands in for a machine an operator can order around, recording which order
// reached which machine.
function operated(machine: string): OperatorCommandable {
  return {
    onOperatorRetry: () => {
      calls.push(`${machine}.onOperatorRetry`);
      return Promise.resolve(retryError);
    },
    onOperatorDismiss: () => {
      calls.push(`${machine}.onOperatorDismiss`);
      return Promise.resolve(dismissError);
    },
  };
}

interface ScanRequest {
  repositoryId: string;
  serviceName?: string;
  environmentName?: string;
}

// The doubles are typed to the same seams the commands ask for, so neither can answer
// something the real machines never would.
function recordingEngines(): EngineCommandDeps['engines'] {
  return {
    prMaintainer: recordingPrMaintainer(),
    linearImplementer: {
      onIssueAssigned: () => {
        calls.push('onIssueAssigned');
        return Promise.resolve(undefined);
      },
    },
    logReviewer: {
      onScheduledScan: (target) => {
        scans.push(target);
        return Promise.resolve(scanError);
      },
    },
  };
}

function recordingPrMaintainer(): PrMaintainerStateEngineInterface {
  const record = (name: string) => (): Promise<undefined> => {
    calls.push(name);
    return Promise.resolve(undefined);
  };
  return {
    onPrReadyForReview: record('onPrReadyForReview'),
    onPrToFollow: record('onPrToFollow'),
    onPrDiscovered: record('onPrDiscovered'),
    onPrReopened: record('onPrReopened'),
    onPrComment: record('onPrComment'),
    onPrCICompleted: record('onPrCICompleted'),
    onPrSynchronize: record('onPrSynchronize'),
    onPrMerged: record('onPrMerged'),
    onPrClosed: record('onPrClosed'),
    onSandboxRunSucceeded: record('onSandboxRunSucceeded'),
    onSandboxRunFailed: record('onSandboxRunFailed'),
    onOperatorRetry: operated('prMaintainer').onOperatorRetry,
    onOperatorDismiss: operated('prMaintainer').onOperatorDismiss,
    onPeriodicCheck: record('onPeriodicCheck'),
    onSystemRecovery: record('onSystemRecovery'),
  };
}
