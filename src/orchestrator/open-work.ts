import type { Store } from '../store/store.js';
import { linearIssueOfConversationKey } from './work-announcer.js';
import type { WorkflowType } from '../store/types.js';

// OpenWork is one piece of work still going, said in the words of the work: what it is
// about and what is happening to it, never the name of the state it sits in.
export interface OpenWork {
  workflowType: WorkflowType;
  workflowInstanceId: string;
  repositoryFullName: string;
  name: string;
  happening: string;
  needsPerson: boolean;
}

// What each state means to somebody waiting. The machines own their states, so this is the
// one place that turns them into something a person reads.
const HAPPENING: Readonly<Record<string, string>> = {
  li_pending: 'waiting to start',
  li_implementing: 'being written',
  li_verifying: 'being verified',
  li_waiting_pr: 'waiting on its pull request',
  li_needs_human: 'waiting for a person',
  fi_pending: 'waiting to start',
  fi_implementing: 'being written',
  fi_verifying: 'being verified',
  fi_waiting_pr: 'waiting on its pull request',
  fi_needs_human: 'waiting for a person',
  prm_pending: 'waiting to start',
  prm_working: 'answering its review',
  prm_waiting: 'waiting for a review',
  prm_attempts_exhausted: 'waiting for a person',
};

// listWorkInConversation answers what one conversation is about: the ticket, and the pull
// request its work opened, whatever state each is in. A conversation nobody is working on
// answers nothing.
export function listWorkInConversation(store: Store, conversationKey: string): OpenWork[] {
  const identifier = linearIssueOfConversationKey(conversationKey);
  if (!identifier) return [];
  const ticket = store.findLinearImplementerByIdentifier(identifier);
  if (!ticket) return [];

  const pullRequest = ticket.pullRequestNumber
    ? store.findPrMaintainerByPullRequest(ticket.repositoryId, ticket.pullRequestNumber)
    : undefined;
  return [
    describe(
      store,
      'linear_implementer',
      ticket.id,
      ticket.repositoryId,
      ticket.linearIssueIdentifier,
      ticket.workflowState,
    ),
    ...(pullRequest
      ? [
          describe(
            store,
            'pr_maintainer',
            pullRequest.id,
            pullRequest.repositoryId,
            `#${pullRequest.pullRequestNumber}`,
            pullRequest.workflowState,
          ),
        ]
      : []),
  ];
}

function describe(
  store: Store,
  workflowType: WorkflowType,
  workflowInstanceId: string,
  repositoryId: string,
  name: string,
  workflowState: string,
): OpenWork {
  return {
    workflowType,
    workflowInstanceId,
    repositoryFullName: store.getRepositoryById(repositoryId)?.fullName ?? '',
    name,
    happening: HAPPENING[workflowState] ?? ENDED[workflowState] ?? 'being worked on',
    needsPerson: HAPPENING[workflowState] === 'waiting for a person',
  };
}

// How a work that has ended reads, which is what a conversation about it still has to say.
const ENDED: Readonly<Record<string, string>> = {
  li_done: 'merged',
  li_abandoned: 'closed without merging',
  li_dismissed: 'dismissed',
  fi_done: 'merged',
  fi_abandoned: 'closed without merging',
  fi_discarded: 'discarded',
  fi_dismissed: 'dismissed',
  prm_merged: 'merged',
  prm_closed: 'closed without merging',
  prm_dismissed: 'dismissed',
};

// listOpenWork answers everything still going, newest first, narrowed to one repository
// when the caller names one.
export function listOpenWork(store: Store, repositoryFullName?: string): OpenWork[] {
  const repositoryId = repositoryFullName
    ? store.findRepositoryByFullName(repositoryFullName)?.id
    : undefined;
  if (repositoryFullName && !repositoryId) return [];

  const open: OpenWork[] = [
    ...store.listOpenLinearImplementers().map((instance) => ({
      workflowType: 'linear_implementer' as const,
      workflowInstanceId: instance.id,
      repositoryId: instance.repositoryId,
      name: instance.linearIssueIdentifier,
      workflowState: instance.workflowState,
    })),
    ...store.listOpenFixImplementers().map((instance) => ({
      workflowType: 'fix_implementer' as const,
      workflowInstanceId: instance.id,
      repositoryId: instance.repositoryId,
      name: `a fix for ${instance.serviceName ?? 'the logs'}`,
      workflowState: instance.workflowState,
    })),
    ...store.listOpenPrMaintainers().map((instance) => ({
      workflowType: 'pr_maintainer' as const,
      workflowInstanceId: instance.id,
      repositoryId: instance.repositoryId,
      name: `#${instance.pullRequestNumber}`,
      workflowState: instance.workflowState,
    })),
  ]
    .filter((instance) => !repositoryId || instance.repositoryId === repositoryId)
    .map((instance) => ({
      workflowType: instance.workflowType,
      workflowInstanceId: instance.workflowInstanceId,
      repositoryFullName: store.getRepositoryById(instance.repositoryId)?.fullName ?? '',
      name: instance.name,
      happening: HAPPENING[instance.workflowState] ?? 'being worked on',
      needsPerson: HAPPENING[instance.workflowState] === 'waiting for a person',
    }));

  return open;
}
