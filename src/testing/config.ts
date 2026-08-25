import { type AppConfig, loadConfig } from '../config.js';

// The one target a test gets when it only needs a repository to exist. A suite whose
// subject is the shape of the fleet declares its own, because there the targets are
// the branch inventory and hiding them makes the cases unreadable.
export const DEMO_LOG_REVIEW_TARGET = {
  repo: 'acme/widgets',
  namespace: 'widgets',
  clusters: ['demo'],
  services: ['api', 'worker'],
};

// The bundled config overrides nothing and names no repository, so anything that
// needs log review on has to say so.
export function configWithLogReview(
  targets: AppConfig['workflows']['logReviewer']['repos'] = [DEMO_LOG_REVIEW_TARGET],
): AppConfig {
  const config = loadConfig();
  config.workflows.prMaintainer.agentLogin = 'acme-jardinero';
  config.workflows.logReviewer.enabled = true;
  config.workflows.logReviewer.repos = targets;
  return config;
}
