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

export interface DiscordAnnouncerDeps {
  config: AppConfig;
  store: Store;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

const log = logger.child('discord-announce');

// The conversations being opened right now, so two moments about one piece of work do not
// each open a thread.
type DiscordAnnouncer = DiscordAnnouncerDeps & { opening: Map<string, Promise<string>> };

// createDiscordWorkAnnouncer builds the port the machines announce through. A failure is
// recorded and dropped, because the moment it reports already happened.
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

  return {
    ticketImplementationStarted: (work, ticket) =>
      say('ticketImplementationStarted', work, `Writing ${ticket.identifier}.`),
    ticketVerificationStarted: (work, ticket) =>
      say(
        'ticketVerificationStarted',
        work,
        `Verifying what was written for ${ticket.identifier}.`,
      ),
    ticketRejectedByVerifier: (work, ticket) =>
      say(
        'ticketRejectedByVerifier',
        work,
        `Verification turned that pass down, writing ${ticket.identifier} again (attempt ${ticket.attempt}).`,
      ),
    ticketParked: (work, ticket) =>
      say(
        'ticketParked',
        work,
        `${ticket.identifier} needs a person: ${reasonOf(ticket.reason)}.`,
        true,
      ),

    fixParked: (work, fix) =>
      say('fixParked', work, `A fix needs a person: ${reasonOf(fix.reason)}.`, true),

    pullRequestAdopted: (work, pull) =>
      say('pullRequestAdopted', work, `#${pull.number} is ready for review.`),
    pullRequestMaintenanceParked: (work, pull) =>
      say(
        'pullRequestMaintenanceParked',
        work,
        `#${pull.number} needs a person: ${reasonOf(pull.reason)}.`,
        true,
      ),
    pullRequestMerged: (work, pull) =>
      say('pullRequestMerged', work, `#${pull.number} was merged.`),
    pullRequestClosed: (work, pull) =>
      say('pullRequestClosed', work, `#${pull.number} was closed without merging.`),

    requestUnresolvable: (work, request) =>
      say(
        'requestUnresolvable',
        work,
        `That request could not be placed: ${reasonOf(request.questions)}.`,
      ),
  };
}

// The two destinations are independent: a moment that cannot reach the work's thread still
// has to reach the operator, which is the whole point of saying it twice.
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

// sayInTheConversation posts in the work's conversation, opening it on the first thing
// there is to say so the repository channel keeps one line per piece of work instead of a
// running commentary.
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

  // Opening one takes two calls to Discord, and a moment arriving in between would open a
  // second thread nothing is ever announced in, so it waits for this one instead.
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

// openConversation posts the line that opens the conversation in the repository's channel
// and hangs the thread off it, which is what makes that channel one line per piece of work.
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

  // Discord draws the way into a thread as a preview of its last post, so a thread nothing
  // has been said in is invisible in the channel.
  const watching = watchLink(deps, work);
  if (watching) {
    // The moment itself already landed and another may be waiting on this thread, so a link
    // that cannot be posted is dropped rather than failing either of them.
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

// mentionOf names whoever asked, in the identity Discord can ping, so the opening message
// reaches them. A person the config does not know is not named rather than not told.
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

// watchLink is where the pass can be watched, empty when the deployment has no public url
// and there is nowhere to send anybody.
function watchLink(deps: DiscordAnnouncerDeps, work: WorkConversation): string {
  const url = operationUrl(deps.config.server.publicUrl, work.workflowInstanceId);
  return url ? `Follow it [here](${url}).` : '';
}

// A reason is text, not markup: Discord renders what we post, so `no_pull_request` would
// come out half italic and a note could carry a link nobody wrote.
function reasonOf(recorded: string | null | undefined): string {
  return (recorded ?? 'no reason was recorded').replace(/[\\`*_~|[\]]/g, '\\$&');
}
