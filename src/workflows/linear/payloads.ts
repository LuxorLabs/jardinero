import type { AppConfig } from '../../config.js';
import type { LinearImplementer } from '../../store/types.js';

// linearImplementerPayload carries the pull request to continue and the rejection texts
// the next pass has to answer.
export function linearImplementerPayload(
  instance: LinearImplementer,
  repositoryFullName: string,
): Record<string, unknown> {
  return {
    repo: repositoryFullName,
    fingerprint: `linear.${instance.linearIssueIdentifier}`,
    linear_issue_id: instance.linearIssueId,
    linear_issue_identifier: instance.linearIssueIdentifier,
    draft_pr: true,
    iteration: instance.iterationNumber,
    ...optional('linear_session_id', instance.linearSessionId),
    ...optional('prompt_context', instance.promptContext),
    ...optionalNumber('pr_number', instance.pullRequestNumber),
    ...optionalLines('verifier_issues', instance.verifierIssues),
  };
}

// linearVerifierPayload adds the pull request to judge, the role that selects the
// verifier prompt, and the effort that seat runs at.
export function linearVerifierPayload(
  instance: LinearImplementer,
  repositoryFullName: string,
  config: AppConfig,
): Record<string, unknown> {
  return {
    ...linearImplementerPayload(instance, repositoryFullName),
    role: 'verify',
    effort: config.workflows.linearImplementer.verifyEffort,
  };
}

function optional(key: string, value: string | null): Record<string, unknown> {
  return value === null ? {} : { [key]: value };
}

function optionalNumber(key: string, value: number | null): Record<string, unknown> {
  return value === null ? {} : { [key]: value };
}

// optionalLines splits a stored text into the list the prompt numbers, and omits an
// empty one.
function optionalLines(key: string, value: string | null): Record<string, unknown> {
  const lines = (value ?? '').split('\n').filter((line) => line.trim().length > 0);
  return lines.length === 0 ? {} : { [key]: lines };
}
