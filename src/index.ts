import './env.js';

import { loadConfig, validateRepoConfig } from './config.js';
import { exposeDashboardOnStartup } from './transport/dashboard/dashboard-exposure.js';
import {
  type GitHubAppTokenRefresher,
  startGitHubAppTokenRefresher,
} from './adapters/github/github-app-token.js';
import { createApiServer } from './transport/server.js';
import {
  type LinearAppTokenRefresher,
  startLinearAppTokenRefresher,
} from './adapters/linear/linear-app-token.js';
import { configureLokiLogSink, flushLokiLogSinkWithDeadline, logger } from './platform/logger.js';
import { registerConfiguredRepositories } from './orchestrator/configured-repositories.js';
import {
  delegateLinearIssue,
  openLinearIssueForRequest,
} from './adapters/linear/linear-delegation.js';
import { createEngineCommands } from './orchestrator/engine-commands.js';
import { GitHubPullRequests } from './orchestrator/github-pull-requests.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { Scheduler } from './orchestrator/scheduler.js';
import { Store } from './store/store.js';
import { createWorkerRunner } from './orchestrator/worker/index.js';
import { createTenkiReaper } from './adapters/tenki/tenki-reaper.js';

const log = logger.child('boot');

const config = loadConfig();
configureLokiLogSink(config.observability.loki);
log.info('configuration loaded', {
  config_path: config.configPath,
  worker_runner: config.worker.runner,
  log_reviewer: config.workflows.logReviewer.enabled,
  pr_maintainer: config.workflows.prMaintainer.enabled,
  fix_implementer: config.workflows.fixImplementer.enabled,
  linear_implementer: config.workflows.linearImplementer.enabled,
  request_router: config.workflows.requestRouter.enabled,
});
// The mock runner does no GitHub operations, so only real (tenki) runs require
// the App token.
let tokenRefresher: GitHubAppTokenRefresher | undefined;
if (config.worker.runner === 'tenki') {
  tokenRefresher = await startGitHubAppTokenRefresher({ config, logger: log });
}
// Linear session write-backs run under any worker runner, so gate the token
// refresher on the workflow, not the runner. A missing/failed mint degrades to
// audited write-back skips rather than crashing an otherwise-healthy orchestrator.
let linearTokenRefresher: LinearAppTokenRefresher | undefined;
if (config.workflows.linearImplementer.enabled) {
  try {
    linearTokenRefresher = await startLinearAppTokenRefresher({ config, logger: log });
  } catch (error) {
    log.error('linear app token mint failed; session write-backs will be skipped', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
const store = new Store(config.store);
store.initializeAfterBoot();
log.info('configured repositories registered', {
  repos: registerConfiguredRepositories(store, config).length,
});

// A gap costs a whole pass to find out about, so it is said at boot and not when a
// delegation arrives.
for (const gap of validateRepoConfig(config)) {
  log.warn('a repository we work in is missing configuration', {
    repository: gap.repositoryFullName,
    missing: gap.missing.join('; '),
  });
}

// Fail fast on fatal errors, matching Node's default behavior, but log the full
// stack first so the cause is visible in the terminal before the supervisor
// restarts the orchestrator. In-flight runs are reconciled on the next boot
// (running -> orphaned) by Store.initializeAfterBoot.
process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  log.error('unhandled promise rejection, exiting', { error: error.stack ?? error.message });
  exitAfterFinalLokiFlush(1);
});
process.on('uncaughtException', (error) => {
  log.error('uncaught exception, exiting', { error: error.stack ?? error.message });
  exitAfterFinalLokiFlush(1);
});

const runner = createWorkerRunner(config);
// The reaper reclaims leaked Tenki sandboxes, so it exists only under the real runner:
// the mock runner creates none.
const reapSandboxesOnce =
  config.worker.runner === 'tenki'
    ? createTenkiReaper(config, process.env, store).reapOnce
    : undefined;
const orchestrator = new Orchestrator({
  config,
  store,
  runner,
  github: new GitHubPullRequests(config, process.env),
});
const commands = createEngineCommands({
  config,
  store,
  engines: orchestrator,
  delegateTicket: (ticket, ownerLinearUserId) =>
    delegateLinearIssue({ config, env: process.env }, ticket, ownerLinearUserId),
  openTicketForRequest: (request) =>
    openLinearIssueForRequest({ config, env: process.env }, request),
  operatedWorkflows: orchestrator.operatedWorkflows,
  pool: orchestrator.pool,
});
const scheduler = new Scheduler(config, {
  store,
  orchestrator,
  commands,
  reapSandboxesOnce,
});
const server = createApiServer({
  config,
  store,
  commands,
});

void orchestrator.start();

server.listen(config.server.port, config.server.host, () => {
  store.appendEvent({
    eventType: 'orchestrator.started',
    metadata: {
      host: config.server.host,
      port: config.server.port,
      worker_runner: config.worker.runner,
    },
  });
  log.info('orchestrator listening', {
    url: `http://${config.server.host}:${config.server.port}`,
  });
  void exposeDashboardOnStartup(config, process.env, store);
});

scheduler.start();

process.on('SIGTERM', (signal) => void shutdown(signal));
process.on('SIGINT', (signal) => void shutdown(signal));

let shutdownStarted = false;
let exiting = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;

  log.info('shutdown signal received, draining', { signal });
  tokenRefresher?.stop();
  linearTokenRefresher?.stop();
  scheduler.stop();
  // Awaited before the store closes: a sandbox still recording how it ended would
  // write into a closed database.
  await orchestrator.stop();
  server.close(() => {
    store.appendEvent({ eventType: 'orchestrator.stopped' });
    exitAfterFinalLokiFlush(0, () => store.close());
  });
}

function exitAfterFinalLokiFlush(exitCode: number, beforeExit?: () => void): void {
  // Guard against re-entry: a second fatal event (e.g. another unhandled
  // rejection while the first is still draining) must not spawn a second
  // flush-then-exit routine racing this one.
  if (exiting) return;
  exiting = true;
  void (async () => {
    try {
      await flushLokiLogSinkWithDeadline();
    } catch {
      // Final Loki delivery is best-effort and must never block process exit.
    } finally {
      try {
        beforeExit?.();
      } finally {
        process.exit(exitCode);
      }
    }
  })();
}
