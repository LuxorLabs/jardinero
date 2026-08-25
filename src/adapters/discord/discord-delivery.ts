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

export interface DiscordDeliveryDeps {
  config: AppConfig;
  store: Store;
  // Hands the ticket to Jardinero where tickets live, which is what starts the work: the
  // delivery that comes back is what opens the workflow.
  delegateTicket(
    ticket: { identifier: string; linearIssueId?: string },
    ownerLinearUserId?: string,
  ): Promise<Error | undefined>;
  // Writes the ticket for work asked for in words, and hands that one over the same way.
  openTicketForRequest(request: {
    teamKey: string;
    text: string;
  }): Promise<{ identifier: string; linearIssueId: string } | Error>;
  // What one conversation is about, so a command asked inside a thread answers about the
  // work that thread follows and nothing else.
  listWorkInConversation(conversationKey: string): OpenWork[];
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

// DiscordCommandRefusal is every way a command can fail to name work, and each one is a
// sentence the person reads back.
export type DiscordCommandRefusal =
  | 'no_repository'
  | 'unknown_repository'
  | 'ambiguous_repository'
  | 'ticket_needs_team'
  | 'unreadable_ticket';

// DiscordCommandReading is what the command turned out to ask for: either the work it
// names, whole, or the reason it names none.
export type DiscordCommandReading =
  | { refused: DiscordCommandRefusal; repositoryFullName?: string; repositoryId?: string }
  | { repositoryFullName: string; repositoryId: string; linearIssueIdentifier: string };

export interface DiscordCommandOutcome {
  handled: boolean;
  reason?: string;
}

const NAME_THE_WORK =
  'Name a ticket, or ask me inside the thread of the work you want the status of.';

// Discord refuses what the bot has no access to, and the person is left watching the
// acknowledgement forever unless we answer it.
const CANNOT_OPEN_THREAD =
  'I cannot open a thread in this channel; an operator has to give Jardinero access to it.';

// A Linear identifier as a person writes it, on its own or at the end of an issue url.
const LINEAR_ISSUE_IDENTIFIER = /(?:^|\/)([a-z][a-z0-9]*-\d+)(?:$|[/?#])/i;

// handleDiscordCommand opens the work a command asks for and answers where the person can
// follow it. What each command is about is its action: work to write, a ticket that already
// exists, or what is going on with the work of the thread it was asked in.
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

  // The thread is the ticket's conversation from here on, whichever door the work comes
  // back through, so it is written down before the ticket is handed over. A ticket already
  // talked about keeps its thread: a second one is where nothing would be announced.
  const threadId = await conversationThread(deps, invocation, reading.linearIssueIdentifier);
  if (!threadId) {
    return answerCommand(deps, invocation, CANNOT_OPEN_THREAD, {
      handled: false,
      reason: 'thread_not_opened',
    });
  }
  // The request carries its subject, so it is born resolved: the router has nothing to
  // decide, and the delivery Linear sends back is what puts the ticket to work.
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
    // The ticket never started, so the ask is given up on rather than left for whoever
    // delegates that ticket next to answer by accident.
    deps.store.setRequestState(ask.id, 'rr_unresolvable', {
      resolutionNote: delegationError.message,
    });
    return answerCommand(
      deps,
      invocation,
      `${reading.linearIssueIdentifier} could not be started: ${delegationError.message}.`,
      {
        handled: false,
        reason: delegationError.message,
      },
    );
  }

  return answerCommand(
    deps,
    invocation,
    `Received ${reading.linearIssueIdentifier}. Follow it in <#${threadId}>.`,
    { handled: true },
  );
}

// handleCodeCommand turns words into a ticket and hands it over, which is the one way work
// starts. The thread is opened first and filed under the ticket the moment it has one, so
// everything said about it lands where it was asked for.
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
  // A ticket is written in a team, and the repository is what says which one numbers it.
  const teamKeys = linearTeamKeysForRepository(deps.config, repository.repositoryFullName);
  if (teamKeys.length !== 1) {
    return answerCommand(deps, invocation, refusalMessage('ticket_needs_team', invocation), {
      handled: false,
      reason: 'ticket_needs_team',
    });
  }

  const text = invocation.options.request ?? '';
  const opened = await deps.openTicketForRequest({ teamKey: teamKeys[0], text });
  if (opened instanceof Error) {
    return answerCommand(deps, invocation, `That could not be started: ${opened.message}.`, {
      handled: false,
      reason: opened.message,
    });
  }

  // The ticket exists from here on, so everything after says what it is called: asking again
  // for the same thing would write a second one.
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
      `Opened ${opened.identifier}, but it could not be started: ${delegationError.message}. Ask for it again with \`/jardinero-ticket ticket:${opened.identifier}\`.`,
      { handled: false, reason: delegationError.message },
    );
  }
  if (!threadId) {
    return answerCommand(deps, invocation, threadlessAnswer(opened.identifier), {
      handled: true,
      reason: 'thread_not_opened',
    });
  }
  return answerCommand(
    deps,
    invocation,
    `Opened ${opened.identifier} and started on it. Follow it in <#${threadId}>.`,
    { handled: true },
  );
}

// The ticket exists and is being worked on, so the thread that could not be opened is worth
// less than the identifier the person now has.
function threadlessAnswer(identifier: string): string {
  return `Opened ${identifier} and started on it. ${CANNOT_OPEN_THREAD}`;
}

function ownerOf(
  deps: DiscordDeliveryDeps,
  invocation: DiscordCommandInvocation,
): { ownerLinearUserId?: string } {
  const linearUserId = personForDiscordUserId(deps.config, invocation.discordUserId)?.linearUserId;
  return linearUserId ? { ownerLinearUserId: linearUserId } : {};
}

// statusMessage answers about the ticket the command names, or the work the thread it was
// asked in follows. Asked with neither, saying so is better than reporting on everything.
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

// One line per piece of work, each saying where it can be watched.
function workLines(deps: DiscordDeliveryDeps, work: OpenWork[]): string {
  return work
    .map((one) => {
      const url = operationUrl(deps.config.server.publicUrl, one.workflowInstanceId);
      const line = `${one.name} is ${one.happening}`;
      return url ? `- ${line} — [watch](${url})` : `- ${line}`;
    })
    .join('\n');
}

// conversationThread answers the thread the ticket is talked about in, opening one when it
// has none. Nothing when Discord refuses, which is recorded and answered rather than thrown:
// the person is waiting on an acknowledgement that only this call can replace.
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

// readDiscordCommand resolves the repository the command works on and the subject it
// names, both from the interaction alone.
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

// readRepository resolves which repository a command works on, whatever it asks for.
function readRepository(
  deps: DiscordDeliveryDeps,
  invocation: DiscordCommandInvocation,
): { repositoryFullName: string; repositoryId: string } | { refused: DiscordCommandRefusal } {
  const named = inferRepository(deps, invocation);
  if (!named) return { refused: 'no_repository' };

  // Written without an owner, the name is resolved against the repositories we work in
  // rather than prefixed with a guess.
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

// inferRepository answers which repository a command is about: the one it names, the one
// the ticket's team works in, or the channel's own. A ticket says what the work is, while
// the channel is only where it was typed, so the channel is the last word.
export function inferRepository(
  deps: DiscordDeliveryDeps,
  invocation: DiscordCommandInvocation,
): string | undefined {
  const teamKey = linearTeamKeyOf(invocation.options.ticket);
  return (
    invocation.options.repo ??
    (teamKey ? repositoryForLinearTeamKey(deps.config, teamKey) : undefined) ??
    // The channel's first repository is its default, which is what the config's order says.
    repositoriesForDiscordChannel(deps.config, invocation.channelId).at(0)
  );
}

// readTicket resolves the Linear identifier a command named. A bare number is the ticket as
// a person says it out loud, and the repository is what says which team numbers it.
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

// openDiscordThread opens the thread the work is followed in, hanging it off a message
// rather than off the command so the channel keeps a line saying who asked for what.
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
    // Named and not pinged: the person who ran the command is reading their own answer.
    message: {
      content: `<@${invocation.discordUserId}> asked Jardinero to implement ${linearIssueIdentifier}`,
    },
  });
  return startDiscordThreadFromMessage({
    botToken,
    fetchImpl: deps.fetchImpl,
    channelId: starter.channelId,
    messageId: starter.messageId,
    threadName: linearIssueIdentifier,
  });
}

// answerCommand replaces the placeholder Discord left when the command was acknowledged.
// Best effort: an answer that never lands is recorded and does not change what was opened.
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
