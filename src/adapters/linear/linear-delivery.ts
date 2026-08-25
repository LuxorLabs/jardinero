import type { AppConfig, LinearTeamRepoConfig } from '../../config.js';
import type { LinearImplementerStateEngineInterface } from '../../orchestrator/state-machines/linear-implementer/service.js';
import { isFreshLinearWebhookTimestamp } from '../../transport/webhooks/linear-signature.js';
import type { Store } from '../../store/store.js';
import { getIssueProject, type LinearIssueProject } from './linear-api.js';

type JsonObject = Record<string, unknown>;

// LinearReadDeps is what reading a delivery needs; the store answers what an ask already
// named and records what could not be placed.
export interface LinearReadDeps {
  config: AppConfig;
  store: Pick<Store, 'appendEvent' | 'listUnconsumedRequests' | 'getRepositoryById'>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface LinearDeliveryDeps extends LinearReadDeps {
  store: Store;
  linearImplementer: Pick<LinearImplementerStateEngineInterface, 'onIssueAssigned'>;
}

export interface LinearDelivery {
  payload: JsonObject;
  nowMs: number;
}

// LinearDelegation is a person handing us a ticket, with everything the machine
// cannot ask Linear for again.
export interface LinearDelegation {
  repositoryFullName: string;
  linearUserId?: string;
  linearIssueId: string;
  linearIssueIdentifier: string;
  linearSessionId: string;
  promptContext?: string;
}

export interface LinearDeliveryReading {
  delegation?: LinearDelegation;
  // Present whenever the delivery identified an agent session, even for ignored
  // events, so the receiver can still answer the delegating person in Linear.
  sessionId?: string;
  issueIdentifier?: string;
  ignored?: string;
}

// LinearDeliveryOutcome says whether the delivery reached the ticket machine and,
// when it did not, why; the session and the ticket travel back so the receiver can
// answer the person in Linear either way.
export interface LinearDeliveryOutcome {
  handled: boolean;
  reason?: string;
  sessionId?: string;
  issueIdentifier?: string;
}

interface ParsedLinearDelivery {
  input: LinearDelivery;
  payload: JsonObject;
  session: JsonObject;
  issue: JsonObject;
  sessionId: string;
  issueId: string;
  issueIdentifier: string;
  teamKey: string;
  teamRepoConfig: LinearTeamRepoConfig;
}

// The reasons a person delegated and nothing happened. Every other reason is Linear
// talking about sessions nobody asked us about.
const DROPPED_DELEGATIONS = ['no_repo_for_team', 'invalid_issue_identifier', 'missing_issue'];

export async function handleLinearDelivery(
  deps: LinearDeliveryDeps,
  delivery: LinearDelivery,
): Promise<LinearDeliveryOutcome> {
  const read = await readLinearDelivery(deps, delivery);
  const answered = { sessionId: read.sessionId, issueIdentifier: read.issueIdentifier };
  if (!read.delegation) {
    if (read.ignored && DROPPED_DELEGATIONS.includes(read.ignored)) {
      deps.store.appendEvent({
        eventType: 'orchestrator.linear_delegation_dropped',
        metadata: { linear_issue_identifier: read.issueIdentifier ?? '', reason: read.ignored },
      });
    }
    return { handled: false, reason: read.ignored ?? 'event_ignored', ...answered };
  }

  // The installation decides which repositories reach us, so seeing one is enough
  // to register it.
  const repository = deps.store.upsertRepository(read.delegation.repositoryFullName);
  // A ticket delegated from somewhere else is already asked for; delegating it in Linear is
  // how that ask is carried out, so it is that ask the work answers, not a second one.
  const request =
    deps.store
      .listUnconsumedRequests('linear_issue', read.delegation.linearIssueIdentifier)
      .at(0) ??
    deps.store.createRequest({
      requestSource: 'linear',
      requestText: read.delegation.promptContext,
      requesterExternalId: read.delegation.linearUserId,
      replyTargetType: 'linear_session',
      replyTargetId: read.delegation.linearSessionId,
      repositoryId: repository.id,
      subjectType: 'linear_issue',
      subjectExternalId: read.delegation.linearIssueIdentifier,
    });
  const error = await deps.linearImplementer.onIssueAssigned(
    {
      repositoryId: repository.id,
      linearIssueId: read.delegation.linearIssueId,
      linearIssueIdentifier: read.delegation.linearIssueIdentifier,
      linearSessionId: read.delegation.linearSessionId,
      promptContext: read.delegation.promptContext,
    },
    request.id,
  );
  return error
    ? { handled: false, reason: error.message, ...answered }
    : { handled: true, ...answered };
}

// readLinearDelivery reads who was delegated what. Only AgentSessionEvent/created
// is a delegation; everything else comes back with a reason.
export async function readLinearDelivery(
  deps: LinearReadDeps,
  delivery: LinearDelivery,
): Promise<LinearDeliveryReading> {
  const parsed = parseLinearDelivery(deps.config, delivery, (identifier) =>
    repositoryAskedFor(deps, identifier),
  );
  if (!isParsedLinearDelivery(parsed)) return parsed;

  // A repository named in the ticket wins over the team's mapping, and settles it
  // without asking Linear anything.
  const githubRepo = repoFromGithubRefs(parsed.teamRepoConfig, githubReferenceText(parsed));
  if (githubRepo) return delegationFor(parsed, undefined, githubRepo);

  let project = projectFromIssue(parsed.issue);
  if (!project && teamRepoConfiguresProjects(parsed.teamRepoConfig)) {
    project = await issueProject(deps, parsed.issueId);
  }
  return delegationFor(parsed, project);
}

// repositoryAskedFor answers the repository an unanswered ask for this ticket named.
function repositoryAskedFor(deps: LinearReadDeps, identifier: string): string | undefined {
  const repositoryId = deps.store
    .listUnconsumedRequests('linear_issue', identifier)
    .find((ask) => ask.repositoryId)?.repositoryId;
  return repositoryId ? deps.store.getRepositoryById(repositoryId)?.fullName : undefined;
}

// issueProject asks Linear which project the issue belongs to. A failed lookup is
// not a failed delivery, so the reason is recorded and the read goes on without it.
async function issueProject(
  deps: LinearReadDeps,
  issueId: string,
): Promise<LinearIssueProject | undefined> {
  const token = (deps.env ?? process.env)[deps.config.workflows.linearImplementer.apiTokenEnv];
  if (!token) {
    deps.store.appendEvent({
      eventType: 'workflow.linear_project_unknown',
      metadata: { issue_id: issueId, reason: 'missing_api_token' },
    });
    return undefined;
  }
  try {
    return await getIssueProject({ issueId, token, fetchImpl: deps.fetchImpl });
  } catch (error: unknown) {
    deps.store.appendEvent({
      eventType: 'workflow.linear_project_unknown',
      metadata: {
        issue_id: issueId,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return undefined;
  }
}

function isParsedLinearDelivery(
  value: ParsedLinearDelivery | LinearDeliveryReading,
): value is ParsedLinearDelivery {
  return 'teamRepoConfig' in value;
}

function parseLinearDelivery(
  config: AppConfig,
  input: LinearDelivery,
  askedRepository: (linearIssueIdentifier: string) => string | undefined,
): ParsedLinearDelivery | LinearDeliveryReading {
  const payload = input.payload;
  if (payload.type !== 'AgentSessionEvent') return { ignored: 'event_not_supported' };
  if (!config.workflows.linearImplementer.enabled) return { ignored: 'linear_disabled' };
  if (!isFreshLinearWebhookTimestamp(payload.webhookTimestamp, input.nowMs)) {
    return { ignored: 'stale_webhook_timestamp' };
  }

  const session = recordField(payload, 'agentSession');
  const sessionId = stringField(session, 'id');
  if (!sessionId) return { ignored: 'missing_agent_session' };

  const issue = recordField(session, 'issue');
  const issueIdentifier = stringField(issue, 'identifier');

  const action = typeof payload.action === 'string' ? payload.action : '';
  if (action === 'prompted')
    return { sessionId, issueIdentifier, ignored: 'prompted_not_supported' };
  if (action !== 'created') return { sessionId, issueIdentifier, ignored: 'action_not_supported' };

  const issueId = stringField(issue, 'id');
  if (!issueId || !issueIdentifier) return { sessionId, ignored: 'missing_issue' };
  // The identifier and URL are interpolated into agent prompts and branch
  // names, so gate them to Linear's own shapes rather than trusting the
  // delivery blindly; the URL is optional and simply dropped when off-host.
  if (!/^[A-Za-z0-9]+-\d+$/.test(issueIdentifier)) {
    return { sessionId, ignored: 'invalid_issue_identifier' };
  }

  const teamKey =
    stringField(recordField(issue, 'team'), 'key') ?? identifierTeamKey(issueIdentifier);
  // A team that maps to nothing still has an answer when an ask already named a repository.
  const teamRepoConfig = repoConfigForTeam(config, teamKey) ?? askedRepository(issueIdentifier);
  if (!teamRepoConfig) return { sessionId, issueIdentifier, ignored: 'no_repo_for_team' };

  return {
    input,
    payload,
    session,
    issue,
    sessionId,
    issueId,
    issueIdentifier,
    teamKey,
    teamRepoConfig,
  };
}

function delegationFor(
  parsed: ParsedLinearDelivery,
  project: LinearIssueProject | undefined,
  resolvedRepo?: string,
): LinearDeliveryReading {
  const repo =
    resolvedRepo ?? repoForTeamConfig(parsed.teamRepoConfig, githubReferenceText(parsed), project);
  if (!repo) {
    return {
      sessionId: parsed.sessionId,
      issueIdentifier: parsed.issueIdentifier,
      ignored: 'no_repo_for_team',
    };
  }

  return {
    sessionId: parsed.sessionId,
    issueIdentifier: parsed.issueIdentifier,
    delegation: {
      repositoryFullName: repo,
      linearIssueId: parsed.issueId,
      linearIssueIdentifier: parsed.issueIdentifier,
      linearSessionId: parsed.sessionId,
      promptContext: promptContext(parsed.payload, parsed.session),
      linearUserId: delegatedBy(parsed.session),
    },
  };
}

// The delivery carries a pre-formatted promptContext with the issue body,
// comments, and workspace guidance; prefer it over reassembling the pieces.
function promptContext(payload: JsonObject, session: JsonObject | undefined): string | undefined {
  return (
    stringField(payload, 'promptContext') ??
    stringField(session, 'promptContext') ??
    stringField(recordField(session, 'issue'), 'description')
  );
}

// The session records who handed the ticket over, which is the only place the delivery says
// it.
function delegatedBy(session: JsonObject | undefined): string | undefined {
  return (
    stringField(recordField(session, 'creator'), 'id') ??
    stringField(recordField(session, 'appUserActor'), 'id')
  );
}

function identifierTeamKey(identifier: string): string {
  const dash = identifier.indexOf('-');
  return dash > 0 ? identifier.slice(0, dash) : identifier;
}

function repoConfigForTeam(config: AppConfig, teamKey: string): LinearTeamRepoConfig | undefined {
  const normalized = teamKey.trim().toLowerCase();
  if (!normalized) return undefined;
  for (const [key, repoConfig] of Object.entries(config.workflows.linearImplementer.teamRepos)) {
    if (key.trim().toLowerCase() === normalized) return repoConfig;
  }
  return undefined;
}

function repoForTeamConfig(
  repoConfig: LinearTeamRepoConfig,
  text: string,
  project: LinearIssueProject | undefined,
): string | undefined {
  return (
    repoFromGithubRefs(repoConfig, text) ??
    repoFromProject(repoConfig, project) ??
    defaultRepo(repoConfig)
  );
}

function repoFromProject(
  repoConfig: LinearTeamRepoConfig,
  project: LinearIssueProject | undefined,
): string | undefined {
  if (!project || typeof repoConfig === 'string') return undefined;
  const projectId = project.id.trim();
  const projectName = project.name.trim().toLowerCase();
  for (const [key, repo] of Object.entries(repoConfig.projects)) {
    const normalizedKey = key.trim();
    if (
      normalizedKey === projectId ||
      (normalizedKey.length > 0 && normalizedKey.toLowerCase() === projectName)
    ) {
      return repo.trim();
    }
  }
  return undefined;
}

function repoFromGithubRefs(repoConfig: LinearTeamRepoConfig, text: string): string | undefined {
  const configuredRepos = configuredTeamRepos(repoConfig);
  const configuredByKey = new Map(configuredRepos.map((repo) => [repo.toLowerCase(), repo]));
  const matches = new Map<string, string>();
  for (const repo of githubRepoCandidates(text)) {
    const configuredRepo = configuredByKey.get(repo.toLowerCase());
    if (configuredRepo) matches.set(configuredRepo.toLowerCase(), configuredRepo);
  }
  return matches.size === 1 ? [...matches.values()][0] : undefined;
}

function configuredTeamRepos(repoConfig: LinearTeamRepoConfig): string[] {
  const repos =
    typeof repoConfig === 'string'
      ? [repoConfig]
      : [repoConfig.default, ...Object.values(repoConfig.projects), ...repoConfig.repos];
  return [...new Set(repos.map((repo) => repo.trim()).filter((repo) => repo.length > 0))];
}

function defaultRepo(repoConfig: LinearTeamRepoConfig): string | undefined {
  const repo = typeof repoConfig === 'string' ? repoConfig : repoConfig.default;
  return repo.trim() || undefined;
}

function teamRepoConfiguresProjects(repoConfig: LinearTeamRepoConfig): boolean {
  return typeof repoConfig !== 'string' && Object.keys(repoConfig.projects).length > 0;
}

function projectFromIssue(issue: JsonObject): LinearIssueProject | undefined {
  const project = recordField(issue, 'project');
  const id = stringField(project, 'id');
  const name = stringField(project, 'name');
  return id && name ? { id, name } : undefined;
}

function githubReferenceText(parsed: ParsedLinearDelivery): string {
  return [
    stringField(parsed.issue, 'title'),
    stringField(parsed.issue, 'description') ?? promptContext(parsed.payload, parsed.session),
  ]
    .filter((item): item is string => item !== undefined)
    .join('\n');
}

function githubRepoCandidates(text: string): string[] {
  const repos: string[] = [];
  for (const match of text.matchAll(
    /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi,
  )) {
    repos.push(normalizeGithubRepo(`${match[1]}/${match[2]}`));
  }
  for (const match of text.matchAll(/(^|[^\w.-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#\d+\b/g)) {
    repos.push(normalizeGithubRepo(`${match[2]}/${match[3]}`));
  }
  return repos.filter((repo) => repo.includes('/'));
}

function normalizeGithubRepo(repo: string): string {
  return repo.replace(/\.git$/i, '').replace(/[.,;:]+$/g, '');
}

function recordField(value: JsonObject | undefined, key: string): JsonObject | undefined {
  const field = value?.[key];
  return typeof field === 'object' && field !== null && !Array.isArray(field)
    ? (field as JsonObject)
    : undefined;
}

function stringField(value: JsonObject | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === 'string' && field.trim().length > 0 ? field : undefined;
}
