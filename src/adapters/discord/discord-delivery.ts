import {
  type AppConfig,
  linearTeamKeysForRepository,
  personForDiscordUserId,
  repositoriesForDiscordChannel,
  repositoryForLinearTeamKey,
} from '../../config.js';
import type { OpenWork } from '../../orchestrator/open-work.js';
import { linearIssueConversationKey } from '../../orchestrator/work-announcer.js';
import { operationUrl } from '../../platform/dashboard-url.js';
import type { Store } from '../../store/store.js';
import {
  editDiscordDeferredReply,
  postDiscordMessage,
  startDiscordThreadFromMessage,
} from './discord-api.js';
import type { DiscordCommandInvocation } from './discord-interaction.js';
import { linearIssueMention } from './discord-links.js';

export interface DiscordDeliveryDeps {
  config: AppConfig;
  store: Store;
  delegateTicket(
    ticket: { identifier: string; linearIssueId?: string },
    ownerLinearUserId?: string,
  ): Promise<Error | undefined>;
  openTicketForRequest(request: {
    teamKey: string;
    text: string;
    repositoryFullName: string;
  }): Promise<{ identifier: string; linearIssueId: string } | Error>;
  listWorkInConversation(conversationKey: string): OpenWork[];
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

// DiscordCommandRefusal is every reason a command names no work; refusalMessage words each.
export type DiscordCommandRefusal =
  | 'no_repository'
  | 'unknown_repository'
  | 'ambiguous_repository'
  | 'ticket_needs_team'
  | 'unreadable_ticket';

// DiscordCommandReading is the work a command names, or the reason it names none.
export type DiscordCommandReading =
  | { refused: DiscordCommandRefusal; repositoryFullName?: string; repositoryId?: string }
  | { repositoryFullName: string; repositoryId: string; linearIssueIdentifier: string };

export interface DiscordCommandOutcome {
  handled: boolean;
  reason?: string;
}

const NAME_THE_WORK =
  'Name a ticket, or ask me inside the thread of the work you want the status of.';

const CANNOT_OPEN_THREAD =
  'I cannot open a thread in this channel; an operator has to give Jardinero access to it.';

const DISCORD_MESSAGE_MAX_LENGTH = 2_000;

// LINEAR_ISSUE_IDENTIFIER matches a Linear identifier alone or at the end of an issue url.
const LINEAR_ISSUE_IDENTIFIER = /(?:^|\/)([a-z][a-z0-9]*-\d+)(?:$|[/?#])/i;

// handleDiscordCommand runs a command and replaces its deferred reply with where to follow
// the work.
export async function handleDiscordCommand(
  deps: DiscordDeliveryDeps,
  invocation: DiscordCommandInvocation,
): Promise<DiscordCommandOutcome> {
  if (invocation.definition.action === 'status') {
    return answerCommand(deps, invocation, statusMessage(deps, invocation), { handled: true });
  }
  if (invocation.definition.action === 'code') {
    return handleCodeCommand(deps, invocation);
  }

  const reading = readDiscordCommand(deps, invocation);
  if ('refused' in reading) {
    return answerCommand(deps, invocation, refusalMessage(reading.refused, invocation), {
      handled: false,
      reason: reading.refused,
    });
  }

  // Open the thread before delegating, so the work announces in it however it comes back.
  const threadId = await conversationThread(deps, invocation, reading.linearIssueIdentifier);
  if (!threadId) {
    return answerCommand(deps, invocation, CANNOT_OPEN_THREAD, {
      handled: false,
      reason: 'thread_not_opened',
    });
  }
  // Create the request already resolved: it names its ticket, so the router has nothing to do.
  const ask = deps.store.createRequest({
    requestSource: 'discord',
    requestText: invocation.options.ticket,
    requesterExternalId: invocation.discordUserId,
    replyTargetType: 'discord_thread',
    replyTargetId: threadId,
    repositoryId: reading.repositoryId,
    subjectType: 'linear_issue',
    subjectExternalId: reading.linearIssueIdentifier,
  });

  const delegationError = await deps.delegateTicket(
    { identifier: reading.linearIssueIdentifier },
    ownerOf(deps, invocation).ownerLinearUserId,
  );
  if (delegationError) {
    // Give up on the ask, or the next delegation of this ticket would answer it.
    deps.store.setRequestState(ask.id, 'rr_unresolvable', {
      resolutionNote: delegationError.message,
    });
    return answerCommand(
      deps,
      invocation,
      `${linearIssueMention(deps.config, reading.linearIssueIdentifier)} could not be started: ${delegationError.message}.`,
      {
        handled: false,
        reason: delegationError.message,
      },
    );
  }

  return answerCommand(
    deps,
    invocation,
    `Received ${linearIssueMention(deps.config, reading.linearIssueIdentifier)}. Follow it in <#${threadId}>.`,
    { handled: true },
  );
}

// handleCodeCommand opens a Linear ticket for the request and a thread for it, then
// delegates the ticket.
async function handleCodeCommand(
  deps: DiscordDeliveryDeps,
  invocation: DiscordCommandInvocation,
): Promise<DiscordCommandOutcome> {
  const repository = readRepository(deps, invocation);
  if ('refused' in repository) {
    return answerCommand(deps, invocation, refusalMessage(repository.refused, invocation), {
      handled: false,
      reason: repository.refused,
    });
  }
  // Refuse unless exactly one Linear team is routed to the repository to open the ticket in.
  const teamKeys = linearTeamKeysForRepository(deps.config, repository.repositoryFullName);
  if (teamKeys.length !== 1) {
    return answerCommand(deps, invocation, refusalMessage('ticket_needs_team', invocation), {
      handled: false,
      reason: 'ticket_needs_team',
    });
  }

  const text = invocation.options.request ?? '';
  const opened = await deps.openTicketForRequest({
    teamKey: teamKeys[0],
    text,
    repositoryFullName: repository.repositoryFullName,
  });
  if (opened instanceof Error) {
    return answerCommand(deps, invocation, `That could not be started: ${opened.message}.`, {
      handled: false,
      reason: opened.message,
    });
  }

  // Name the ticket in every answer from here on, so nobody asks again and opens a second one.
  const threadId = await conversationThread(deps, invocation, opened.identifier);
  const ask = deps.store.createRequest({
    requestSource: 'discord',
    requestText: text,
    requesterExternalId: invocation.discordUserId,
    ...(threadId ? { replyTargetType: 'discord_thread' as const, replyTargetId: threadId } : {}),
    repositoryId: repository.repositoryId,
    subjectType: 'linear_issue',
    subjectExternalId: opened.identifier,
  });

  const delegationError = await deps.delegateTicket(
    opened,
    ownerOf(deps, invocation).ownerLinearUserId,
  );
  if (delegationError) {
    deps.store.setRequestState(ask.id, 'rr_unresolvable', {
      resolutionNote: delegationError.message,
    });
    return answerCommand(
      deps,
      invocation,
      `Opened ${linearIssueMention(deps.config, opened.identifier)}, but it could not be started: ${delegationError.message}. Ask for it again with \`/jardinero-ticket ticket:${opened.identifier}\`.`,
      { handled: false, reason: delegationError.message },
    );
  }
  if (!threadId) {
    return answerCommand(deps, invocation, threadlessAnswer(deps, opened.identifier), {
      handled: true,
      reason: 'thread_not_opened',
    });
  }
  return answerCommand(
    deps,
    invocation,
    `Opened ${linearIssueMention(deps.config, opened.identifier)} and started on it. Follow it in <#${threadId}>.`,
    { handled: true },
  );
}

// threadlessAnswer still names the ticket, because the work started without a thread.
function threadlessAnswer(deps: DiscordDeliveryDeps, identifier: string): string {
  return `Opened ${linearIssueMention(deps.config, identifier)} and started on it. ${CANNOT_OPEN_THREAD}`;
}

function ownerOf(
  deps: DiscordDeliveryDeps,
  invocation: DiscordCommandInvocation,
): { ownerLinearUserId?: string } {
  const linearUserId = personForDiscordUserId(deps.config, invocation.discordUserId)?.linearUserId;
  return linearUserId ? { ownerLinearUserId: linearUserId } : {};
}

// statusMessage answers about the ticket the command names, or the work of the thread it
// was asked in.
function statusMessage(deps: DiscordDeliveryDeps, invocation: DiscordCommandInvocation): string {
  if (invocation.options.ticket) {
    const identifier = linearIssueIdentifierOf(invocation.options.ticket);
    if (!identifier) return refusalMessage('unreadable_ticket', invocation);
    const work = deps.listWorkInConversation(linearIssueConversationKey(identifier));
    return work.length === 0 ? `I have nothing on \`${identifier}\`.` : workLines(deps, work);
  }
  const conversation = deps.store.findDiscordConversationByThread(invocation.channelId);
  if (!conversation) return NAME_THE_WORK;
  const work = deps.listWorkInConversation(conversation.conversationKey);
  return work.length === 0 ? NAME_THE_WORK : workLines(deps, work);
}

// workLines answers one line per open work, with its dashboard link when there is one.
function workLines(deps: DiscordDeliveryDeps, work: OpenWork[]): string {
  return work
    .map((one) => {
      const url = operationUrl(deps.config.server.publicUrl, one.workflowInstanceId);
      const line = `${one.name} is ${one.happening}`;
      return url ? `- ${line} — [watch](${url})` : `- ${line}`;
    })
    .join('\n');
}

// conversationThread answers the ticket's thread, opening one if needed. A Discord refusal
// is recorded and answers undefined, so the caller can still reply.
async function conversationThread(
  deps: DiscordDeliveryDeps,
  invocation: DiscordCommandInvocation,
  linearIssueIdentifier: string,
): Promise<string | undefined> {
  const conversationKey = linearIssueConversationKey(linearIssueIdentifier);
  const known = deps.store.findDiscordConversation(conversationKey)?.threadId;
  if (known) return known;
  try {
    const threadId = await openDiscordThread(deps, invocation, linearIssueIdentifier);
    deps.store.saveDiscordConversation({ conversationKey, threadId });
    return threadId;
  } catch (error) {
    deps.store.appendEvent({
      eventType: 'orchestrator.discord_thread_not_opened',
      metadata: {
        channel_id: invocation.channelId,
        linear_issue_identifier: linearIssueIdentifier,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return undefined;
  }
}

// readDiscordCommand resolves the repository and the ticket a command names.
export function readDiscordCommand(
  deps: DiscordDeliveryDeps,
  invocation: DiscordCommandInvocation,
): DiscordCommandReading {
  const repository = readRepository(deps, invocation);
  if ('refused' in repository) return repository;

  return readTicket(
    deps,
    repository.repositoryFullName,
    repository.repositoryId,
    invocation.options.ticket,
  );
}

function readRepository(
  deps: DiscordDeliveryDeps,
  invocation: DiscordCommandInvocation,
): { repositoryFullName: string; repositoryId: string } | { refused: DiscordCommandRefusal } {
  const named = inferRepository(deps, invocation);
  if (!named) return { refused: 'no_repository' };

  // Resolve a name without an owner against the known repositories instead of guessing one.
  const repositories = named.includes('/')
    ? [deps.store.findRepositoryByFullName(named)].filter((found) => found !== undefined)
    : deps.store.findRepositoriesNamed(named);
  const repository = repositories.at(0);
  if (!repository) return { repositoryFullName: named, refused: 'unknown_repository' };
  if (repositories.length > 1) {
    return { repositoryFullName: named, refused: 'ambiguous_repository' };
  }
  return { repositoryFullName: repository.fullName, repositoryId: repository.id };
}

// inferRepository answers the repository a command is about: the one it names, then the
// ticket's team's, then the channel's.
export function inferRepository(
  deps: DiscordDeliveryDeps,
  invocation: DiscordCommandInvocation,
): string | undefined {
  const teamKey = linearTeamKeyOf(invocation.options.ticket);
  return (
    invocation.options.repo ??
    (teamKey ? repositoryForLinearTeamKey(deps.config, teamKey) : undefined) ??
    // Use the channel's first configured repository as its default.
    repositoriesForDiscordChannel(deps.config, invocation.channelId).at(0)
  );
}

// readTicket resolves the Linear identifier a command names; a bare number takes the team
// routed to the repository.
function readTicket(
  deps: DiscordDeliveryDeps,
  repositoryFullName: string,
  repositoryId: string,
  ticket: string | undefined,
): DiscordCommandReading {
  const identifier = linearIssueIdentifierOf(ticket);
  if (identifier) return { repositoryFullName, repositoryId, linearIssueIdentifier: identifier };

  const number = ticket?.trim() ?? '';
  if (!/^\d+$/.test(number)) {
    return { repositoryFullName, repositoryId, refused: 'unreadable_ticket' };
  }
  const teamKeys = linearTeamKeysForRepository(deps.config, repositoryFullName);
  if (teamKeys.length !== 1) {
    return { repositoryFullName, repositoryId, refused: 'ticket_needs_team' };
  }
  return {
    repositoryFullName,
    repositoryId,
    linearIssueIdentifier: `${teamKeys[0].toUpperCase()}-${number}`,
  };
}

// openDiscordThread posts a message in the channel and opens the work's thread off it.
async function openDiscordThread(
  deps: DiscordDeliveryDeps,
  invocation: DiscordCommandInvocation,
  linearIssueIdentifier: string,
): Promise<string> {
  const botToken = discordBotToken(deps);
  const starter = await postDiscordMessage({
    botToken,
    fetchImpl: deps.fetchImpl,
    channelId: invocation.channelId,
    // Name the person without pinging them: they are already reading the reply.
    message: { content: threadStarter(deps, invocation, linearIssueIdentifier) },
  });
  return startDiscordThreadFromMessage({
    botToken,
    fetchImpl: deps.fetchImpl,
    channelId: starter.channelId,
    messageId: starter.messageId,
    threadName: linearIssueIdentifier,
  });
}

// threadStarter names who asked for the ticket and quotes the `/jardinero-code` request, cut
// to fit in one Discord message.
function threadStarter(
  deps: DiscordDeliveryDeps,
  invocation: DiscordCommandInvocation,
  linearIssueIdentifier: string,
): string {
  const asked = `<@${invocation.discordUserId}> asked Jardinero to implement ${linearIssueMention(deps.config, linearIssueIdentifier)}`;
  const request = invocation.options.request?.trim();
  if (!request) return asked;
  const quoting = `${asked}\n>>> `;
  const room = DISCORD_MESSAGE_MAX_LENGTH - quoting.length;
  if (request.length <= room) return quoting + request;
  // Cut before a surrogate pair rather than through it, so the message stays valid UTF-16.
  const end = /[\uD800-\uDBFF]/.test(request[room - 2] ?? '') ? room - 2 : room - 1;
  return `${quoting}${request.slice(0, end)}…`;
}

// answerCommand replaces the deferred reply's placeholder. A failed reply is recorded and the
// outcome kept.
async function answerCommand(
  deps: DiscordDeliveryDeps,
  invocation: DiscordCommandInvocation,
  content: string,
  outcome: DiscordCommandOutcome,
): Promise<DiscordCommandOutcome> {
  try {
    await editDiscordDeferredReply({
      applicationId: discordApplicationId(deps),
      interactionToken: invocation.interactionToken,
      message: { content },
      fetchImpl: deps.fetchImpl,
    });
  } catch (error) {
    deps.store.appendEvent({
      eventType: 'orchestrator.discord_reply_failed',
      metadata: {
        interaction_id: invocation.interactionId,
        command_name: invocation.definition.name,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
  return outcome;
}

function refusalMessage(
  refusal: DiscordCommandRefusal,
  invocation: DiscordCommandInvocation,
): string {
  switch (refusal) {
    case 'no_repository':
      return 'Nothing says which repository this is about; name one with `repo`.';
    case 'unknown_repository':
      return 'That repository is not one Jardinero works on.';
    case 'ambiguous_repository':
      return 'More than one repository is named that; write it as `owner/repo`.';
    case 'ticket_needs_team':
      return 'Nothing says which Linear team numbers that repository; write the whole identifier, such as `SYS-1191`.';
    case 'unreadable_ticket':
      return `\`${invocation.options.ticket ?? ''}\` is not a Linear identifier, such as \`JAR-58\`.`;
  }
}

function linearIssueIdentifierOf(ticket: string | undefined): string | undefined {
  const matched = ticket ? LINEAR_ISSUE_IDENTIFIER.exec(ticket.trim()) : null;
  return matched ? matched[1].toUpperCase() : undefined;
}

function linearTeamKeyOf(ticket: string | undefined): string | undefined {
  const identifier = linearIssueIdentifierOf(ticket);
  return identifier?.slice(0, identifier.indexOf('-'));
}

function discordApplicationId(deps: DiscordDeliveryDeps): string {
  return requiredEnv(deps, deps.config.discord.applicationIdEnv);
}

function discordBotToken(deps: DiscordDeliveryDeps): string {
  return requiredEnv(deps, deps.config.discord.botTokenEnv);
}

function requiredEnv(deps: DiscordDeliveryDeps, name: string): string {
  const value = (deps.env ?? process.env)[name];
  if (!value) throw new Error(`Discord is enabled but ${name} is unset`);
  return value;
}
