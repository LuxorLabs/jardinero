// WorkConversation is where one piece of work is talked about. The key is opaque: nothing
// outside the machines has to know which workflow it came from.
export interface WorkConversation {
  key: string;
  name: string;
  repositoryId: string;
  workflowInstanceId: string;
  askedBy?: { source: string; externalId: string };
}

// linearIssueConversationKey files a ticket's conversation under the ticket itself, so
// whoever asks for it and whoever works on it end up in the same thread.
export function linearIssueConversationKey(linearIssueIdentifier: string): string {
  return `${LINEAR_ISSUE_CONVERSATION_PREFIX}${linearIssueIdentifier.toUpperCase()}`;
}

// linearIssueOfConversationKey reads the ticket back out of a key, for whoever finds the
// conversation first and has to say what it is about.
export function linearIssueOfConversationKey(conversationKey: string): string | undefined {
  return conversationKey.startsWith(LINEAR_ISSUE_CONVERSATION_PREFIX)
    ? conversationKey.slice(LINEAR_ISSUE_CONVERSATION_PREFIX.length)
    : undefined;
}

const LINEAR_ISSUE_CONVERSATION_PREFIX = 'linear_issue:';

// WorkAnnouncer is what a machine says to whoever is waiting, in the words of the work and
// never in the names of its states. Nothing answers or throws: the moment already happened,
// so failing to say it changes nothing.
export interface WorkAnnouncer {
  ticketImplementationStarted(work: WorkConversation, ticket: { identifier: string }): void;
  ticketVerificationStarted(work: WorkConversation, ticket: { identifier: string }): void;
  ticketRejectedByVerifier(
    work: WorkConversation,
    ticket: { identifier: string; attempt: number },
  ): void;
  ticketParked(work: WorkConversation, ticket: { identifier: string; reason: string | null }): void;

  fixParked(work: WorkConversation, fix: { reason: string | null }): void;

  pullRequestAdopted(work: WorkConversation, pull: { number: number }): void;
  pullRequestMaintenanceParked(
    work: WorkConversation,
    pull: { number: number; reason: string | null },
  ): void;
  pullRequestMerged(work: WorkConversation, pull: { number: number }): void;
  pullRequestClosed(work: WorkConversation, pull: { number: number }): void;

  requestUnresolvable(work: WorkConversation, request: { questions: string | null }): void;
}
