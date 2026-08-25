import type { AppConfig } from '../../config.js';
import {
  type CreatedLinearIssue,
  createIssue,
  delegateIssue,
  getAppUserId,
  getIssue,
} from './linear-api.js';

export interface LinearDelegationDeps {
  config: AppConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

// delegateLinearIssue hands a ticket to Jardinero in Linear, which is the one way work
// starts: Linear answers the assignment with the delivery that opens the workflow, so
// nothing here has to know what happens next.
export async function delegateLinearIssue(
  deps: LinearDelegationDeps,
  ticket: { identifier: string; linearIssueId?: string },
  ownerLinearUserId?: string,
): Promise<Error | undefined> {
  const token = (deps.env ?? process.env)[deps.config.workflows.linearImplementer.apiTokenEnv];
  if (!token) return new Error('the linear api token is unset');
  const options = { token, fetchImpl: deps.fetchImpl };
  const identifier = ticket.identifier;

  // A ticket we just wrote is not asked for again: Linear answers its own id at once, while
  // the index a lookup by identifier reads takes a moment to see it.
  const issue = ticket.linearIssueId
    ? { linearIssueId: ticket.linearIssueId, assigneeId: undefined, delegateId: undefined }
    : await getIssue({ ...options, identifier });
  if (!issue) return new Error(`${identifier} is not a ticket Linear knows`);
  const appUserId = await getAppUserId(options);
  if (!appUserId) return new Error('linear does not say who we are');

  // Linear opens a session when the ticket is delegated, and delegating what is already
  // delegated is not a delegation, so a ticket that is already ours is handed back first.
  if (issue.delegateId === appUserId) {
    const cleared = await delegateIssue({
      ...options,
      issueId: issue.linearIssueId,
      delegateId: null,
    });
    if (!cleared) return new Error(`linear refused to hand ${identifier} back before delegating`);
  }
  const delegated = await delegateIssue({
    ...options,
    issueId: issue.linearIssueId,
    delegateId: appUserId,
    ...(!issue.assigneeId && ownerLinearUserId ? { assigneeId: ownerLinearUserId } : {}),
  });
  return delegated ? undefined : new Error(`linear refused to delegate ${identifier}`);
}

// openLinearIssueForRequest writes the ticket somebody asked for in their own words, and
// answers what it is called. Delegating it is the caller's next step, the same one it takes
// for a ticket somebody wrote by hand.
export async function openLinearIssueForRequest(
  deps: LinearDelegationDeps,
  request: { teamKey: string; text: string },
): Promise<CreatedLinearIssue | Error> {
  const token = (deps.env ?? process.env)[deps.config.workflows.linearImplementer.apiTokenEnv];
  if (!token) return new Error('the linear api token is unset');

  const created = await createIssue({
    token,
    fetchImpl: deps.fetchImpl,
    teamKey: request.teamKey,
    title: titleOf(request.text),
    description: request.text,
  });
  if (!created) return new Error(`linear refused to open a ticket in ${request.teamKey}`);
  return created;
}

// A ticket needs a title and the person wrote prose, so the first line is it; the whole text
// is the description either way.
function titleOf(text: string): string {
  const firstLine = text.trim().split('\n')[0].trim();
  return firstLine.length > TITLE_LIMIT ? `${firstLine.slice(0, TITLE_LIMIT - 1)}…` : firstLine;
}

const TITLE_LIMIT = 120;
