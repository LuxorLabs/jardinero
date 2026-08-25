// Standalone dashboard UI preview. Boots ONLY the HTTP server (no scheduler, no
// dispatcher pump) against a throwaway data dir seeded with
// representative content so every dashboard tab can be inspected for UI/UX
// issues. Not part of the product; used for design review only.
//
//   tsx scripts/ui-preview.ts
//
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  delegateLinearIssue,
  openLinearIssueForRequest,
} from '../src/adapters/linear/linear-delegation.js';
import { loadConfig } from '../src/config.js';
import { createEngineCommands } from '../src/orchestrator/engine-commands.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { createApiServer } from '../src/transport/server.js';
import { Store } from '../src/store/store.js';
import { MockWorkerRunner } from '../src/orchestrator/worker/mock-worker.js';
import type {
  FixImplementerState,
  LinearImplementerState,
  LogReviewerState,
  PrMaintainerState,
  RequestRouterState,
  RequestSource,
  SubjectType,
  VerifierVerdict,
  WorkflowType,
} from '../src/store/types.js';

const PORT = Number(process.env.PREVIEW_PORT ?? 4178);

// PREVIEW_DATA_DIR serves an existing data directory instead of seeding a throwaway
// one, which is how the pages are read against a real database.
const existingDataDir = process.env.PREVIEW_DATA_DIR;
const dataPath = existingDataDir ?? mkdtempSync(path.join(tmpdir(), 'jardinero-ui-preview-'));
const config = loadConfig();
config.store.dataPath = dataPath;
config.worker.runner = 'mock';

const store = new Store(config.store);
const runner = new MockWorkerRunner();
// Nothing is meant to run here: the preview serves seeded rows, so the machines
// only exist because every API surface is built from the same context.
const orchestrator = new Orchestrator({ config, store, runner, github: unreadableGitHub() });

const MINUTE = 60 * 1000;
const _HOUR = 60 * MINUTE;

const PR_MAINTAINERS: PrMaintainerSeed[] = [
  {
    repositoryId: 'platform',
    pullRequestNumber: 4688,
    state: 'prm_working',
    attemptCount: 1,
    run: { runState: 'running' },
  },
  {
    repositoryId: 'platform',
    pullRequestNumber: 4798,
    state: 'prm_waiting',
    attemptCount: 1,
    run: {
      runState: 'succeeded',
      costUsd: 0.91,
      summary: 'Replied to 2 review threads and pushed a fixup commit.',
    },
  },
  {
    repositoryId: 'webapp',
    pullRequestNumber: 1133,
    state: 'prm_attempts_exhausted',
    attemptCount: 3,
    needsHumanReason: 'attempts_exhausted',
    run: { runState: 'failed', costUsd: 1.07, errorMessage: 'The push was rejected three times.' },
  },
  {
    repositoryId: 'platform',
    pullRequestNumber: 4612,
    state: 'prm_merged',
    attemptCount: 2,
    run: {
      runState: 'succeeded',
      costUsd: 1.8,
      summary: 'Answered the last thread; the pull request merged.',
    },
  },
  {
    repositoryId: 'webapp',
    pullRequestNumber: 1097,
    state: 'prm_closed',
    attemptCount: 1,
    run: { runState: 'aborted', costUsd: 0.2 },
  },
];

const LINEAR_IMPLEMENTERS: LinearImplementerSeed[] = [
  {
    repositoryId: 'platform',
    identifier: 'JAR-58',
    state: 'li_implementing',
    promptContext: 'Rework the workflows so each ticket has a visible state.',
    run: { runState: 'running' },
  },
  {
    repositoryId: 'webapp',
    identifier: 'ENG-2941',
    state: 'li_verifying',
    agentName: 'LinearVerifier',
    pullRequestNumber: 1146,
    iterationNumber: 1,
    run: { runState: 'running' },
  },
  {
    repositoryId: 'webapp',
    identifier: 'ENG-2902',
    state: 'li_waiting_pr',
    pullRequestNumber: 1142,
    verifierVerdict: 'accept',
    run: { runState: 'succeeded', costUsd: 2.4, summary: 'Every acceptance criterion is covered.' },
  },
  {
    repositoryId: 'platform',
    identifier: 'JAR-41',
    state: 'li_needs_human',
    pullRequestNumber: 4620,
    iterationNumber: 3,
    verifierVerdict: 'reject',
    verifierIssues: 'The migration is missing a down step.',
    needsHumanReason: 'iterations_exhausted',
    run: { runState: 'succeeded', costUsd: 5.6 },
  },
  {
    repositoryId: 'webapp',
    identifier: 'ENG-2871',
    state: 'li_done',
    pullRequestNumber: 1097,
    verifierVerdict: 'accept',
    run: { runState: 'succeeded', costUsd: 1.9, summary: 'Merged.' },
  },
];

const LOG_REVIEWERS: LogReviewerSeed[] = [
  {
    repositoryId: 'platform',
    serviceName: 'engine',
    environmentName: 'prod-eu',
    state: 'lr_working',
    run: { runState: 'running' },
  },
  {
    repositoryId: 'webapp',
    serviceName: 'app',
    environmentName: 'prod-us',
    state: 'lr_done',
    findingCount: 2,
    run: { runState: 'succeeded', costUsd: 0.42, summary: 'Two findings, both handed to a fix.' },
  },
  {
    repositoryId: 'platform',
    serviceName: 'temporal',
    environmentName: 'prod-us',
    state: 'lr_failed',
    run: {
      runState: 'failed',
      costUsd: 0.33,
      errorMessage: 'Grafana answered 502 for every query.',
    },
  },
];

const FIX_IMPLEMENTERS: FixImplementerSeed[] = [
  {
    repositoryId: 'webapp',
    fingerprint: 'app:checkout:5xx',
    serviceName: 'app',
    evidence: 'POST /checkout answered 502 for 4% of requests.',
    state: 'fi_implementing',
    run: { runState: 'running' },
  },
  {
    repositoryId: 'webapp',
    fingerprint: 'app:login:timeout',
    serviceName: 'app',
    evidence: 'Login p99 crossed 8s for 20 minutes.',
    state: 'fi_waiting_pr',
    pullRequestNumber: 1145,
    run: { runState: 'succeeded', costUsd: 3.18, summary: 'Opened a pull request with the retry.' },
  },
  {
    repositoryId: 'platform',
    fingerprint: 'engine:quota:429',
    serviceName: 'engine',
    evidence: '429 from the provider, not ours.',
    state: 'fi_discarded',
    discardReason: 'not_our_bug',
    run: {
      runState: 'succeeded',
      costUsd: 0.7,
      summary: 'The error comes from the provider quota.',
    },
  },
];

// LONG_ASK is the shape of ask a person writes in a ticket, past what a table cell can
// hold on two lines.
const LONG_ASK = [
  'Implement the retry budget for the pull request maintainer.',
  'Today a run that fails on a push retries forever and burns the cost budget on the same pull request,',
  'so cap the attempts per pull request, record the attempt count on the instance,',
  'stop when the cap is reached and leave the instance waiting for a person with the reason,',
  'and make the dashboard show how many attempts are left before the machine gives up.',
].join(' ');

const REQUESTS: RequestSeed[] = [
  {
    source: 'discord',
    text: 'follow PR 4688 until it merges',
    requester: 'luciocorral',
    repositoryId: 'platform',
    subjectType: 'pull_request',
    subjectExternalId: '4688',
    state: 'rr_resolved',
    answeredBy: 'pr_maintainer',
  },
  {
    source: 'github',
    text: '@jardinero-agent this needs another pass',
    requester: 'guzmanbrand',
    repositoryId: 'platform',
    subjectType: 'pull_request',
    subjectExternalId: '4688',
    state: 'rr_resolved',
    resolutionNote: 'reply_cap_reached',
  },
  {
    source: 'linear',
    text: LONG_ASK,
    requester: 'tomas',
    repositoryId: 'webapp',
    subjectType: 'linear_issue',
    subjectExternalId: 'JAR-61',
    state: 'rr_resolved',
    answeredBy: 'linear_implementer',
  },
  {
    source: 'discord',
    text: 'implement the retry budget',
    repositoryId: 'webapp',
    state: 'rr_routing',
    run: { runState: 'running' },
  },
  {
    source: 'discord',
    text: 'fix that',
    repositoryId: 'webapp',
    state: 'rr_unresolvable',
    resolutionNote: 'Which pull request or ticket is "that"?',
    run: { runState: 'succeeded', costUsd: 0.05 },
  },
  {
    source: 'cron',
    text: 'scheduled log scan',
    repositoryId: 'platform',
    subjectType: 'log_target',
    subjectExternalId: 'engine',
    state: 'rr_resolved',
  },
];

interface ArrivalSeed {
  workflowType: WorkflowType;
  fromState: string;
  toState: string;
  count: number;
}

const ARRIVALS: ArrivalSeed[] = [
  { workflowType: 'log_reviewer', fromState: 'lr_working', toState: 'lr_done', count: 34 },
  {
    workflowType: 'linear_implementer',
    fromState: 'li_verifying',
    toState: 'li_waiting_pr',
    count: 12,
  },
  { workflowType: 'pr_maintainer', fromState: 'prm_waiting', toState: 'prm_merged', count: 9 },
  { workflowType: 'fix_implementer', fromState: 'fi_waiting_pr', toState: 'fi_done', count: 6 },
];

if (existingDataDir === undefined) seedInstances();

const commands = createEngineCommands({
  config,
  store,
  engines: orchestrator,
  delegateTicket: (ticket, ownerLinearUserId) =>
    delegateLinearIssue({ config, env: process.env }, ticket, ownerLinearUserId),
  openTicketForRequest: (request) =>
    openLinearIssueForRequest({ config, env: process.env }, request),
  operatedWorkflows: orchestrator.operatedWorkflows,
  pool: orchestrator.pool,
  env: process.env,
});
const server = createApiServer({
  config,
  store,
  commands,
  env: process.env,
});

server.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`\nUI preview ready:  http://127.0.0.1:${PORT}/dashboard`);
});

// ---------------------------------------------------------------------------

// seedInstances writes one instance per interesting state of every machine, each
// with the sandbox runs it would have produced, so every page has something to
// render without anything actually running.
function seedInstances(): void {
  const platform = store.upsertRepository('acme/web.app').id;
  const webapp = store.upsertRepository('acme/webapp').id;

  for (const seed of PR_MAINTAINERS) {
    const instance = store.openPrMaintainer({
      repositoryId: seed.repositoryId === 'platform' ? platform : webapp,
      pullRequestNumber: seed.pullRequestNumber,
    });
    instance.attemptCount = seed.attemptCount ?? 0;
    instance.needsHumanReason = seed.needsHumanReason ?? null;
    if (seed.run)
      instance.sandboxRunId = seedRun(instance.id, 'pr_maintainer', 'PrMaintainer', seed.run);
    store.setPrMaintainerState(instance.id, seed.state, {
      attemptCount: instance.attemptCount,
      needsHumanReason: instance.needsHumanReason,
      sandboxRunId: instance.sandboxRunId,
    });
  }

  for (const seed of LINEAR_IMPLEMENTERS) {
    const instance = store.openLinearImplementer({
      repositoryId: seed.repositoryId === 'platform' ? platform : webapp,
      linearIssueId: `issue-${seed.identifier}`,
      linearIssueIdentifier: seed.identifier,
      promptContext: seed.promptContext,
    });
    const sandboxRunId = seed.run
      ? seedRun(instance.id, 'linear_implementer', seed.agentName ?? 'LinearImplementer', seed.run)
      : null;
    store.setLinearImplementerState(instance.id, seed.state, {
      pullRequestNumber: seed.pullRequestNumber,
      iterationNumber: seed.iterationNumber,
      verifierVerdict: seed.verifierVerdict,
      verifierIssues: seed.verifierIssues,
      needsHumanReason: seed.needsHumanReason,
      sandboxRunId,
    });
  }

  for (const seed of LOG_REVIEWERS) {
    const instance = store.openLogReviewer({
      repositoryId: seed.repositoryId === 'platform' ? platform : webapp,
      serviceName: seed.serviceName,
      environmentName: seed.environmentName,
    });
    const sandboxRunId = seed.run
      ? seedRun(instance.id, 'log_reviewer', 'LogReviewer', seed.run)
      : null;
    store.setLogReviewerState(instance.id, seed.state, {
      findingCount: seed.findingCount,
      sandboxRunId,
    });
  }

  for (const seed of FIX_IMPLEMENTERS) {
    const instance = store.openFixImplementer({
      repositoryId: seed.repositoryId === 'platform' ? platform : webapp,
      findingFingerprint: seed.fingerprint,
      serviceName: seed.serviceName,
      findingEvidence: seed.evidence,
    });
    const sandboxRunId = seed.run
      ? seedRun(instance.id, 'fix_implementer', 'FixImplementer', seed.run)
      : null;
    store.setFixImplementerState(instance.id, seed.state, {
      pullRequestNumber: seed.pullRequestNumber,
      discardReason: seed.discardReason,
      sandboxRunId,
    });
  }

  for (const seed of REQUESTS) {
    const request = store.createRequest({
      requestSource: seed.source,
      requestText: seed.text,
      requesterExternalId: seed.requester,
      repositoryId: seed.repositoryId === 'platform' ? platform : webapp,
      subjectType: seed.subjectType,
      subjectExternalId: seed.subjectExternalId,
    });
    const sandboxRunId = seed.run
      ? seedRun(request.id, 'request_router', 'RequestRouter', seed.run)
      : null;
    store.setRequestState(request.id, seed.state, {
      resolutionNote: seed.resolutionNote,
      sandboxRunId,
    });
    if (seed.answeredBy) {
      store.markRequestConsumed(
        request.id,
        seed.answeredBy,
        firstInstanceOf(seed.answeredBy),
        seed.repositoryId === 'platform' ? platform : webapp,
      );
    }
  }

  seedArrivals();
  seedSystemMoments();
}

// firstInstanceOf answers an instance of that machine, so a seeded ask can point at
// something the operator can open.
function firstInstanceOf(workflowType: WorkflowType): string {
  const [row] = store.queryReadOnly(
    `SELECT workflow_instance_id FROM sandbox_run WHERE workflow_type = ? LIMIT 1`,
    [workflowType],
  ) as Array<{ workflow_instance_id: string }>;
  return row?.workflow_instance_id ?? 'unknown';
}

// seedArrivals writes the transitions the machines would have recorded, spread over
// the last month, because the output metrics count arrivals and not rows.
function seedArrivals(): void {
  for (const arrival of ARRIVALS) {
    for (let index = 0; index < arrival.count; index += 1) {
      const daysAgo = (index * 29) / Math.max(1, arrival.count - 1);
      store.appendEvent({
        eventType: 'workflow.state_changed',
        workflowType: arrival.workflowType,
        workflowInstanceId: firstInstanceOf(arrival.workflowType),
        fromState: arrival.fromState,
        toState: arrival.toState,
      });
      stampLastEventAt(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    }
  }
}

function seedSystemMoments(): void {
  store.appendEvent({
    eventType: 'orchestrator.started',
    metadata: { worker_runner: 'preview', port: PORT },
  });
  store.appendEvent({
    eventType: 'orchestrator.runs_left_by_dead_process',
    metadata: { count: 2 },
  });
  store.appendEvent({
    eventType: 'orchestrator.webhook_already_handled',
    metadata: { provider_name: 'github', provider_delivery_id: '4f2a1c' },
  });
  store.appendEvent({
    eventType: 'operator.prompt_saved',
    metadata: { agent_name: 'PrMaintainer', operator_email: 'operator@example.test' },
  });
  store.appendEvent({
    eventType: 'agent.codex_run_completed',
    metadata: {
      message: 'Codex run completed',
      exit_code: 0,
      stdout: codexStdout(12),
    },
  });
  const run = firstSandboxRun();
  store.appendEvent({
    eventType: 'agent.finished',
    workflowType: run.workflow_type,
    workflowInstanceId: run.workflow_instance_id,
    sandboxRunId: run.id,
    metadata: {
      message: 'Codex run completed',
      exit_code: 0,
      stdout: codexStdout(400),
    },
  });
}

// firstSandboxRun answers a run the preview already seeded, so the event naming it
// links to something an operator can open.
function firstSandboxRun(): {
  id: string;
  workflow_type: WorkflowType;
  workflow_instance_id: string;
} {
  const [row] = store.queryReadOnly(
    `SELECT id, workflow_type, workflow_instance_id FROM sandbox_run LIMIT 1`,
  ) as Array<{ id: string; workflow_type: WorkflowType; workflow_instance_id: string }>;
  return row;
}

// codexStdout is a Codex transcript, the longest value an event carries in one metadata
// key; the feed sends a short one whole and holds a long one back.
function codexStdout(lines: number): string {
  return Array.from(
    { length: lines },
    (_unused, index) =>
      `{"type":"item.completed","item":{"id":"item_${index}","type":"command_execution","command":"/bin/bash -lc 'sed -n 1,220p AGENTS.md'","aggregated_output":"# AGENTS.md\\n\\nConventions for whoever edits this repository, human or agent.","exit_code":0,"status":"completed"}}`,
  ).join(' ');
}

// stampLastEventAt backdates the event just written, which is the only way to draw a
// series that spans days without waiting days.
function stampLastEventAt(createdAt: number): void {
  store.db
    .prepare(
      'UPDATE event_log SET created_at = ? WHERE id = (SELECT id FROM event_log ORDER BY rowid DESC LIMIT 1)',
    )
    .run(createdAt);
}

// seedRun writes the sandbox run an instance would have produced, and the events it
// would have reported on the way.
function seedRun(
  workflowInstanceId: string,
  workflowType: WorkflowType,
  agentName: string,
  seed: RunSeed,
): string {
  const run = store.startSandboxRun({ agentName, workflowType, workflowInstanceId });
  store.appendEvent({
    eventType: 'sandbox.ready',
    workflowType,
    workflowInstanceId,
    sandboxRunId: run.id,
    metadata: { sandbox_session_id: `sess-${run.id.slice(0, 8)}` },
  });
  if (seed.runState === 'running') {
    store.markSandboxRunRunning(run.id, `sess-${run.id.slice(0, 8)}`);
    return run.id;
  }
  store.appendEvent({
    eventType: 'agent.finished',
    workflowType,
    workflowInstanceId,
    sandboxRunId: run.id,
    metadata: { summary: seed.summary },
  });
  store.finishSandboxRun(run.id, {
    runState: seed.runState,
    sandboxSessionId: `sess-${run.id.slice(0, 8)}`,
    costUsd: seed.costUsd,
    errorMessage: seed.errorMessage,
  });
  return run.id;
}

interface RunSeed {
  runState: 'running' | 'succeeded' | 'failed' | 'aborted';
  costUsd?: number;
  summary?: string;
  errorMessage?: string;
}

interface PrMaintainerSeed {
  repositoryId: 'platform' | 'webapp';
  pullRequestNumber: number;
  state: PrMaintainerState;
  attemptCount?: number;
  needsHumanReason?: string;
  run?: RunSeed;
}

interface LinearImplementerSeed {
  repositoryId: 'platform' | 'webapp';
  identifier: string;
  state: LinearImplementerState;
  agentName?: string;
  promptContext?: string;
  pullRequestNumber?: number;
  iterationNumber?: number;
  verifierVerdict?: VerifierVerdict;
  verifierIssues?: string;
  needsHumanReason?: string;
  run?: RunSeed;
}

interface LogReviewerSeed {
  repositoryId: 'platform' | 'webapp';
  serviceName: string;
  environmentName: string;
  state: LogReviewerState;
  findingCount?: number;
  run?: RunSeed;
}

interface FixImplementerSeed {
  repositoryId: 'platform' | 'webapp';
  fingerprint: string;
  serviceName: string;
  evidence: string;
  state: FixImplementerState;
  pullRequestNumber?: number;
  discardReason?: string;
  run?: RunSeed;
}

interface RequestSeed {
  source: RequestSource;
  text: string;
  requester?: string;
  repositoryId: 'platform' | 'webapp';
  subjectType?: SubjectType;
  subjectExternalId?: string;
  state: RequestRouterState;
  resolutionNote?: string;
  answeredBy?: WorkflowType;
  run?: RunSeed;
}

// unreadableGitHub answers that there is nothing to do, so a tick can never make
// the preview reach out.
function unreadableGitHub() {
  return {
    readPullRequest: () =>
      Promise.resolve({
        state: 'open' as const,
        headCommitSha: '',
        checksAreRed: false,
        hasUnresolvedReviewThreads: false,
      }),
    markReadyForReview: () => Promise.resolve(undefined),
    findOpenImplementationPullRequest: () => Promise.resolve(undefined),
    markCommentPickedUp: () => Promise.resolve(undefined),
  };
}
