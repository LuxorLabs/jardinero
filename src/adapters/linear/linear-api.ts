// Minimal Linear GraphQL client for the agent-session surface: acknowledgment and outcome
// activities. Mirrors the hand-rolled fetch style of github-reactions.ts; callers treat
// failures as non-fatal and audit them, so every parse problem here throws with enough
// detail to log.

import { logger } from '../../platform/logger.js';

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

const log = logger.child('linear-api');

// Linear renders each type differently and derives session state from it:
// `response` completes the session, `error` marks it failed, `elicitation`
// flips it to awaiting-input. `thought` is neutral progress.
export interface AgentActivityContent {
  type: 'thought' | 'action' | 'elicitation' | 'response' | 'error';
  body: string;
}

export interface LinearRequestOptions {
  token: string;
  fetchImpl?: typeof fetch;
}

export interface LinearIssueProject {
  id: string;
  name: string;
}

export async function createAgentActivity(
  options: LinearRequestOptions & { sessionId: string; content: AgentActivityContent },
): Promise<void> {
  const data = await linearGraphql(
    options,
    `mutation CreateAgentActivity($input: AgentActivityCreateInput!) {
      agentActivityCreate(input: $input) { success }
    }`,
    { input: { agentSessionId: options.sessionId, content: options.content } },
  );
  assertMutationSuccess(data, 'agentActivityCreate');
}

export async function getIssueProject(
  options: LinearRequestOptions & { issueId: string },
): Promise<LinearIssueProject | undefined> {
  const data = await linearGraphql(
    options,
    `query IssueProject($id: String!) {
      issue(id: $id) { project { id name } }
    }`,
    { id: options.issueId },
  );
  const issue = data.issue;
  const project = isPlainObject(issue) ? issue.project : undefined;
  if (
    isPlainObject(project) &&
    typeof project.id === 'string' &&
    typeof project.name === 'string'
  ) {
    return { id: project.id, name: project.name };
  }
  log.error('linear answered with no project we could read', {
    linear_issue_id: options.issueId,
    answer: truncate(JSON.stringify(data)),
  });
  return undefined;
}

export interface LinearIssueContext {
  linearIssueId: string;
  title: string;
  description?: string;
  assigneeId?: string;
  delegateId?: string;
}

// getIssue reads the ticket an identifier such as SYS-1191 names: its own id, the text a
// person wrote, and who it is delegated to. Looked up by team key and number, which is what
// the identifier is made of.
export async function getIssue(
  options: LinearRequestOptions & { identifier: string },
): Promise<LinearIssueContext | undefined> {
  const dash = options.identifier.lastIndexOf('-');
  const teamKey = dash > 0 ? options.identifier.slice(0, dash).toUpperCase() : '';
  const number = Number(dash > 0 ? options.identifier.slice(dash + 1) : Number.NaN);
  if (!teamKey || !Number.isSafeInteger(number)) return undefined;

  const data = await linearGraphql(
    options,
    `query IssueByIdentifier($teamKey: String!, $number: Float!) {
      issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 1) {
        nodes { id title description assignee { id } delegate { id } }
      }
    }`,
    { teamKey, number },
  );
  const issues = isPlainObject(data.issues) ? data.issues.nodes : undefined;
  const node = Array.isArray(issues) ? issues[0] : undefined;
  if (!isPlainObject(node) || typeof node.id !== 'string' || typeof node.title !== 'string') {
    log.error('linear answered with no ticket we could read', {
      linear_issue_identifier: options.identifier,
      answer: truncate(JSON.stringify(data)),
    });
    return undefined;
  }
  const assignee = isPlainObject(node.assignee) ? node.assignee.id : undefined;
  const delegate = isPlainObject(node.delegate) ? node.delegate.id : undefined;
  return {
    linearIssueId: node.id,
    title: node.title,
    ...(typeof node.description === 'string' && node.description.trim().length > 0
      ? { description: node.description }
      : {}),
    ...(typeof assignee === 'string' ? { assigneeId: assignee } : {}),
    ...(typeof delegate === 'string' ? { delegateId: delegate } : {}),
  };
}

export interface CreatedLinearIssue {
  linearIssueId: string;
  identifier: string;
}

// createIssue writes a ticket for work somebody asked for in their own words, in the team
// whose work lands in that repository. Delegating it is a separate step, because Linear only
// opens a session for a delegation that changes.
export async function createIssue(
  options: LinearRequestOptions & {
    teamKey: string;
    title: string;
    description: string;
  },
): Promise<CreatedLinearIssue | undefined> {
  const teamId = await teamIdOf(options);
  if (!teamId) return undefined;

  const data = await linearGraphql(
    options,
    `mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { id identifier } }
    }`,
    { input: { teamId, title: options.title, description: options.description } },
  );
  const created = isPlainObject(data.issueCreate) ? data.issueCreate : undefined;
  const issue = isPlainObject(created?.issue) ? created.issue : undefined;
  if (created?.success !== true || typeof issue?.id !== 'string') {
    log.error('linear did not create the ticket we asked for', {
      team_key: options.teamKey,
      answer: truncate(JSON.stringify(data)),
    });
    return undefined;
  }
  return { linearIssueId: issue.id, identifier: String(issue.identifier ?? '') };
}

// A ticket is created against the team's own id, and the prefix a person writes is all we
// have to find it by.
async function teamIdOf(
  options: LinearRequestOptions & { teamKey: string },
): Promise<string | undefined> {
  const data = await linearGraphql(
    options,
    `query TeamByKey($key: String!) {
      teams(filter: { key: { eq: $key } }, first: 1) { nodes { id } }
    }`,
    { key: options.teamKey.toUpperCase() },
  );
  const teams = isPlainObject(data.teams) ? data.teams.nodes : undefined;
  const team = Array.isArray(teams) ? teams[0] : undefined;
  const teamId = isPlainObject(team) ? team.id : undefined;
  if (typeof teamId !== 'string') {
    log.error('linear knows no team by that key', {
      team_key: options.teamKey,
      answer: truncate(JSON.stringify(data)),
    });
    return undefined;
  }
  return teamId;
}

// getAppUserId answers who we are in Linear, which an `actor=app` token makes the agent
// itself. It is the id a ticket is delegated to in order to hand it to us.
export async function getAppUserId(options: LinearRequestOptions): Promise<string | undefined> {
  const data = await linearGraphql(options, 'query Viewer { viewer { id } }', {});
  const viewer = isPlainObject(data.viewer) ? data.viewer.id : undefined;
  if (typeof viewer !== 'string') {
    log.error('linear did not say who we are', { answer: truncate(JSON.stringify(data)) });
    return undefined;
  }
  return viewer;
}

// delegateIssue hands a ticket to an agent, or to nobody when `delegateId` is null. The
// owner is a different field: a person keeps the ticket while the agent acts on it.
export async function delegateIssue(
  options: LinearRequestOptions & {
    issueId: string;
    delegateId: string | null;
    assigneeId?: string;
  },
): Promise<boolean> {
  const data = await linearGraphql(
    options,
    `mutation DelegateIssue($id: String!, $delegateId: String, $assigneeId: String) {
      issueUpdate(id: $id, input: { delegateId: $delegateId, assigneeId: $assigneeId })
        { success }
    }`,
    // A variable left out is a field left alone; sending it as null would take the ticket
    // away from whoever owns it.
    {
      id: options.issueId,
      delegateId: options.delegateId,
      ...(options.assigneeId ? { assigneeId: options.assigneeId } : {}),
    },
  );
  const updated = isPlainObject(data.issueUpdate) ? data.issueUpdate.success : undefined;
  if (updated !== true) {
    log.error('linear refused to delegate the ticket', {
      linear_issue_id: options.issueId,
      delegate_id: options.delegateId ?? '',
      answer: truncate(JSON.stringify(data)),
    });
    return false;
  }
  return true;
}

async function linearGraphql(
  options: LinearRequestOptions,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Linear GraphQL request failed: ${response.status} ${truncate(text)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Linear GraphQL returned invalid JSON: ${truncate(text)}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error('Linear GraphQL returned a non-object response');
  }
  const errors = parsed.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`Linear GraphQL errors: ${truncate(JSON.stringify(errors))}`);
  }
  const data = parsed.data;
  if (!isPlainObject(data)) {
    throw new Error('Linear GraphQL response is missing data');
  }
  return data;
}

function assertMutationSuccess(data: Record<string, unknown>, mutation: string): void {
  const result = data[mutation];
  if (!isPlainObject(result) || result.success !== true) {
    throw new Error(`Linear ${mutation} did not report success`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(text: string): string {
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}
