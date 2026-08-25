import type { AppConfig } from '../../config.js';
import type { LogReviewer } from '../../store/types.js';

// logReviewerPayload carries the window to scan over, which comes from the
// configuration: changing it changes what every scan looks at.
export function logReviewerPayload(
  instance: LogReviewer,
  repositoryFullName: string,
  config: AppConfig,
): Record<string, unknown> {
  const logReview = config.workflows.logReviewer;
  // Compare lowercased: the store lowercases the name and the config spells it as GitHub does.
  const targets = logReview.repos.filter(
    (target) => target.repo.toLowerCase() === repositoryFullName.toLowerCase(),
  );
  // Match on the namespace: serviceName holds the target's namespace, not a service. A
  // target whose services span namespaces configures none, and the instance stores that as
  // null, so the two ways of saying "no namespace" have to compare equal.
  const target = targets.find(
    (candidate) => (candidate.namespace ?? null) === instance.serviceName,
  );
  return {
    repo: repositoryFullName,
    lookback_min: logReview.lookbackMin,
    dry_run: logReview.dryRun,
    ...optional('service', instance.serviceName),
    ...optional('environment', instance.environmentName),
    ...optional('namespace', target?.namespace ?? null),
    ...optional('cluster', target?.clusters[0] ?? null),
    ...(target && target.clusters.length > 0 ? { clusters: target.clusters } : {}),
    services: target ? target.services : targets.flatMap((candidate) => candidate.services),
    ...(target?.permissionSignals ? { permission_signals: target.permissionSignals } : {}),
  };
}

function optional(key: string, value: string | undefined | null): Record<string, unknown> {
  return value === null || value === undefined ? {} : { [key]: value };
}
