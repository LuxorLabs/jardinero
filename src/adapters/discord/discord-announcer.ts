import {
  type AppConfig,
  discordChannelForRepository,
  personForGithubLogin,
  personForLinearUserId,
} from '../../config.js';
import { operationUrl } from '../../platform/dashboard-url.js';
import { logger } from '../../platform/logger.js';
import type { WorkAnnouncer, WorkConversation } from '../../orchestrator/work-announcer.js';
import type { Store } from '../../store/store.js';
import { postDiscordMessage, startDiscordThreadFromMessage } from './discord-api.js';
import { linearIssueMention, pullRequestMention } from './discord-links.js';

export interface DiscordAnnouncerDeps {
  config: AppConfig;
  store: Store;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

const log = logger.child('discord-announce');

// DiscordAnnouncer.opening holds the threads being opened, so concurrent moments share one.
type DiscordAnnouncer = DiscordAnnouncerDeps & { opening: Map<string, Promise<string>> };

// createDiscordWorkAnnouncer builds the WorkAnnouncer port. A failed post is recorded and
// dropped.
export function createDiscordWorkAnnouncer(deps: DiscordAnnouncerDeps): WorkAnnouncer {
  const announcer: DiscordAnnouncer = { ...deps, opening: new Map() };
  const say = (
    moment: string,
    work: WorkConversation,
    content: string,
    alsoAlerts = false,
  ): void => {
    if (!deps.config.discord.enabled) return;
    void post(announcer, work, content, alsoAlerts).catch((error: unknown) => {
      deps.store.appendEvent({
        eventType: 'orchestrator.discord_announce_failed',
        metadata: { moment, error: error instanceof Error ? error.message : String(error) },
      });
    });
  };
  const ticketOf = (identifier: string): string => linearIssueMention(deps.config, identifier);
  const pullOf = (work: WorkConversation, number: number): string =>
    pullRequestMention(deps.store.getRepositoryById(work.repositoryId)?.fullName, number);

  return {
    ticketImplementationStarted: (work, ticket) =>
      say('ticketImplementationStarted', work, `Writing ${ticketOf(ticket.identifier)}.`),
    ticketVerificationStarted: (work, ticket) =>
      say(
        'ticketVerificationStarted',
        work,
        `Verifying what was written for ${ticketOf(ticket.identifier)}.`,
      ),
    ticketRejectedByVerifier: (work, ticket) =>
      say(
        'ticketRejectedByVerifier',
        work,
        `Verification turned that pass down, writing ${ticketOf(ticket.identifier)} again (attempt ${ticket.attempt}).`,
      ),
    ticketParked: (work, ticket) =>
      say(
        'ticketParked',
        work,
        `${ticketOf(ticket.identifier)} needs a person: ${reasonOf(ticket.reason)}.`,
        true,
      ),

    fixParked: (work, fix) =>
      say('fixParked', work, `A fix needs a person: ${reasonOf(fix.reason)}.`, true),

    pullRequestAdopted: (work, pull) =>
      say('pullRequestAdopted', work, `${pullOf(work, pull.number)} is ready for review.`),
    pullRequestMaintenanceParked: (work, pull) =>
      say(
        'pullRequestMaintenanceParked',
        work,
        `${pullOf(work, pull.number)} needs a person: ${reasonOf(pull.reason)}.`,
        true,
      ),
    pullRequestMerged: (work, pull) =>
      say('pullRequestMerged', work, `${pullOf(work, pull.number)} was merged.`),
    pullRequestClosed: (work, pull) =>
      say('pullRequestClosed', work, `${pullOf(work, pull.number)} was closed without merging.`),

    requestUnresolvable: (work, request) =>
      say(
        'requestUnresolvable',
        work,
        `That request could not be placed: ${reasonOf(request.questions)}.`,
      ),
  };
}

// post sends to the work's thread and to alerts independently, so one failing does not stop
// the other.
async function post(
  deps: DiscordAnnouncer,
  work: WorkConversation,
  content: string,
  alsoAlerts: boolean,
): Promise<void> {
  const botToken = (deps.env ?? process.env)[deps.config.discord.botTokenEnv];
  if (!botToken) {
    log.error('a moment could not be announced: the discord bot token is unset', {
      conversation_key: work.key,
    });
    return;
  }
  const alerts = alsoAlerts ? deps.config.discord.alertsChannelId : '';
  const attempts = await Promise.allSettled([
    sayInTheConversation(deps, work, content, botToken),
    alerts
      ? postDiscordMessage({
          botToken,
          fetchImpl: deps.fetchImpl,
          channelId: alerts,
          message: { content },
        })
      : Promise.resolve(),
  ]);
  const failed = attempts.find((attempt) => attempt.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

// sayInTheConversation posts in the work's thread, opening it on the first post.
async function sayInTheConversation(
  deps: DiscordAnnouncer,
  work: WorkConversation,
  content: string,
  botToken: string,
): Promise<void> {
  const known = deps.store.findDiscordConversation(work.key)?.threadId;
  if (known) {
    await postDiscordMessage({
      botToken,
      fetchImpl: deps.fetchImpl,
      channelId: known,
      message: { content },
    });
    return;
  }

  // Wait for a thread already being opened, or this post would open a second one.
  const opening = deps.opening.get(work.key);
  if (opening) {
    await postDiscordMessage({
      botToken,
      fetchImpl: deps.fetchImpl,
      channelId: await opening,
      message: { content },
    });
    return;
  }

  const repository = deps.store.getRepositoryById(work.repositoryId);
  const channelId = repository
    ? discordChannelForRepository(deps.config, repository.fullName)
    : undefined;
  if (!channelId) return;

  const opened = openConversation(deps, work, content, botToken, channelId);
  deps.opening.set(work.key, opened);
  try {
    await opened;
  } finally {
    deps.opening.delete(work.key);
  }
}

// openConversation posts the first message in the repository channel and opens the thread
// off it.
async function openConversation(
  deps: DiscordAnnouncer,
  work: WorkConversation,
  content: string,
  botToken: string,
  channelId: string,
): Promise<string> {
  const opener = await postDiscordMessage({
    botToken,
    fetchImpl: deps.fetchImpl,
    channelId,
    message: { content, ...mentionOf(deps, work) },
  });
  const threadId = await startDiscordThreadFromMessage({
    botToken,
    fetchImpl: deps.fetchImpl,
    channelId: opener.channelId,
    messageId: opener.messageId,
    threadName: work.name,
  });
  deps.store.saveDiscordConversation({ conversationKey: work.key, threadId });

  // Post inside the thread too: Discord does not show a thread with no posts in the channel.
  const watching = watchLink(deps, work);
  if (watching) {
    // Log and drop a failed link: the moment already landed and others may wait on this thread.
    try {
      await postDiscordMessage({
        botToken,
        fetchImpl: deps.fetchImpl,
        channelId: threadId,
        message: { content: watching },
      });
    } catch (error) {
      log.error('the thread opened without saying where the work can be watched', {
        conversation_key: work.key,
        thread_id: threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return threadId;
}

// mentionOf answers the Discord user to ping for whoever asked, or nobody when the config
// does not know them.
function mentionOf(
  deps: DiscordAnnouncer,
  work: WorkConversation,
): { mentionUserIds: string[] } | Record<string, never> {
  const asked = work.askedBy;
  if (!asked) return {};
  const discordUserId =
    asked.source === 'discord'
      ? asked.externalId
      : asked.source === 'linear'
        ? personForLinearUserId(deps.config, asked.externalId)?.discordUserId
        : asked.source === 'github'
          ? personForGithubLogin(deps.config, asked.externalId)?.discordUserId
          : undefined;
  return discordUserId ? { mentionUserIds: [discordUserId] } : {};
}

// watchLink answers the dashboard link for the work, empty when there is no public url.
function watchLink(deps: DiscordAnnouncerDeps, work: WorkConversation): string {
  const url = operationUrl(deps.config.server.publicUrl, work.workflowInstanceId);
  return url ? `Follow it [here](${url}).` : '';
}

// reasonOf escapes markdown in the reason, so Discord shows it as written.
function reasonOf(recorded: string | null | undefined): string {
  return (recorded ?? 'no reason was recorded').replace(/[\\`*_~|[\]]/g, '\\$&');
}
