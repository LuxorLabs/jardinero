import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { DEMO_LOG_REVIEW_TARGET, configWithLogReview } from '../testing/config.js';
import type { Store } from '../store/store.js';
import type { SandboxRun, WorkflowType } from '../store/types.js';
import { createTestStore } from '../testing/store.js';
import type { Workflow } from '../types.js';
import { type AgentKind, PROMPT_GLOBAL_REPO } from '../workflows/agents.js';
import { InstanceSandboxTaskFactory, type PullRequestStateReader } from './sandbox-task-factory.js';

// Read once, at module scope: the tables below are built when the describe is
// registered, before any hook has run.
const SCAN_TARGET = DEMO_LOG_REVIEW_TARGET;
const REPOSITORY = SCAN_TARGET.repo;
const CONFIG = configWithLogReview();
const PR_MAINTAIN = CONFIG.workflows.prMaintainer;
const LOG_REVIEW = CONFIG.workflows.logReviewer;
const TENKI_SERVICES = SCAN_TARGET.services;

let store: Store;
let cleanup: () => void;
let factory: InstanceSandboxTaskFactory;
let repositoryId: string;
let github: FakePullRequestReader;

beforeEach(() => {
  ({ store, cleanup } = createTestStore());
  repositoryId = store.upsertRepository(REPOSITORY).id;
  github = new FakePullRequestReader();
  factory = new InstanceSandboxTaskFactory(store, CONFIG, github);
});

afterEach(() => {
  cleanup();
});

describe('InstanceSandboxTaskFactory.buildTask', () => {
  const cases: TaskCase[] = [
    {
      name: 'When the agent is `RequestRouter` then should carry only what the person wrote',
      agentName: 'RequestRouter',
      workflowType: 'request_router',
      openInstance: () =>
        store.createRequest({ requestSource: 'discord', requestText: 'look at the checks' }).id,
      want: {
        workflow: 'request_router',
        payload: { request_source: 'discord', request_text: 'look at the checks' },
      },
    },
    {
      name: 'When an operator overrode the router guidance then should carry it without a repo',
      agentName: 'RequestRouter',
      workflowType: 'request_router',
      openInstance: () =>
        store.createRequest({ requestSource: 'discord', requestText: 'look at the checks' }).id,
      overrideGuidance: {
        repo: PROMPT_GLOBAL_REPO,
        agent: 'request_router',
        instructions: 'ask one question at a time',
      },
      want: {
        workflow: 'request_router',
        payload: { request_source: 'discord', request_text: 'look at the checks' },
      },
      wantPromptOverrides: { guidance: 'ask one question at a time' },
    },
    {
      name: 'When the agent is `PrMaintainer` then should carry the pull request and its reply cap',
      agentName: 'PrMaintainer',
      workflowType: 'pr_maintainer',
      openInstance: () => store.openPrMaintainer({ repositoryId, pullRequestNumber: 4688 }).id,
      want: {
        workflow: 'pr_maintain',
        payload: {
          repo: 'acme/widgets',
          pr_number: 4688,
          max_replies_per_thread: PR_MAINTAIN.maxRepliesPerThread,
          attempt: 0,
        },
      },
    },
    {
      name: 'When an operator overrode the guidance then should carry what they wrote',
      agentName: 'PrMaintainer',
      workflowType: 'pr_maintainer',
      openInstance: () => store.openPrMaintainer({ repositoryId, pullRequestNumber: 4688 }).id,
      overrideGuidance: { agent: 'pr_maintainer', instructions: 'answer in one line' },
      want: {
        workflow: 'pr_maintain',
        payload: {
          repo: 'acme/widgets',
          pr_number: 4688,
          max_replies_per_thread: PR_MAINTAIN.maxRepliesPerThread,
          attempt: 0,
        },
      },
      wantPromptOverrides: { guidance: 'answer in one line' },
    },
    {
      // Linear composes it per delivery, so it travels on the instance.
      name: 'When the agent is `LinearImplementer` then should carry the prompt context Linear sent',
      agentName: 'LinearImplementer',
      workflowType: 'linear_implementer',
      openInstance: () =>
        store.openLinearImplementer({
          repositoryId,
          linearIssueId: 'iss-1',
          linearIssueIdentifier: 'JAR-58',
          promptContext: '<issue identifier="JAR-58"><title>Fix it</title></issue>',
        }).id,
      want: {
        workflow: 'linear',
        payload: {
          repo: 'acme/widgets',
          fingerprint: 'linear.JAR-58',
          linear_issue_id: 'iss-1',
          linear_issue_identifier: 'JAR-58',
          draft_pr: true,
          iteration: 0,
          prompt_context: '<issue identifier="JAR-58"><title>Fix it</title></issue>',
        },
      },
    },
    {
      // `role` is what tells the runner to build the verifier prompt.
      name: 'When the agent is `LinearVerifier` then should carry the verify role',
      agentName: 'LinearVerifier',
      workflowType: 'linear_implementer',
      openInstance: () => {
        const instance = store.openLinearImplementer({
          repositoryId,
          linearIssueId: 'iss-1',
          linearIssueIdentifier: 'JAR-58',
        });
        store.setLinearImplementerState(instance.id, 'li_verifying', {
          pullRequestNumber: 4688,
        });
        return instance.id;
      },
      want: {
        workflow: 'linear',
        payload: {
          repo: 'acme/widgets',
          fingerprint: 'linear.JAR-58',
          linear_issue_id: 'iss-1',
          linear_issue_identifier: 'JAR-58',
          draft_pr: true,
          iteration: 0,
          role: 'verify',
          effort: CONFIG.workflows.linearImplementer.verifyEffort,
          pr_number: 4688,
        },
      },
    },
    {
      // The SUP-3003 shape: a rejected pass goes back to implementing, and the task it is
      // given has to name the pull request it already opened.
      name: 'When a `LinearImplementer` pass corrects a rejection then should carry the pull request it opened',
      agentName: 'LinearImplementer',
      workflowType: 'linear_implementer',
      openInstance: () => {
        const instance = store.openLinearImplementer({
          repositoryId,
          linearIssueId: 'iss-1',
          linearIssueIdentifier: 'JAR-58',
        });
        store.setLinearImplementerState(instance.id, 'li_implementing', {
          pullRequestNumber: 4166,
          verifierIssues: 'tests missing',
          iterationNumber: 1,
        });
        return instance.id;
      },
      want: {
        workflow: 'linear',
        payload: {
          repo: 'acme/widgets',
          fingerprint: 'linear.JAR-58',
          linear_issue_id: 'iss-1',
          linear_issue_identifier: 'JAR-58',
          draft_pr: true,
          iteration: 1,
          pr_number: 4166,
          verifier_issues: ['tests missing'],
        },
      },
    },
    {
      // Same shape on the fix side: a re-dispatch after a lost run must not open a second
      // pull request for the finding.
      name: 'When a `FixImplementer` pass follows one that opened a pull request then should carry it',
      agentName: 'FixImplementer',
      workflowType: 'fix_implementer',
      openInstance: () => {
        const instance = store.openFixImplementer({ repositoryId, findingFingerprint: 'fp-1' });
        store.setFixImplementerState(instance.id, 'fi_implementing', {
          pullRequestNumber: 4166,
        });
        return instance.id;
      },
      want: {
        workflow: 'fix_implement',
        payload: {
          repo: 'acme/widgets',
          fingerprint: 'fp-1',
          pr_number: 4166,
        },
      },
    },
    {
      name: 'When the pull request a linear pass would continue is closed then should leave it out',
      agentName: 'LinearImplementer',
      workflowType: 'linear_implementer',
      pullRequest: { state: 'closed' },
      openInstance: () => {
        const instance = store.openLinearImplementer({
          repositoryId,
          linearIssueId: 'iss-1',
          linearIssueIdentifier: 'JAR-58',
        });
        store.setLinearImplementerState(instance.id, 'li_implementing', {
          pullRequestNumber: 4166,
        });
        return instance.id;
      },
      want: {
        workflow: 'linear',
        payload: {
          repo: 'acme/widgets',
          fingerprint: 'linear.JAR-58',
          linear_issue_id: 'iss-1',
          linear_issue_identifier: 'JAR-58',
          draft_pr: true,
          iteration: 0,
        },
      },
      wantDroppedPullRequest: 4166,
    },
    {
      name: 'When the pull request a fix pass would continue is merged then should leave it out',
      agentName: 'FixImplementer',
      workflowType: 'fix_implementer',
      pullRequest: { state: 'merged' },
      openInstance: () => {
        const instance = store.openFixImplementer({ repositoryId, findingFingerprint: 'fp-1' });
        store.setFixImplementerState(instance.id, 'fi_implementing', {
          pullRequestNumber: 4166,
        });
        return instance.id;
      },
      want: {
        workflow: 'fix_implement',
        payload: { repo: 'acme/widgets', fingerprint: 'fp-1' },
      },
      wantDroppedPullRequest: 4166,
    },
    {
      name: 'When the pull request cannot be read then should carry it anyway',
      agentName: 'LinearImplementer',
      workflowType: 'linear_implementer',
      pullRequest: { state: 'open', failure: new Error('GitHub is down') },
      openInstance: () => {
        const instance = store.openLinearImplementer({
          repositoryId,
          linearIssueId: 'iss-1',
          linearIssueIdentifier: 'JAR-58',
        });
        store.setLinearImplementerState(instance.id, 'li_implementing', {
          pullRequestNumber: 4166,
        });
        return instance.id;
      },
      want: {
        workflow: 'linear',
        payload: {
          repo: 'acme/widgets',
          fingerprint: 'linear.JAR-58',
          linear_issue_id: 'iss-1',
          linear_issue_identifier: 'JAR-58',
          draft_pr: true,
          iteration: 0,
          pr_number: 4166,
        },
      },
    },
    {
      // The scan that produced the finding is long gone by the time this runs.
      name: 'When the agent is `FixImplementer` then should carry the evidence of the finding',
      agentName: 'FixImplementer',
      workflowType: 'fix_implementer',
      openInstance: () =>
        store.openFixImplementer({
          repositoryId,
          findingFingerprint: 'fp-1',
          serviceName: 'api',
          environmentName: 'production',
          findingEvidence: 'null payment method',
        }).id,
      want: {
        workflow: 'fix_implement',
        payload: {
          repo: 'acme/widgets',
          fingerprint: 'fp-1',
          service: 'api',
          environment: 'production',
          implementation_handoff: 'null payment method',
        },
      },
    },
    {
      // The window and the dry-run flag come from the configuration, so changing
      // them takes effect on the next scan.
      name: 'When the agent is `LogReviewer` then should carry the target and the window',
      agentName: 'LogReviewer',
      workflowType: 'log_reviewer',
      openInstance: () =>
        store.openLogReviewer({
          repositoryId,
          serviceName: SCAN_TARGET.namespace,
          environmentName: SCAN_TARGET.namespace,
        }).id,
      want: {
        workflow: 'log_review',
        payload: {
          repo: REPOSITORY,
          lookback_min: LOG_REVIEW.lookbackMin,
          dry_run: LOG_REVIEW.dryRun,
          service: SCAN_TARGET.namespace,
          environment: SCAN_TARGET.namespace,
          namespace: SCAN_TARGET.namespace,
          cluster: SCAN_TARGET.clusters[0],
          clusters: SCAN_TARGET.clusters,
          services: TENKI_SERVICES,
        },
      },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      if (c.overrideGuidance) {
        const { repo = REPOSITORY.toLowerCase(), ...guidance } = c.overrideGuidance;
        store.upsertPrompt({ repo, ...guidance });
      }
      if (c.pullRequest) {
        github.state = c.pullRequest.state;
        github.failure = c.pullRequest.failure;
      }
      const sandboxRun = startRunFor(c.agentName, c.workflowType, c.openInstance());

      const task = await factory.buildTask(sandboxRun);

      assert.equal(task.workflow, c.want.workflow);
      assert.deepEqual(task.payload, c.want.payload);
      assert.deepEqual(task.promptOverrides, c.wantPromptOverrides ?? {});
      const dropped = store
        .listEvents({}, { limit: 20 })
        .rows.filter((event) => event.eventType === 'workflow.pull_request_dropped');
      assert.equal(dropped.length, c.wantDroppedPullRequest === undefined ? 0 : 1);
      if (c.wantDroppedPullRequest !== undefined) {
        assert.match(dropped[0]?.metadata ?? '', new RegExp(String(c.wantDroppedPullRequest)));
      }
    });
  }

  const rejectionCases: RejectionCase[] = [
    {
      name: 'When the agent is unknown then should refuse to build a task',
      agentName: 'Nobody',
      workflowType: 'pr_maintainer',
      workflowInstanceId: 'instance-1',
      wantError: /no task can be built for agent: Nobody/,
    },
    {
      name: 'When the instance is gone then should refuse to build a task',
      agentName: 'PrMaintainer',
      workflowType: 'pr_maintainer',
      workflowInstanceId: 'missing',
      wantError: /instance missing of pr_maintainer is gone/,
    },
  ];

  // The guard on a missing repository is not here: the foreign key makes a
  // dangling repository_id impossible, so it cannot be arranged.
  for (const c of rejectionCases) {
    test(c.name, async () => {
      const sandboxRun = startRunFor(c.agentName, c.workflowType, c.workflowInstanceId);

      await assert.rejects(() => factory.buildTask(sandboxRun), c.wantError);
    });
  }
});

function startRunFor(
  agentName: string,
  workflowType: WorkflowType,
  workflowInstanceId: string,
): SandboxRun {
  return store.startSandboxRun({ agentName, workflowType, workflowInstanceId });
}

interface TaskCase {
  name: string;
  agentName: string;
  workflowType: WorkflowType;
  openInstance: () => string;
  overrideGuidance?: { repo?: string; agent: AgentKind; instructions: string };
  pullRequest?: { state: 'open' | 'merged' | 'closed'; failure?: Error };
  want: { workflow: Workflow; payload: Record<string, unknown> };
  wantPromptOverrides?: Record<string, string>;
  wantDroppedPullRequest?: number;
}

interface RejectionCase {
  name: string;
  agentName: string;
  workflowType: WorkflowType;
  workflowInstanceId: string;
  wantError: RegExp;
}

// Typed to the seam the real adapter satisfies, so it cannot answer a state GitHub
// never would.
class FakePullRequestReader implements PullRequestStateReader {
  state: 'open' | 'merged' | 'closed' = 'open';
  failure: Error | undefined;

  readPullRequest(): Promise<{ state: 'open' | 'merged' | 'closed' }> {
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve({ state: this.state });
  }
}
