import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { AppConfig } from '../../config.js';
import { DEMO_LOG_REVIEW_TARGET, configWithLogReview } from '../../testing/config.js';
import type { ScanTarget } from '../../orchestrator/state-machines/log-reviewer/events.js';
import type { CommentData } from '../../orchestrator/state-machines/pr-maintainer/events.js';
import type { Store } from '../../store/store.js';
import { createTestStore } from '../../testing/store.js';
import { AGENT_PR_COMMENT_MARKER } from '../../workflows/pr/pr-maintainer.js';
import { handleGitHubDelivery } from './github-delivery.js';

const REPOSITORY = DEMO_LOG_REVIEW_TARGET.repo;
const LOG_REVIEW_REPOSITORY = REPOSITORY;

const CONFIG = configWithLogReview();
const PULL_REQUEST_NUMBER = 4688;

let store: Store;
let cleanup: () => void;
let events: RecordedEvent[];
let scans: ScanTarget[];

beforeEach(() => {
  ({ store, cleanup } = createTestStore());
  events = [];
  scans = [];
});

afterEach(() => {
  cleanup();
});

describe('handleGitHubDelivery', () => {
  const cases: DeliveryCase[] = [
    {
      name: 'When the event is not one we act on then should report it ignored',
      eventName: 'push',
      payload: { ref: 'refs/heads/main' },
      want: { reason: 'event_ignored' },
    },
    {
      name: 'When a pull request delivery carries no pull request then should report it',
      eventName: 'pull_request',
      payload: { action: 'ready_for_review', repository: { full_name: REPOSITORY } },
      want: { reason: 'missing_pull_request' },
    },
    {
      name: 'When a pull request delivery names no repository then should report it',
      eventName: 'pull_request',
      payload: { action: 'ready_for_review', pull_request: { number: PULL_REQUEST_NUMBER } },
      want: { reason: 'delivery_without_repository' },
    },
    {
      name: 'When the pull request left draft then should report it ready for review',
      eventName: 'pull_request',
      payload: pullRequestPayload('ready_for_review'),
      want: { event: 'onPrReadyForReview' },
    },
    {
      name: 'When the pull request was reopened then should report it reopened',
      eventName: 'pull_request',
      payload: pullRequestPayload('reopened'),
      want: { event: 'onPrReopened' },
    },
    {
      name: 'When the pull request left draft then should report its branch',
      eventName: 'pull_request',
      payload: pullRequestPayload('ready_for_review', { head: { ref: 'agent/fix-1' } }),
      want: {
        event: 'onPrReadyForReview',
        headBranch: 'agent/fix-1',
      },
    },
    {
      name: 'When the pull request got new commits then should report the head it moved to',
      eventName: 'pull_request',
      payload: pullRequestPayload('synchronize', { head: { sha: 'sha-2' } }),
      want: { event: 'onPrSynchronize', headCommitSha: 'sha-2' },
    },
    {
      name: 'When the pull request closed merged then should report it merged',
      eventName: 'pull_request',
      payload: pullRequestPayload('closed', { merged: true }),
      want: { event: 'onPrMerged' },
    },
    {
      name: 'When the pull request closed unmerged then should report it closed',
      eventName: 'pull_request',
      payload: pullRequestPayload('closed', { merged: false }),
      want: { event: 'onPrClosed' },
    },
    {
      name: 'When the pull request action is another one then should report it ignored',
      eventName: 'pull_request',
      payload: pullRequestPayload('assigned'),
      want: { reason: 'pull_request_action_ignored' },
    },
    {
      name: 'When a comment was deleted then should report it ignored',
      eventName: 'issue_comment',
      payload: { ...commentPayload(), action: 'deleted' },
      want: { reason: 'comment_action_ignored' },
    },
    {
      name: 'When the comment is on a plain issue then should report it is not a pull request',
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        repository: { full_name: REPOSITORY },
        issue: { number: 12 },
        comment: { body: 'hello' },
      },
      want: { reason: 'not_a_pull_request' },
    },
    {
      name: 'When a comment delivery names no repository then should report it',
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        issue: { number: PULL_REQUEST_NUMBER, pull_request: { url: 'https://api.test/x' } },
        comment: { body: 'hello' },
      },
      want: { reason: 'delivery_without_repository' },
    },
    {
      name: 'When a comment is on a pull request then should report the comment and its event name',
      eventName: 'issue_comment',
      payload: commentPayload(),
      want: { event: 'onPrComment', reason: 'issue_comment' },
    },
    {
      name: 'When a review comment arrives then should report the comment',
      eventName: 'pull_request_review_comment',
      payload: {
        action: 'created',
        repository: { full_name: REPOSITORY },
        pull_request: { number: PULL_REQUEST_NUMBER },
        comment: { body: 'here' },
      },
      want: { event: 'onPrComment', reason: 'pull_request_review_comment' },
    },
    {
      name: 'When a review arrives then should report it as a comment',
      eventName: 'pull_request_review',
      payload: {
        action: 'submitted',
        repository: { full_name: REPOSITORY },
        pull_request: { number: PULL_REQUEST_NUMBER },
        review: { body: 'looks good' },
      },
      want: { event: 'onPrComment', reason: 'pull_request_review' },
    },
    {
      name: 'When a review was edited then should report it ignored',
      eventName: 'pull_request_review',
      payload: {
        action: 'edited',
        repository: { full_name: REPOSITORY },
        pull_request: { number: PULL_REQUEST_NUMBER },
        review: { body: 'looks good' },
      },
      want: { reason: 'review_action_ignored' },
    },
    {
      name: 'When a check suite is still running then should report it ignored',
      eventName: 'check_suite',
      payload: { action: 'requested', check_suite: { conclusion: null } },
      want: { reason: 'check_suite_action_ignored' },
    },
    {
      name: 'When a check suite delivery carries no suite then should report it',
      eventName: 'check_suite',
      payload: { action: 'completed' },
      want: { reason: 'missing_check_suite' },
    },
    {
      name: 'When a completed suite names no pull request then should report it',
      eventName: 'check_suite',
      payload: { action: 'completed', check_suite: { conclusion: 'success', pull_requests: [] } },
      want: { reason: 'check_suite_without_pr' },
    },
    {
      name: 'When a completed suite names a pull request without a number then should report it',
      eventName: 'check_suite',
      payload: {
        action: 'completed',
        repository: { full_name: REPOSITORY },
        check_suite: { conclusion: 'success', pull_requests: [{ url: 'https://api.test/x' }] },
      },
      want: { reason: 'check_suite_without_pr' },
    },
    {
      name: 'When a completed suite failed then should report the checks red',
      eventName: 'check_suite',
      payload: checkSuitePayload('failure'),
      want: { event: 'onPrCICompleted', checksAreRed: true },
    },
    {
      name: 'When a completed suite passed then should report the checks green',
      eventName: 'check_suite',
      payload: checkSuitePayload('success'),
      want: { event: 'onPrCICompleted', checksAreRed: false },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const outcome = await handleGitHubDelivery(deps(), {
        eventName: c.eventName,
        payload: c.payload,
      });

      assert.equal(outcome.handled, c.want.event !== undefined);
      assert.equal(outcome.reason, c.want.reason);
      assert.equal(events.at(0)?.name, c.want.event);
      if (c.want.event) {
        assert.equal(events.at(0)?.ref.pullRequestNumber, PULL_REQUEST_NUMBER);
      }
      if (c.want.headCommitSha !== undefined) {
        assert.equal(events.at(0)?.headCommitSha, c.want.headCommitSha);
      }
      if (c.want.checksAreRed !== undefined) {
        assert.equal(events.at(0)?.checksAreRed, c.want.checksAreRed);
      }
      if (c.want.headBranch !== undefined) {
        assert.equal((events.at(0)?.ref as { headBranch?: string }).headBranch, c.want.headBranch);
      }
    });
  }

  // Whether a comment is ours and whether it tags us are the two facts the machine
  // decides on, so the adapter has to read them right.
  const commentFactCases: CommentFactCase[] = [
    {
      name: 'When the author is the agent app then should say the comment is ours',
      comment: {
        body: 'done',
        user: { login: `${CONFIG.workflows.prMaintainer.agentLogin}[bot]` },
      },
      want: { authoredByUs: true, mentionsUs: false, comment: false },
    },
    {
      name: 'When the body carries our marker then should say the comment is ours',
      comment: { body: `done ${AGENT_PR_COMMENT_MARKER}`, user: { login: 'someone' } },
      want: { authoredByUs: true, mentionsUs: false, comment: false },
    },
    {
      name: 'When the body tags the agent then should say it mentions us',
      comment: {
        body: `@${CONFIG.workflows.prMaintainer.agentLogin} please fix`,
        user: { login: 'someone' },
      },
      want: { authoredByUs: false, mentionsUs: true, commentType: 'review' },
    },
    {
      name: 'When the comment is on the conversation then should say a mark goes on the issue',
      eventName: 'issue_comment',
      comment: { id: 991, body: 'please fix', user: { login: 'someone' } },
      want: { authoredByUs: false, mentionsUs: false, commentType: 'issue' },
    },
    {
      // A login can carry digits and dashes, so a bare substring would tag us for
      // somebody else's handle.
      name: 'When the tag is a longer handle then should not say it mentions us',
      comment: {
        body: `@${CONFIG.workflows.prMaintainer.agentLogin}-dev please fix`,
        user: { login: 'someone' },
      },
      want: { authoredByUs: false, mentionsUs: false, commentType: 'review' },
    },
    {
      name: 'When the pull request is a draft and merged then should carry both facts',
      comment: { body: 'note', user: { login: 'someone' } },
      pullRequest: { draft: true, merged: true },
      want: {
        authoredByUs: false,
        mentionsUs: false,
        isDraft: true,
        isMerged: true,
        commentType: 'review',
      },
    },
    {
      // GitHub takes no reaction on a review body, so the fact travels with nowhere
      // for the machine to mark it.
      name: 'When a review is submitted then should say a mark goes nowhere',
      eventName: 'pull_request_review',
      comment: {
        id: 991,
        body: `@${CONFIG.workflows.prMaintainer.agentLogin} please fix`,
        user: { login: 'someone' },
      },
      want: { authoredByUs: false, mentionsUs: true },
    },
    {
      // GitHub always sends an id on a comment; without one there is nowhere to reply.
      name: 'When the comment carries no id then should carry no reply target',
      comment: { id: undefined, body: 'note', user: { login: 'someone' } },
      want: { authoredByUs: false, mentionsUs: false, externalId: null, commentType: 'review' },
    },
  ];

  for (const c of commentFactCases) {
    test(c.name, async () => {
      await handleGitHubDelivery(deps(c.config), {
        eventName: c.eventName ?? 'pull_request_review_comment',
        payload: {
          action: c.eventName === 'pull_request_review' ? 'submitted' : 'created',
          repository: { full_name: REPOSITORY },
          pull_request: { number: PULL_REQUEST_NUMBER, ...c.pullRequest },
          comment: { id: 991, ...c.comment },
        },
      });

      const data = events.at(0)?.ref as CommentData | undefined;
      assert.equal(data?.authoredByUs, c.want.authoredByUs);
      assert.equal(data?.mentionsUs, c.want.mentionsUs);
      assert.equal(data?.isDraft, c.want.isDraft ?? false);
      assert.equal(data?.isMerged, c.want.isMerged ?? false);
      assert.deepEqual(
        store.listUnconsumedRequests('pull_request', String(PULL_REQUEST_NUMBER)),
        [],
      );
      const wantComment = c.want.comment ?? true;
      assert.equal(data?.comment?.author, wantComment ? c.comment.user?.login : undefined);
      assert.equal(
        data?.comment?.externalId ?? null,
        wantComment ? (c.want.externalId === undefined ? '991' : c.want.externalId) : null,
      );
      assert.equal(data?.comment?.commentType, wantComment ? c.want.commentType : undefined);
    });
  }

  // A disabled workflow must not be reached by its deliveries, whatever they say.
  const gateCases: GateCase[] = [
    {
      name: 'When pull request maintenance is off then should report a pull request ignored',
      eventName: 'pull_request',
      payload: pullRequestPayload('ready_for_review'),
      config: configWith({ prMaintainerEnabled: false }),
      wantReason: 'pr_maintain_disabled',
    },
    {
      name: 'When pull request maintenance is off then should report a comment ignored',
      eventName: 'issue_comment',
      payload: commentPayload(),
      config: configWith({ prMaintainerEnabled: false }),
      wantReason: 'pr_maintain_disabled',
    },
    {
      name: 'When pull request maintenance is off then should report a check suite ignored',
      eventName: 'check_suite',
      payload: checkSuitePayload('failure'),
      config: configWith({ prMaintainerEnabled: false }),
      wantReason: 'pr_maintain_disabled',
    },
    {
      name: 'When log review is off then should report a deployment ignored',
      eventName: 'deployment_status',
      payload: deploymentStatusPayload(),
      config: configWith({ logReviewEnabled: false }),
      wantReason: 'log_review_disabled',
    },
  ];

  for (const testCase of gateCases) {
    test(testCase.name, async () => {
      const outcome = await handleGitHubDelivery(deps(testCase.config), {
        eventName: testCase.eventName,
        payload: testCase.payload,
      });

      assert.equal(outcome.handled, false);
      assert.equal(outcome.reason, testCase.wantReason);
      assert.deepEqual(events, []);
      assert.deepEqual(scans, []);
    });
  }

  const deploymentCases: DeliveryCase[] = [
    {
      name: 'When the delivery carries no deployment status then should report it',
      eventName: 'deployment_status',
      payload: { repository: { full_name: LOG_REVIEW_REPOSITORY } },
      want: { reason: 'missing_deployment_status' },
    },
    {
      // Only a deployment that landed can have produced new errors to read.
      name: 'When the deployment did not succeed then should report it',
      eventName: 'deployment_status',
      payload: deploymentStatusPayload({ state: 'failure' }),
      want: { reason: 'deployment_not_successful' },
    },
    {
      name: 'When the deployed repository is not configured then should report it out of scope',
      eventName: 'deployment_status',
      payload: deploymentStatusPayload({ repository: 'acme/unknown' }),
      want: { reason: 'repo_out_of_scope' },
    },
    {
      name: 'When the deployed environment is not one we review then should report it out of scope',
      eventName: 'deployment_status',
      payload: deploymentStatusPayload({ environment: 'ephemeral-pr-42' }),
      want: { reason: 'environment_out_of_scope' },
    },
  ];

  for (const testCase of deploymentCases) {
    test(testCase.name, async () => {
      const outcome = await handleGitHubDelivery(deps(), {
        eventName: testCase.eventName,
        payload: testCase.payload,
      });

      assert.equal(outcome.handled, false);
      assert.equal(outcome.reason, testCase.want.reason);
      assert.deepEqual(scans, []);
    });
  }

  test('When a deployment succeeded then should announce a scan per configured target', async () => {
    const outcome = await handleGitHubDelivery(deps(), {
      eventName: 'deployment_status',
      payload: deploymentStatusPayload({ environment: 'production' }),
    });

    const repositoryId = store.findRepositoryByFullName(LOG_REVIEW_REPOSITORY)?.id;
    const targets = CONFIG.workflows.logReviewer.repos.filter(
      (candidate) => candidate.repo === LOG_REVIEW_REPOSITORY,
    );
    assert.equal(outcome.handled, true);
    assert.deepEqual(
      scans,
      targets.map((target) => ({
        repositoryId,
        serviceName: target.namespace,
        environmentName: target.namespace,
      })),
    );
  });

  // The environment can arrive on either side of the payload, and a target answers
  // for the cluster it names.
  const environmentCases: Array<{ name: string; payload: Record<string, unknown> }> = [
    {
      name: 'When only the deployment status names the environment then should read it there',
      payload: {
        repository: { full_name: LOG_REVIEW_REPOSITORY },
        deployment_status: { state: 'success', environment: 'production' },
      },
    },
    {
      name: 'When the environment is the cluster of a target then should announce that target',
      payload: deploymentStatusPayload({
        environment: CONFIG.workflows.logReviewer.repos[0].clusters[0],
      }),
    },
  ];

  for (const testCase of environmentCases) {
    test(testCase.name, async () => {
      const outcome = await handleGitHubDelivery(deps(), {
        eventName: 'deployment_status',
        payload: testCase.payload,
      });

      assert.equal(outcome.handled, true);
      assert.ok(scans.length > 0);
    });
  }

  test('When the deployment names no environment then should announce every target', async () => {
    await handleGitHubDelivery(deps(), {
      eventName: 'deployment_status',
      payload: deploymentStatusPayload(),
    });

    assert.equal(
      scans.length,
      CONFIG.workflows.logReviewer.repos.filter(
        (candidate) => candidate.repo === LOG_REVIEW_REPOSITORY,
      ).length,
    );
  });

  // The reply cap is per thread, so the machine has to be told which thread the
  // comment belongs to.
  const threadCases: Array<{
    name: string;
    eventName: string;
    comment: { user?: { login: string } } & Record<string, unknown>;
    want?: string;
  }> = [
    {
      name: 'When the review comment opens a thread then should report its own id as the thread',
      eventName: 'pull_request_review_comment',
      comment: { id: 991, body: 'here' },
      want: '991',
    },
    {
      name: 'When the review comment answers another then should report the root as the thread',
      eventName: 'pull_request_review_comment',
      comment: { id: 992, in_reply_to_id: 991, body: 'here' },
      want: '991',
    },
    {
      name: 'When the review comment carries no id then should report no thread',
      eventName: 'pull_request_review_comment',
      comment: { body: 'here' },
    },
    {
      name: 'When the comment is not a review comment then should report no thread',
      eventName: 'issue_comment',
      comment: { id: 993, body: 'here' },
    },
  ];

  for (const testCase of threadCases) {
    test(testCase.name, async () => {
      await handleGitHubDelivery(deps(), {
        eventName: testCase.eventName,
        payload: {
          action: 'created',
          repository: { full_name: REPOSITORY },
          issue: { number: PULL_REQUEST_NUMBER, pull_request: { url: 'https://api.test/x' } },
          pull_request: { number: PULL_REQUEST_NUMBER },
          comment: testCase.comment,
        },
      });

      assert.equal((events.at(0)?.ref as CommentData).reviewThreadId, testCase.want);
    });
  }

  test('When a person comments then should carry who wrote it and where to answer them', async () => {
    await handleGitHubDelivery(deps(), {
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        repository: { full_name: REPOSITORY },
        issue: { number: PULL_REQUEST_NUMBER, pull_request: { url: 'https://api.test/x' } },
        comment: { id: 4242, body: '@acme-jardinero look at this', user: { login: 'lucio' } },
      },
    });

    const data = events.at(0)?.ref as CommentData;
    assert.equal(data.comment?.author, 'lucio');
    assert.equal(data.comment?.body, '@acme-jardinero look at this');
    assert.equal(data.comment?.externalId, '4242');
    assert.deepEqual(store.listUnconsumedRequests('pull_request', String(PULL_REQUEST_NUMBER)), []);
  });

  test('When the repository is not registered yet then should register it', async () => {
    await handleGitHubDelivery(deps(), {
      eventName: 'pull_request',
      payload: pullRequestPayload('ready_for_review'),
    });

    assert.equal(store.findRepositoryByFullName(REPOSITORY)?.fullName, REPOSITORY.toLowerCase());
  });

  // A suite can name several pull requests, and only the ones we follow have an
  // instance to move.
  test('When a suite names two pull requests then should report both', async () => {
    await handleGitHubDelivery(deps(), {
      eventName: 'check_suite',
      payload: {
        action: 'completed',
        repository: { full_name: REPOSITORY },
        check_suite: {
          conclusion: 'failure',
          pull_requests: [{ number: PULL_REQUEST_NUMBER }, { number: 4689 }],
        },
      },
    });

    assert.deepEqual(
      events.map((event) => event.ref.pullRequestNumber),
      [PULL_REQUEST_NUMBER, 4689],
    );
  });
});

function deps(config: AppConfig = CONFIG) {
  return {
    config,
    store,
    prMaintainer: recordingPrMaintainer(events),
    logReviewer: { onScheduledScan: recordScan },
  };
}

function recordScan(target: ScanTarget): Promise<undefined> {
  scans.push(target);
  return Promise.resolve(undefined);
}

// configWith copies the bundled config so a case can turn one workflow off without
// leaking the change into the next one.
function configWith(overrides: {
  prMaintainerEnabled?: boolean;
  logReviewEnabled?: boolean;
}): AppConfig {
  const config = configWithLogReview();
  config.workflows.prMaintainer.enabled = overrides.prMaintainerEnabled ?? true;
  config.workflows.logReviewer.enabled = overrides.logReviewEnabled ?? true;
  return config;
}

function deploymentStatusPayload(
  fields: { state?: string; environment?: string; repository?: string } = {},
): Record<string, unknown> {
  return {
    repository: { full_name: fields.repository ?? LOG_REVIEW_REPOSITORY },
    deployment: { environment: fields.environment },
    deployment_status: { state: fields.state ?? 'success' },
  };
}

function pullRequestPayload(
  action: string,
  pullRequest: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action,
    repository: { full_name: REPOSITORY },
    pull_request: { number: PULL_REQUEST_NUMBER, ...pullRequest },
  };
}

function commentPayload(): Record<string, unknown> {
  return {
    action: 'created',
    repository: { full_name: REPOSITORY },
    issue: { number: PULL_REQUEST_NUMBER, pull_request: { url: 'https://api.github.com/x' } },
    comment: { body: 'please address this', user: { login: 'someone' } },
  };
}

function checkSuitePayload(conclusion: string): Record<string, unknown> {
  return {
    action: 'completed',
    repository: { full_name: REPOSITORY },
    check_suite: { conclusion, pull_requests: [{ number: PULL_REQUEST_NUMBER }] },
  };
}

// recordingPrMaintainer records which event a delivery became and what it carried.
function recordingPrMaintainer(recorded: RecordedEvent[]) {
  const record =
    (name: string) =>
    (ref: { pullRequestNumber: number }, second?: unknown): Promise<undefined> => {
      recorded.push({
        name,
        ref,
        headCommitSha: typeof second === 'string' ? second : undefined,
        checksAreRed: (ref as { checksAreRed?: boolean }).checksAreRed,
      });
      return Promise.resolve(undefined);
    };
  const byId = (name: string) => (): Promise<undefined> => {
    recorded.push({ name, ref: { pullRequestNumber: 0 } });
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
    // The adapter never reaches these, so a recorded call would be a bug: they are
    // here because the port is the machine's whole interface.
    onSandboxRunSucceeded: byId('onSandboxRunSucceeded'),
    onSandboxRunFailed: byId('onSandboxRunFailed'),
    onOperatorRetry: byId('onOperatorRetry'),
    onOperatorDismiss: byId('onOperatorDismiss'),
    onPeriodicCheck: byId('onPeriodicCheck'),
    onSystemRecovery: byId('onSystemRecovery'),
  };
}

interface RecordedEvent {
  name: string;
  ref: { pullRequestNumber: number };
  headCommitSha?: string;
  checksAreRed?: boolean;
}

interface DeliveryCase {
  name: string;
  eventName: string;
  payload: Record<string, unknown>;
  want: {
    event?: string;
    reason?: string;
    headCommitSha?: string;
    checksAreRed?: boolean;
    headBranch?: string;
  };
}

interface GateCase {
  name: string;
  eventName: string;
  payload: Record<string, unknown>;
  config: AppConfig;
  wantReason: string;
}

interface CommentFactCase {
  name: string;
  eventName?: string;
  comment: { user?: { login: string } } & Record<string, unknown>;
  pullRequest?: Record<string, unknown>;
  config?: AppConfig;
  want: {
    authoredByUs: boolean;
    mentionsUs: boolean;
    isDraft?: boolean;
    isMerged?: boolean;
    comment?: boolean;
    externalId?: string | null;
    commentType?: 'issue' | 'review';
  };
}
