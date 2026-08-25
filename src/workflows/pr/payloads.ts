import type { AppConfig } from '../../config.js';
import type { FixImplementer, PrMaintainer } from '../../store/types.js';

// prMaintainerPayload carries the pull request and how many times the agent may answer
// one thread; the agent fetches the threads itself.
export function prMaintainerPayload(
  instance: PrMaintainer,
  repositoryFullName: string,
  config: AppConfig,
): Record<string, unknown> {
  return {
    repo: repositoryFullName,
    pr_number: instance.pullRequestNumber,
    max_replies_per_thread: config.workflows.prMaintainer.maxRepliesPerThread,
    attempt: instance.attemptCount,
  };
}

// fixImplementerPayload carries the finding's evidence and the pull request a previous
// pass already opened for it.
export function fixImplementerPayload(
  instance: FixImplementer,
  repositoryFullName: string,
): Record<string, unknown> {
  return {
    repo: repositoryFullName,
    fingerprint: instance.findingFingerprint,
    ...optional('service', instance.serviceName),
    ...optional('environment', instance.environmentName),
    ...optional('implementation_handoff', instance.findingEvidence),
    ...optionalNumber('pr_number', instance.pullRequestNumber),
  };
}

function optionalNumber(key: string, value: number | null): Record<string, unknown> {
  return value === null ? {} : { [key]: value };
}

function optional(key: string, value: string | null): Record<string, unknown> {
  return value === null ? {} : { [key]: value };
}
