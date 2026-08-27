import { setTimeout as delay } from 'node:timers/promises';

import {
  CODEX_EFFORTS,
  clampEffort,
  resolveSeatModel,
  resolveWorkerImage,
  resolveWorkerMaxEffort,
  resolveWorkerResources,
  resolveWorkerSecretEnvs,
  type AppConfig,
  type CodexEffort,
} from '../../config.js';
import { type Logger, logger } from '../../platform/logger.js';
import type {
  WorkerResult,
  WorkerSandboxExecOutput,
  WorkerSandboxExecResult,
  WorkerSandboxProvider,
  WorkerSandboxSession,
} from '../../types.js';
import type { SandboxRunContext, SandboxRunner } from '../sandbox-pool.js';
import { parseFixNoPrOutcome } from '../../workflows/pr/fix-result.js';
import { parseImplementationHandoffs } from '../../workflows/pr/implementation-handoff.js';
import { parseLinearVerification } from '../../workflows/linear/linear-verify.js';
import {
  type LogReviewTelemetryValidation,
  validateLogReviewTelemetryAccess,
} from '../../workflows/log-review/log-review-result.js';
import { CallContextError, withCallContext } from '../../platform/call-context.js';
import { forwardHostCodexAuthToSandbox } from '../../adapters/codex/codex-auth.js';
import { getPullRequestHead } from '../../adapters/github/github-pull-requests.js';
import { buildCodexConfigToml } from '../../adapters/codex/codex-config.js';
import {
  buildGrafanaMcpCredentialsJson,
  grafanaMcpRequiredEnvNames,
} from '../../adapters/grafana/grafana-mcp-auth.js';
import { buildWorkerPrompt } from '../../workflows/prompts.js';
import { OutputTail } from './output-tail.js';
import {
  type RepoDocsAccess,
  type RepoDocsResult,
  ensureRepoDocs,
  renderRepoDocsPromptBlock,
} from './repo-docs.js';
import { extractOpenedPullRequestUrl, verifySideEffects } from '../../workflows/side-effects.js';
import { terminateTenkiSessionInChild } from '../../adapters/tenki/tenki-terminate.js';
import {
  applyTenkiScope,
  buildTenkiClientOptions,
  JARDINERO_SANDBOX_APP,
  resolveTenkiScope,
  SANDBOX_METADATA,
} from '../../adapters/tenki/tenki-scope.js';
import {
  assertExecSucceeded,
  execExitCode,
  execString,
  normalizeRemotePath,
  remoteJoin,
  shellQuote,
} from '../../adapters/tenki/tenki-utils.js';

type TenkiSdk = typeof import('@tenkicloud/sandbox');
type TenkiProviderSession = import('@tenkicloud/sandbox').Session;
type PreCodexRetryStage =
  | 'create'
  | 'wait_ready'
  | 'prepare_workspace'
  | 'docker_socket_access'
  | 'prepare_repo_docs'
  | 'write_context'
  | 'prepare_codex_auth'
  | 'prepare_grafana_mcp'
  | 'verify_log_review_telemetry';

// Human-readable timeline/log line per pre-Codex stage; a stall in the silent
// gap before the Codex run localizes to whichever stage last announced itself.
const PRE_CODEX_STAGE_MESSAGES: Record<PreCodexRetryStage, string> = {
  create: 'Creating sandbox session',
  wait_ready: 'Waiting for sandbox to become ready',
  prepare_workspace: 'Preparing workspace and cloning the repo',
  docker_socket_access: 'Configuring Docker socket access',
  prepare_repo_docs: 'Resolving repo AGENTS.md/CLAUDE.md',
  write_context: 'Writing prompt and task context',
  prepare_codex_auth: 'Preparing Codex auth',
  prepare_grafana_mcp: 'Preparing Grafana MCP credentials',
  verify_log_review_telemetry: 'Verifying log-review telemetry prerequisites',
};

// Seams that production leaves at their defaults; tests inject fakes so the run
// loop can be exercised without a live Tenki sandbox or a child-process close.
export interface SandboxWorkerRunnerDeps {
  loadSdk?: () => Promise<TenkiSdk>;
  terminateSession?: typeof terminateTenkiSessionInChild;
  sandboxReadyRetryDelayMs?: (attempt: number) => number;
  getPullRequestHead?: typeof getPullRequestHead;
  provider?: WorkerSandboxProvider;
}

export type TenkiWorkerRunnerDeps = SandboxWorkerRunnerDeps;

interface CodexRunResult {
  command: string;
  exitCode?: number;
  stdout: string;
  stderr: string;
  lastMessage?: string;
  costUsd: number | null;
  events: unknown[];
  raw: unknown;
}

function sandboxReadyRetryDelayMs(config: AppConfig, attempt: number): number {
  const exponentialBackoffMs =
    config.worker.sandboxReadyBackoffBaseMs * 2 ** Math.max(0, attempt - 1);
  const jitterMs =
    config.worker.sandboxReadyBackoffJitterMs > 0
      ? Math.random() * config.worker.sandboxReadyBackoffJitterMs
      : 0;
  return Math.round(exponentialBackoffMs + jitterMs);
}

export class SandboxWorkerRunner implements SandboxRunner {
  private readonly loadSdk: () => Promise<TenkiSdk>;
  private readonly terminateSession: typeof terminateTenkiSessionInChild;
  private readonly sandboxReadyRetryDelayMs: (attempt: number) => number;
  private readonly getPullRequestHead: typeof getPullRequestHead;
  private readonly provider?: WorkerSandboxProvider;
  private readonly log: Logger = logger.child('worker');

  constructor(
    private readonly config: AppConfig,
    private readonly env = process.env,
    deps: SandboxWorkerRunnerDeps = {},
  ) {
    this.loadSdk = deps.loadSdk ?? loadTenkiSdk;
    this.terminateSession = deps.terminateSession ?? terminateTenkiSessionInChild;
    this.getPullRequestHead = deps.getPullRequestHead ?? getPullRequestHead;
    this.provider = deps.provider;
    this.sandboxReadyRetryDelayMs =
      deps.sandboxReadyRetryDelayMs === undefined
        ? (attempt) => sandboxReadyRetryDelayMs(this.config, attempt)
        : (attempt) => deps.sandboxReadyRetryDelayMs!(attempt);
  }

  async run(context: SandboxRunContext): Promise<WorkerResult> {
    const missing = [this.config.worker.githubTokenEnv];
    if (this.config.worker.codexAuthMode === 'access_token') {
      missing.push(this.config.worker.codexAccessTokenEnv);
    } else if (this.config.worker.codexAuthMode === 'api_key') {
      missing.push(this.config.worker.codexApiKeyEnv);
    }
    if (context.task.workflow === 'log_review' && this.config.mcp.grafana.enabled) {
      missing.push(...grafanaMcpRequiredEnvNames(this.config));
    }
    const missingEnv = missing.filter((name) => !this.env[name]);

    if (missingEnv.length > 0) {
      throw new Error(
        `${this.provider?.name ?? 'Tenki'} runner is missing required environment variables: ${missingEnv.join(', ')}`,
      );
    }

    const createOptions = this.createOptions(context);
    const provider = this.provider ?? (await this.createTenkiProvider(createOptions));
    let session: WorkerSandboxSession | undefined;
    let terminatePromise: Promise<void> | undefined;
    const trackSession = (nextSession: WorkerSandboxSession): void => {
      session = nextSession;
      terminatePromise = undefined;
    };
    const terminate = async (): Promise<void> => {
      if (!session) return;
      if (terminatePromise) return terminatePromise;
      const closingSession = session;
      session = undefined;
      terminatePromise = provider.terminate(closingSession).catch(async (error: unknown) => {
        // Best-effort reporting only: terminate() is fired and forgotten from
        // the abort handler, so a throw here (e.g. an events.jsonl append
        // failing) would otherwise reject the cleanup promise. The orchestrator
        // exits the whole process on any unhandled rejection, so swallow.
        try {
          await context.publishEvent({
            type: 'sandbox.close_failed',
            message: error instanceof Error ? error.message : String(error),
          });
        } catch {
          // Nothing left to do; let the cleanup promise resolve.
        }
      });
      return terminatePromise;
    };

    // Defence in depth around the try/catch above: terminate() is awaited
    // fire-and-forget on abort, so guard the promise so no future rejection can
    // escape as an unhandled rejection and trip the orchestrator's fail-fast
    // process exit.
    const abortHandler = (): void => {
      void terminate().catch(() => undefined);
    };
    context.signal.addEventListener('abort', abortHandler, { once: true });

    try {
      for (let attempt = 1; attempt <= this.config.worker.maxSandboxReadyAttempts; attempt += 1) {
        await context.publishEvent({
          type: 'sandbox.creating',
          message: `Creating ${provider.name} sandbox`,
          data: {
            ...safeEventData(createOptions),
            attempt,
            max_attempts: this.config.worker.maxSandboxReadyAttempts,
          },
        });

        let preCodexStage: PreCodexRetryStage = 'create';
        try {
          throwIfAborted(context.signal);
          // Wrap the two provider API calls most prone to transient TLS/network failures.
          // When these fail, the wrapper attaches step + target so Discord shows
          // which provider could not be reached instead of a low-level transport blob.
          const created = await withCallContext(
            { step: `create ${provider.name} sandbox`, target: provider.apiTarget },
            () => provider.create(createOptions, context.signal),
          );
          trackSession(created);
          preCodexStage = 'wait_ready';
          await withCallContext(
            {
              step: `wait for ${provider.name} sandbox to become ready`,
              target: provider.apiTarget,
            },
            () => provider.waitReady(created, context.signal),
          );
          throwIfAborted(context.signal);

          await context.publishEvent({
            type: 'sandbox.ready',
            message: `${provider.name} sandbox is ready`,
            data: { sandbox_session_id: created.id },
          });

          preCodexStage = await this.beginStage(context, 'prepare_workspace');
          await this.prepareWorkspace(created, context);
          throwIfAborted(context.signal);
          preCodexStage = await this.beginStage(context, 'docker_socket_access');
          await this.ensureDockerSocketAccess(created, context);

          const contextDir = this.contextDir();
          preCodexStage = await this.beginStage(context, 'prepare_repo_docs');
          const repoDocsBlock = await this.prepareRepoDocs(created, context);
          const prompt = buildWorkerPrompt(
            context.sandboxRun.id,
            context.task,
            context.task.promptOverrides,
            repoDocsBlock,
          );
          preCodexStage = await this.beginStage(context, 'write_context');
          await created.writeFile(remoteJoin(contextDir, 'prompt.txt'), prompt);
          await context.writeSandboxRunArtifact('prompt.txt', prompt);
          await created.writeFile(
            remoteJoin(contextDir, 'task.json'),
            JSON.stringify(context.task.payload, null, 2),
          );
          preCodexStage = await this.beginStage(context, 'prepare_codex_auth');
          await this.prepareCodexAuth(created);
          preCodexStage = await this.beginStage(context, 'prepare_grafana_mcp');
          await this.prepareGrafanaMcpCredentials(created, context);
          preCodexStage = await this.beginStage(context, 'verify_log_review_telemetry');
          await this.verifyLogReviewTelemetryPrerequisites(created, context);
          throwIfAborted(context.signal);
          break;
        } catch (error) {
          const retryReason = retryableWorkerSandboxSessionStartReason(error);
          if (
            context.signal.aborted ||
            !retryReason ||
            attempt >= this.config.worker.maxSandboxReadyAttempts
          ) {
            throw error;
          }

          await context.publishEvent({
            type: 'sandbox.create_retried',
            message: `Retrying ${provider.name} sandbox setup after a transient failure`,
            data: {
              run_id: context.sandboxRun.id,
              attempt,
              next_attempt: attempt + 1,
              max_attempts: this.config.worker.maxSandboxReadyAttempts,
              stage: preCodexStage,
              reason: retryReason,
              error: sandboxSessionStartErrorMessage(error),
            },
          });
          await terminate();
          await delay(this.sandboxReadyRetryDelayMs(attempt), undefined, {
            signal: context.signal,
          });
        }
      }
      if (!session) {
        throw new Error(`${provider.name} sandbox was not created.`);
      }
      const sandboxSessionId = session.id;

      const result = await this.runCodex(session, context);
      for (const event of result.events) {
        const type = codexEventType(event);
        // Coarse thread/turn lifecycle events go on the timeline; per-item details
        // are in codex-result.json.
        if (type.startsWith('agent.item.')) continue;
        await context.publishEvent({ type, data: normalizeUnknown(event) });
      }

      await context.publishEvent({
        type: 'agent.finished',
        message: 'Codex run completed',
        data: normalizeUnknown(result),
      });
      if (result.costUsd === null) {
        await context.publishEvent({
          type: 'agent.cost_unknown',
          message: 'Codex CLI output did not include cost data.',
        });
      }

      const codexFailed = typeof result.exitCode === 'number' && result.exitCode !== 0;
      const summary = summarizeResult(result, provider.name);
      const artifact = await context.writeSandboxRunArtifact(
        'codex-result.json',
        JSON.stringify(redactUnknown(result), null, 2),
      );
      const structuredOutputText = finalResponseText(result);
      const noPrParse =
        context.task.workflow === 'fix_implement' && !codexFailed
          ? parseFixNoPrOutcome(structuredOutputText)
          : undefined;
      const openedPrUrlCandidate = noPrParse?.outcome
        ? undefined
        : extractOpenedPullRequestUrl(context.task, result);
      if (noPrParse?.outcome) {
        await context.publishEvent({
          type: 'agent.fix_without_pull_request',
          message: `Fix implementation closed without PR: ${noPrParse.outcome.reason}`,
          data: {
            reason: noPrParse.outcome.reason,
            recommended_followup: noPrParse.outcome.recommendedFollowup,
          },
        });
      } else if (noPrParse?.rejectionReason) {
        await context.publishEvent({
          type: 'agent.fix_without_pull_request_refused',
          message: `Rejected no-PR outcome: ${noPrParse.rejectionReason}`,
          data: {
            reason: noPrParse.rejectionReason,
          },
        });
      }
      const handoffExtraction =
        context.task.workflow === 'log_review' && !codexFailed
          ? parseImplementationHandoffs(structuredOutputText, context.sandboxRun.id, {
              fromAnchorMs: context.sandboxRun.startedAt,
              toAnchorMs: Date.now(),
            })
          : undefined;
      const handoffArtifact = handoffExtraction
        ? await context.writeSandboxRunArtifact(
            'implementation-handoffs.json',
            JSON.stringify(handoffExtraction, null, 2),
          )
        : undefined;
      if (handoffExtraction) {
        await context.publishEvent({
          type: 'agent.implementation_reported',
          message: `Parsed ${handoffExtraction.handoffs.length} implementation handoff(s).`,
          data: {
            handoffs: handoffExtraction.handoffs.length,
            rejections: handoffExtraction.rejections,
            artifact: handoffArtifact,
          },
        });
      }
      // The linear verify seat ends its output with a LINEAR_VERIFY_JSON verdict;
      // parse it here so the coordinator can act on accept/reject. Without this the
      // verdict is never read and every verify run degrades to the transient path.
      const linearVerifyParse =
        context.task.workflow === 'linear' && context.task.payload.role === 'verify' && !codexFailed
          ? parseLinearVerification(structuredOutputText)
          : undefined;
      const linearVerification = linearVerifyParse?.verification;
      const linearVerificationArtifact = linearVerification
        ? await context.writeSandboxRunArtifact(
            'linear-verification.json',
            JSON.stringify(linearVerification, null, 2),
          )
        : undefined;
      if (linearVerifyParse) {
        await context.publishEvent({
          type: linearVerification ? 'linear.verify_parsed' : 'linear.verify_unparsed',
          message: linearVerification
            ? `Parsed linear verification verdict: ${linearVerification.verdict}.`
            : `Linear verification produced no parseable verdict${
                linearVerifyParse.rejectionReason ? `: ${linearVerifyParse.rejectionReason}` : ''
              }.`,
          data: {
            verdict: linearVerification?.verdict,
            issues: linearVerification?.issues?.length,
            rejection_reason: linearVerifyParse.rejectionReason,
          },
        });
      }
      const logReviewTelemetryValidation =
        context.task.workflow === 'log_review' && !codexFailed
          ? validateLogReviewTelemetryAccess(
              handoffExtraction?.structuredOutput,
              handoffExtraction?.rejections,
            )
          : undefined;
      const logReviewFailure =
        logReviewTelemetryValidation && !logReviewTelemetryValidation.ok
          ? logReviewFailureReport(logReviewTelemetryValidation)
          : undefined;
      if (logReviewFailure) {
        await context.publishEvent({
          type: logReviewFailure.type,
          message: logReviewFailure.message,
          data: {
            reason: logReviewTelemetryValidation?.reason,
            detail: logReviewTelemetryValidation?.detail,
          },
        });
      }
      const verification = await verifySideEffects({
        runId: context.sandboxRun.id,
        task: context.task,
        result,
        workerResult: { openedPrUrl: openedPrUrlCandidate, noPrOutcome: noPrParse?.outcome },
        githubToken: this.env[this.config.worker.githubTokenEnv],
      });
      const verificationArtifact = await context.writeSandboxRunArtifact(
        'side-effect-verification.json',
        JSON.stringify(verification, null, 2),
      );
      await terminate();
      const openedPrUrl = verification.openedPrUrl;
      const fixNoPrSkipped =
        context.task.workflow === 'fix_implement' &&
        !codexFailed &&
        !openedPrUrl &&
        Boolean(noPrParse?.outcome) &&
        verification.status !== 'failed';
      const status: WorkerResult['status'] =
        codexFailed || verification.status === 'failed' || logReviewFailure
          ? 'failed'
          : fixNoPrSkipped
            ? 'skipped'
            : 'succeeded';
      const acceptedNoPrOutcome = fixNoPrSkipped ? noPrParse?.outcome : undefined;

      return {
        status,
        costUsd: result.costUsd,
        summary: codexFailed
          ? `${summary} Codex exited with status ${result.exitCode}.`
          : logReviewFailure
            ? `${summary} ${logReviewFailure.message}.`
            : fixNoPrSkipped
              ? `${summary} No PR was opened: ${acceptedNoPrOutcome?.reason}.`
              : verification.status === 'failed'
                ? `${summary} Side-effect verification failed.`
                : summary,
        sandboxSessionId,
        openedPrUrl,
        noPrOutcome: acceptedNoPrOutcome,
        artifacts: {
          codex_result: artifact,
          side_effect_verification: verificationArtifact,
          ...(handoffArtifact ? { implementation_handoffs: handoffArtifact } : {}),
          ...(linearVerificationArtifact
            ? { linear_verification: linearVerificationArtifact }
            : {}),
        },
        implementationHandoffs: handoffExtraction?.handoffs,
        implementationHandoffRejections: handoffExtraction?.rejections,
        linearVerification,
        error: codexFailed
          ? 'codex_exec_failed'
          : logReviewFailure
            ? (logReviewTelemetryValidation?.reason ?? 'log_review_telemetry_unverified')
            : verification.status === 'failed'
              ? 'side_effect_verification_failed'
              : undefined,
      };
    } catch (error) {
      await context.publishEvent({
        type: 'agent.failed',
        message: error instanceof Error ? error.message : String(error),
      });
      await terminate();
      throw error;
    } finally {
      context.signal.removeEventListener('abort', abortHandler);
    }
  }

  private createOptions(context: SandboxRunContext): Record<string, unknown> {
    const env: Record<string, string> = {
      GITHUB_TOKEN: this.env[this.config.worker.githubTokenEnv] ?? '',
      ORCHESTRATOR_RUN_ID: context.sandboxRun.id,
      ORCHESTRATOR_WORKFLOW: context.task.workflow,
    };

    const authorName = this.config.worker.gitAuthorName.trim();
    const authorEmail = this.config.worker.gitAuthorEmail.trim();
    if (authorName && authorEmail) {
      env.GIT_AUTHOR_NAME = authorName;
      env.GIT_AUTHOR_EMAIL = authorEmail;
      env.GIT_COMMITTER_NAME = authorName;
      env.GIT_COMMITTER_EMAIL = authorEmail;
    }

    if (this.config.worker.codexAuthMode === 'access_token') {
      env[this.config.worker.codexAccessTokenEnv] =
        this.env[this.config.worker.codexAccessTokenEnv] ?? '';
    } else if (this.config.worker.codexAuthMode === 'api_key') {
      env[this.config.worker.codexApiKeyEnv] = this.env[this.config.worker.codexApiKeyEnv] ?? '';
    }

    if (context.task.workflow === 'log_review' && this.config.mcp.grafana.enabled) {
      env.GRAFANA_MCP_URL = this.config.mcp.grafana.url;
      if (this.config.mcp.grafana.auth === 'service_account') {
        env[this.config.mcp.grafana.serviceAccountTokenEnv] =
          this.env[this.config.mcp.grafana.serviceAccountTokenEnv] ?? '';
      }
    }

    const repo =
      typeof context.task.payload.repo === 'string' ? context.task.payload.repo : undefined;

    for (const envName of resolveWorkerSecretEnvs(this.config, repo)) {
      const value = this.env[envName];
      // Skip a missing one; an empty value would read as configured inside the sandbox.
      if (!value) {
        this.log.warn('repo secret env is not set on the orchestrator', { repo, env: envName });
        continue;
      }
      env[envName] = value;
    }

    const resources = resolveWorkerResources(this.config, repo);
    const isLogReview = context.task.workflow === 'log_review';
    const options: Record<string, unknown> = {
      name: `agent-${context.task.workflow}-${context.sandboxRun.id.slice(0, 8)}`,
      // log_review is light regardless of repo, so it keeps the small box even when a
      // repo has a big `resources` override; per-repo sizing applies to the rest.
      cpuCores: isLogReview ? 2 : (resources?.cpuCores ?? 4),
      memoryMb: isLogReview ? 4096 : (resources?.memoryMb ?? 8192),
      allowInbound: false,
      allowOutbound: true,
      maxDurationMs: context.maxWallClockMs,
      // Bound how long Tenki keeps an idle-paused sandbox before terminating it.
      // The reaper reclaims leaked sandboxes actively; this is the backstop for
      // any it misses (e.g. run row pruned, or the orchestrator stayed down).
      pauseRetentionMs: this.config.worker.sandboxPauseRetentionMs,
      githubToken: this.env[this.config.worker.githubTokenEnv],
      env,
      // The reaper reads this back off each sandbox to decide ownership; the keys
      // come from SANDBOX_METADATA (tenki-scope) so producer and consumer agree.
      metadata: {
        [SANDBOX_METADATA.app]: JARDINERO_SANDBOX_APP,
        [SANDBOX_METADATA.runId]: context.sandboxRun.id,
        [SANDBOX_METADATA.orchestratorId]: this.config.worker.orchestratorId,
        [SANDBOX_METADATA.workflow]: context.task.workflow,
        [SANDBOX_METADATA.workflowInstance]: `${context.sandboxRun.workflowType}:${context.sandboxRun.workflowInstanceId}`,
      },
    };
    const image = resolveWorkerImage(this.config, repo);
    if (image) {
      options.image = image;
    }
    return options;
  }

  private sandboxOptions(): Record<string, string> {
    return buildTenkiClientOptions(this.config, this.env);
  }

  private async createTenkiProvider(
    createOptions: Record<string, unknown>,
  ): Promise<WorkerSandboxProvider> {
    const sdk = await this.loadSdk();
    const sandbox = new sdk.TenkiSandbox(this.sandboxOptions());
    applyTenkiScope(createOptions, await resolveTenkiScope(this.config, this.env, sandbox));
    return {
      name: 'Tenki',
      apiTarget: 'api.tenki.cloud',
      create: (options) => sandbox.create(options),
      waitReady: (session, signal) =>
        (session as TenkiProviderSession).waitReady(undefined, signal),
      terminate: (session) =>
        this.terminateSession(session.id, {
          authToken: this.env[this.config.worker.tenkiApiKeyEnv],
          baseUrl: this.env[this.config.worker.tenkiApiUrlEnv],
          cwd: this.config.rootDir,
          timeoutMs: this.config.worker.sessionCloseTimeoutMs,
        }),
    };
  }

  // Announces a pre-Codex stage on the timeline/log and returns it for the
  // caller's retry-context bookkeeping; the event write is best-effort.
  private async beginStage(
    context: SandboxRunContext,
    stage: PreCodexRetryStage,
  ): Promise<PreCodexRetryStage> {
    try {
      await context.publishEvent({
        type: `sandbox.${stage}_started`,
        message: PRE_CODEX_STAGE_MESSAGES[stage],
      });
    } catch {
      // best-effort event publishing; setup integrity takes priority
    }
    return stage;
  }

  private async prepareWorkspace(
    session: WorkerSandboxSession,
    context: SandboxRunContext,
  ): Promise<void> {
    const contextDir = this.contextDir();
    const repoDir = this.repoDir();

    const mkdirResult = await this.execRequired(
      session,
      `mkdir -p ${shellQuote(contextDir)} ${shellQuote(repoDir)}`,
    );
    assertExecSucceeded(mkdirResult, 'prepare worker workspace');

    await session.writeFile(remoteJoin(contextDir, '.keep'), '');
    await this.writeCodexConfig(session);

    const repo =
      typeof context.task.payload.repo === 'string' ? context.task.payload.repo : undefined;
    if (!repo || !session.git?.clone) return;

    await context.publishEvent({
      type: 'sandbox.cloning',
      message: `Cloning ${repo}`,
    });
    // Clone the whole history: a pass that continues a pull request merges its base, and
    // a shallow clone has no merge base to do it with.
    await session.git.clone(`https://github.com/${repo}`, { directory: repoDir });
    await context.publishEvent({
      type: 'sandbox.cloned',
      message: `Cloned ${repo}`,
    });

    await this.configureGitIdentity(session, repoDir);
    await this.configureGitHubCredentials(session);

    const prNumber =
      typeof context.task.payload.pr_number === 'number'
        ? context.task.payload.pr_number
        : undefined;
    if (prNumber) {
      await context.publishEvent({
        type: 'sandbox.fetching_pull_request',
        message: `Fetching PR ${prNumber}`,
      });
      const headRef = await this.pullRequestHeadRef(repo, prNumber);
      if (!headRef) {
        await context.publishEvent({
          type: 'sandbox.pull_request_head_unresolved',
          message: `Could not resolve the head branch of PR ${prNumber}; a push will not reach it`,
        });
      }
      const fetchResult = await this.execRequired(
        session,
        buildAuthenticatedFetchPrCommand({ repoDir, prNumber, headRef }),
      );
      assertExecSucceeded(fetchResult, `fetch PR ${prNumber}`);
    }
  }

  // pullRequestHeadRef answers the branch a push has to land on, or nothing when the
  // lookup fails.
  private async pullRequestHeadRef(repo: string, prNumber: number): Promise<string | undefined> {
    const token = this.env[this.config.worker.githubTokenEnv];
    if (!token) return undefined;
    try {
      return (await this.getPullRequestHead({ repo, pullRequestNumber: prNumber, token })).headRef;
    } catch (error) {
      this.log.warn('pull request lookup failed; pushing to it will not work', {
        repo,
        pr_number: prNumber,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  // Resolves the target repo's AGENTS.md/CLAUDE.md into concrete on-disk content
  // Codex can read, and returns the doc-directive block appended to the prompt.
  // Runs after the clone and any branch checkout so a materialized AGENTS.md can
  // be shielded from the agent's commits.
  private async prepareRepoDocs(
    session: WorkerSandboxSession,
    context: SandboxRunContext,
  ): Promise<string | undefined> {
    const repo =
      typeof context.task.payload.repo === 'string' ? context.task.payload.repo : undefined;
    if (!repo || !session.exec) return undefined;

    const repoDir = this.repoDir();
    let docs: RepoDocsResult;
    try {
      docs = await ensureRepoDocs(this.repoDocsAccess(session, repoDir));
    } catch {
      // Repo docs must never fail a run; any error degrades to "no context".
      docs = { agentsPresent: false, jardineroPresent: false };
    }

    if (!docs.agentsPresent) {
      await context.publishEvent({
        type: 'sandbox.repo_docs_missing',
        message: `Running without usable AGENTS.md conventions for ${repo}.`,
        data: { repo },
      });
    }

    return renderRepoDocsPromptBlock({
      addAgentsDirective: docs.agentsPresent,
      addJardineroDirective: docs.jardineroPresent,
    });
  }

  private repoDocsAccess(session: WorkerSandboxSession, repoDir: string): RepoDocsAccess {
    const at = (name: string): string => shellQuote(remoteJoin(repoDir, name));
    return {
      readRegularFile: async (name) => {
        const path = at(name);
        // A symlink exits 10 and a missing path exits 11 so both read as null;
        // only a real regular file reaches `cat` and yields its content.
        const result = await this.execRequired(
          session,
          `if [ -L ${path} ]; then exit 10; fi; if [ -f ${path} ]; then cat ${path}; else exit 11; fi`,
        );
        const code = execExitCode(result);
        if (typeof code === 'number' && code !== 0) return null;
        return execString(result, ['stdout', 'output']);
      },
      replaceFile: async (name, content) => {
        // Delete first so the write never goes through a symlink; Tenki refuses
        // that. Then keep the rewrite out of the agent's commits.
        assertExecSucceeded(
          await this.execRequired(session, `rm -f ${at(name)}`),
          `remove ${name}`,
        );
        await session.writeFile(remoteJoin(repoDir, name), content);
        const quoted = shellQuote(name);
        await this.execRequired(
          session,
          `git -C ${shellQuote(repoDir)} update-index --skip-worktree ${quoted} 2>/dev/null || ` +
            `printf '%s\\n' ${quoted} >> ${shellQuote(remoteJoin(repoDir, '.git/info/exclude'))}`,
        );
      },
      exists: async (name) => {
        const path = at(name);
        const result = await this.execRequired(session, `[ -e ${path} ] || [ -L ${path} ]`);
        return execExitCode(result) === 0;
      },
    };
  }

  // Worker sandboxes run the Docker daemon as root with the socket group-owned
  // by `docker` (mode 0660), but the non-login guest-agent exec that runs Codex
  // does not pick up the `tenki` user's `docker` supplementary group, so
  // `docker ps` fails with "permission denied … /var/run/docker.sock" and any
  // step that needs Docker (e.g. a worker running `make start-docker`)
  // dies. World-granting the socket is the same posture the capsule templates
  // intend; we apply it ourselves so the worker can drive Docker regardless of
  // whether a given image baked that in. Best-effort by design: a sandbox with
  // no Docker socket reports `absent` and the step proceeds untouched, and a
  // grant failure is recorded rather than thrown — Docker-readiness must never
  // be what fails a run.
  private async ensureDockerSocketAccess(
    session: WorkerSandboxSession,
    context: SandboxRunContext,
  ): Promise<void> {
    try {
      const result = await this.execRequired(session, buildDockerSocketGrantCommand());
      const status = parseDockerSocketStatus(execString(result, ['stdout', 'output']));
      if (status === 'granted') {
        await context.publishEvent({
          type: 'sandbox.docker_granted',
          message: 'Granted the worker access to the Docker daemon socket.',
        });
      } else if (status === 'grant_failed') {
        await context.publishEvent({
          type: 'sandbox.docker_grant_failed',
          message:
            'A Docker socket is present but could not be made accessible; Docker-dependent steps may fail.',
        });
      } else if (status === 'no_sudo') {
        // The socket exists (Docker is expected to work) but there is no sudo
        // to widen it. Distinct from `absent`: surface it so an operator can
        // see why a later Docker-dependent step failed. (`absent` stays silent
        // — no socket means no Docker expectation in the first place.)
        await context.publishEvent({
          type: 'sandbox.docker_no_sudo',
          message:
            'A Docker socket is present but sudo is unavailable to grant access; Docker-dependent steps may fail.',
        });
      }
    } catch (error) {
      // The grant command never exits non-zero by construction, so reaching
      // here means the exec/parse/publish itself threw — an infrastructure
      // failure (session gone, exec unavailable), not a chmod failure. Use a
      // distinct event type so operators can tell the two apart.
      await context.publishEvent({
        type: 'sandbox.docker_grant_exec_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async configureGitIdentity(
    session: WorkerSandboxSession,
    repoDir: string,
  ): Promise<void> {
    const name = this.config.worker.gitAuthorName.trim();
    const email = this.config.worker.gitAuthorEmail.trim();
    if (!name || !email) return;
    const result = await this.execRequired(
      session,
      `git -C ${shellQuote(repoDir)} config user.name ${shellQuote(name)} && ` +
        `git -C ${shellQuote(repoDir)} config user.email ${shellQuote(email)}`,
    );
    assertExecSucceeded(result, 'configure git identity');
  }

  private async configureGitHubCredentials(session: WorkerSandboxSession): Promise<void> {
    const result = await this.execRequired(
      session,
      buildGitHubCredentialHelperCommand({ tokenEnv: 'GITHUB_TOKEN' }),
    );
    assertExecSucceeded(result, 'configure GitHub credentials');
  }

  private async writeCodexConfig(session: WorkerSandboxSession): Promise<void> {
    const codexConfigPath = remoteJoin(this.contextDir(), 'codex-config.toml');
    await session.writeFile(codexConfigPath, buildCodexConfigToml(this.config));
    const result = await this.execRequired(
      session,
      `mkdir -p "$HOME/.codex" && cp ${shellQuote(codexConfigPath)} "$HOME/.codex/config.toml"`,
    );
    assertExecSucceeded(result, 'install Codex config');
  }

  private async prepareCodexAuth(session: WorkerSandboxSession): Promise<void> {
    if (this.config.worker.codexAuthMode === 'capsule') {
      await forwardHostCodexAuthToSandbox(session);
    } else if (this.config.worker.codexAuthMode === 'access_token') {
      const result = await this.execRequired(
        session,
        `printenv ${shellQuote(this.config.worker.codexAccessTokenEnv)} | ${shellQuote(
          this.config.worker.codexCommand,
        )} login --with-access-token`,
      );
      assertExecSucceeded(result, 'Codex access token login');
    } else if (this.config.worker.codexAuthMode === 'api_key') {
      const result = await this.execRequired(
        session,
        `printenv ${shellQuote(this.config.worker.codexApiKeyEnv)} | ${shellQuote(
          this.config.worker.codexCommand,
        )} login --with-api-key`,
      );
      assertExecSucceeded(result, 'Codex API key login');
    }
  }

  private async prepareGrafanaMcpCredentials(
    session: WorkerSandboxSession,
    context: SandboxRunContext,
  ): Promise<void> {
    if (
      context.task.workflow !== 'log_review' ||
      !this.config.mcp.grafana.enabled ||
      this.config.mcp.grafana.auth !== 'oauth'
    ) {
      return;
    }

    const credentials = buildGrafanaMcpCredentialsJson(this.config, this.env);
    if (!credentials.contents) {
      throw new Error(
        `Missing Grafana MCP OAuth environment variables: ${credentials.missingEnv.join(', ')}`,
      );
    }

    const homedirResult = await this.execRequired(
      session,
      'node -e "process.stdout.write(require(\'node:os\').homedir())"',
    );
    assertExecSucceeded(homedirResult, 'resolve worker home directory');
    const homedir = commandOutput(homedirResult).trim();
    if (!homedir.startsWith('/')) {
      throw new Error(`Worker home directory is not absolute: ${homedir}`);
    }

    const credentialsDir = remoteJoin(homedir, '.codex');
    const credentialsPath = remoteJoin(credentialsDir, '.credentials.json');
    const script = [
      "const fs = require('node:fs');",
      `const credentialsDir = ${JSON.stringify(credentialsDir)};`,
      'fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });',
      'fs.chmodSync(credentialsDir, 0o700);',
    ].join(' ');
    const result = await this.execRequired(session, `node -e ${shellQuote(script)}`);
    assertExecSucceeded(result, 'prepare Codex credentials directory');

    const existing = await readJsonFile(session, credentialsPath);
    const injected = JSON.parse(credentials.contents) as Record<string, unknown>;
    const merged = JSON.stringify({ ...existing, ...injected }, null, 2);
    await session.fs.writeStream(credentialsPath, stringToReadableStream(merged), {
      mode: 0o600,
      truncate: true,
      sync: true,
    });

    await context.publishEvent({
      type: 'sandbox.grafana_ready',
      message: 'Installed Grafana MCP OAuth credentials from orchestrator environment',
      data: {
        server: this.config.mcp.grafana.name,
      },
    });
  }

  private async verifyLogReviewTelemetryPrerequisites(
    session: WorkerSandboxSession,
    context: SandboxRunContext,
  ): Promise<void> {
    if (context.task.workflow !== 'log_review' || !this.config.mcp.grafana.enabled) return;

    await context.publishEvent({
      type: 'agent.logs_reachable_check',
      message: 'Checking Grafana MCP availability before log review',
      data: {
        server: this.config.mcp.grafana.name,
        url: this.config.mcp.grafana.url,
        auth: this.config.mcp.grafana.auth,
      },
    });

    const mcpList = await this.execRequired(
      session,
      `${shellQuote(this.config.worker.codexCommand)} mcp list 2>&1`,
    );
    assertExecSucceeded(mcpList, 'Codex MCP list');
    const mcpListOutput = commandOutput(mcpList);
    if (!mcpListIncludesServer(mcpListOutput, this.config.mcp.grafana.name)) {
      throw new Error(
        `Grafana MCP server "${this.config.mcp.grafana.name}" is not configured in the worker Codex profile.`,
      );
    }
    if (
      this.config.mcp.grafana.auth === 'oauth' &&
      mcpListServerRequiresLogin(mcpListOutput, this.config.mcp.grafana.name)
    ) {
      throw new Error(
        `Grafana MCP server "${this.config.mcp.grafana.name}" is configured but not logged in. Run "codex mcp login ${this.config.mcp.grafana.name}" in the Codex profile inherited by worker sandboxes.`,
      );
    }

    const host = mcpHostname(this.config.mcp.grafana.url);
    if (host) {
      const script = `const dns = require('node:dns'); dns.lookup(${JSON.stringify(
        host,
      )}, (error) => { if (error) { console.error(error.message); process.exit(1); } });`;
      const dnsResult = await this.execRequired(session, `node -e ${shellQuote(script)}`);
      assertExecSucceeded(dnsResult, `resolve Grafana MCP host ${host}`);
    }

    await context.publishEvent({
      type: 'agent.logs_reachable_passed',
      message: 'Grafana MCP appears available for log review',
      data: {
        server: this.config.mcp.grafana.name,
        host,
      },
    });
  }

  // Collects the user-testing validator's evidence files (screenshots, page
  // dumps, captured responses) out of the sandbox's JARDINERO_ARTIFACTS_DIR and
  // publishes each one into the run's artifact store via context.writeSandboxRunArtifact
  // (data/runs/<run-id>/artifacts/evidence/...), where every other run artifact
  // already lives. Collection is best-effort by design: missing evidence is the
  // validator's problem — an assertion without backing evidence stays untested —
  // and a collection failure must never fail the step, only be written down.
  // Streams Codex's --json output to the worker log as it runs, so a stalled tool
  // call shows live, not only in the post-exit result; log-only, no timeline.
  private codexProgressSink(
    runId: string,
    tail: OutputTail,
  ): (output: WorkerSandboxExecOutput) => void {
    const run = runId.slice(0, 8);
    const stdout = new LineBuffer();
    const stderr = new LineBuffer();
    return (output) => {
      const buffer = output.isStderr ? stderr : stdout;
      for (const line of buffer.push(output.data, output.isFinal)) {
        tail.push(line);
        if (output.isStderr) {
          this.log.debug('codex.stderr', { run, line: truncate(line, 500) });
        } else {
          this.logCodexProgress(run, line);
        }
      }
    };
  }

  private logCodexProgress(run: string, line: string): void {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      this.log.debug('codex.stdout', { run, line: truncate(line, 500) });
      return;
    }
    const type = codexEventType(event);
    if (isCodexMilestone(type)) {
      this.log.info(type, { run, ...codexEventDetail(event) });
      return;
    }
    this.log.debug(type, {
      run,
      ...codexEventDetail(event),
      event: truncate(JSON.stringify(redactUnknown(event)), 800),
    });
  }

  private async execRequired(
    session: WorkerSandboxSession,
    command: string,
    onOutput?: (output: WorkerSandboxExecOutput) => void,
  ): Promise<WorkerSandboxExecResult | string> {
    if (!session.exec) {
      throw new Error(
        'Sandbox session does not expose exec; Codex worker runner requires shell execution.',
      );
    }
    return session.exec('sh', { args: ['-lc', command], onOutput });
  }

  // runCodex runs the agent once per model the seat may use, and retries only when the
  // model refused for capacity: any other failure is the run's answer.
  private async runCodex(
    session: WorkerSandboxSession,
    context: SandboxRunContext,
  ): Promise<CodexRunResult> {
    const models = this.codexModels(context);
    const tail = new OutputTail();
    let result: CodexRunResult | undefined;

    for (const [attempt, model] of models.entries()) {
      const command = this.codexCommand(context, model);
      // codex.* events publish only after the CLI exits; post a start event to
      // distinguish a hung run from an earlier stalled stage.
      await context.publishEvent({
        type: 'agent.started',
        message: attempt === 0 ? 'Codex run started' : 'Codex run restarted on another model',
        data: { attempt: attempt + 1, max_attempts: models.length, model },
      });
      let execResult: WorkerSandboxExecResult | string;
      try {
        execResult = await this.execRequired(
          session,
          command,
          this.codexProgressSink(context.sandboxRun.id, tail),
        );
      } catch (error) {
        // The run died mid-stream, so what it printed is the only account of it left.
        await this.writeOutputTail(context, tail);
        throw error;
      }
      const lastMessage = await readTextFile(
        session,
        remoteJoin(this.contextDir(), 'codex-last-message.txt'),
      );
      result = normalizeCodexResult(command, execResult, lastMessage);

      const failed = typeof result.exitCode === 'number' && result.exitCode !== 0;
      const nextModel = models[attempt + 1];
      if (!failed || !isCodexCapacityError(result) || !nextModel) {
        if (failed) await this.writeOutputTail(context, tail);
        return result;
      }

      await context.publishEvent({
        type: 'agent.model_at_capacity',
        message: `Codex refused ${model} for capacity; retrying on ${nextModel}`,
        data: { model, next_model: nextModel, attempt: attempt + 1 },
      });
    }
    // The seat always resolves to at least one model, so the loop always ran.
    if (!result) throw new Error('Codex run had no model to use.');
    return result;
  }

  // writeOutputTail leaves the end of the output as an artifact. It answers instead of
  // throwing: a post-mortem that fails must not become the run's failure.
  private async writeOutputTail(context: SandboxRunContext, tail: OutputTail): Promise<void> {
    if (tail.isEmpty()) return;
    try {
      await context.writeSandboxRunArtifact('codex-output-tail.txt', tail.text());
    } catch (error) {
      this.log.warn('could not write the codex output tail', {
        sandbox_run_id: context.sandboxRun.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // The seat's model, and the implementation model behind it when they differ: a triage
  // seat at capacity is worth finishing on the stronger model rather than not at all.
  private codexModels(context: SandboxRunContext): string[] {
    const seatModel = this.modelFor(context);
    const implementation = resolveSeatModel(this.config, this.repoFor(context), 'implementation');
    return implementation && implementation !== seatModel
      ? [seatModel, implementation]
      : [seatModel];
  }

  private codexCommand(context: SandboxRunContext, model = this.modelFor(context)): string {
    const workdir =
      typeof context.task.payload.repo === 'string' ? this.repoDir() : this.workspacePath();
    const contextDir = this.contextDir();
    const args = [
      shellQuote(this.config.worker.codexCommand),
      'exec',
      '--json',
      '--color',
      'never',
      '--ephemeral',
      '--skip-git-repo-check',
      '--output-last-message',
      shellQuote(remoteJoin(contextDir, 'codex-last-message.txt')),
      '-m',
      shellQuote(model),
      '-C',
      shellQuote(workdir),
    ];
    const effort = this.effortFor(context);
    args.push('-c', shellQuote(`model_reasoning_effort=${effort}`));
    if (this.config.worker.codexBypassSandbox) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      args.push('--sandbox', 'workspace-write');
    }
    args.push('-', '<', shellQuote(remoteJoin(contextDir, 'prompt.txt')));
    return args.join(' ');
  }

  private workspacePath(): string {
    return normalizeRemotePath(this.config.worker.workspacePath);
  }

  private contextDir(): string {
    return remoteJoin(this.workspacePath(), 'context');
  }

  private repoDir(): string {
    return remoteJoin(this.workspacePath(), 'repo');
  }

  // The model comes from the repo's generation profile; the seat picks the tier. A
  // repo's image fixes the generation, so this is what keeps a 5.5-only image off 5.6.
  // payload.model is intentionally NOT honored — a run must not request a model its
  // image can't execute — so warn if one slips in rather than drop it silently.
  private modelFor(context: SandboxRunContext): string {
    const pinned = context.task.payload.model;
    if (typeof pinned === 'string' && pinned.trim().length > 0) {
      this.log.warn('ignoring payload.model; model is resolved from the repo generation', {
        run_id: context.sandboxRun.id,
        ignored_model: pinned,
      });
    }
    return resolveSeatModel(this.config, this.repoFor(context), this.seatFor(context));
  }

  // The seat a run occupies: Linear steps stamp their role; log_review is
  // the triage seat; everything else is the implementation seat. Linear's 'implement'
  // role is the same implementation tier as pr_maintain/fix, so normalize it to the
  // generation profile's base key rather than let it diverge on an 'implement' entry.
  private seatFor(context: SandboxRunContext): string {
    const role = context.task.payload.role;
    if (typeof role === 'string' && role.length > 0) {
      return role === 'implement' ? 'implementation' : role;
    }
    return context.task.workflow === 'log_review' ? 'triage' : 'implementation';
  }

  // A seat's configured (or payload-pinned) effort, clamped to the repo's ceiling so a
  // 5.5 image never gets asked for `max`, which it rejects.
  private effortFor(context: SandboxRunContext): CodexEffort {
    const payloadEffort = context.task.payload.effort;
    const base = isCodexEffort(payloadEffort)
      ? payloadEffort
      : context.task.workflow === 'log_review'
        ? this.config.worker.triageEffort
        : this.config.worker.implementationEffort;
    const repo = this.repoFor(context);
    const clamped = clampEffort(base, resolveWorkerMaxEffort(this.config, repo));
    if (clamped !== base) {
      this.log.warn('effort clamped to the repo max_effort ceiling', {
        run_id: context.sandboxRun.id,
        repo,
        requested_effort: base,
        clamped_effort: clamped,
      });
    }
    return clamped;
  }

  private repoFor(context: SandboxRunContext): string | undefined {
    return typeof context.task.payload.repo === 'string' ? context.task.payload.repo : undefined;
  }
}

export class TenkiWorkerRunner extends SandboxWorkerRunner {}

function isCodexEffort(value: unknown): value is CodexEffort {
  return typeof value === 'string' && CODEX_EFFORTS.includes(value as CodexEffort);
}

export async function loadTenkiSdk(): Promise<TenkiSdk> {
  try {
    return await import('@tenkicloud/sandbox');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to load @tenkicloud/sandbox (${message}). Run pnpm install to install @tenkicloud/sandbox.`,
    );
  }
}

function summarizeResult(result: CodexRunResult, providerName: string): string {
  const direct = [result.lastMessage, result.stdout, result.stderr].find(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );
  if (typeof direct === 'string' && direct.trim().length > 0) return direct.trim().slice(0, 500);
  return `Codex completed in ${providerName} sandbox.`;
}

function retryableWorkerSandboxSessionStartReason(error: unknown): string | undefined {
  const message = sandboxSessionStartErrorMessage(error);
  const patterns: Array<{ label: string; matches: string[] }> = [
    { label: 'deadline_exceeded', matches: ['deadline_exceeded'] },
    {
      label: 'session_terminal_terminated',
      matches: ['session entered terminal state: TERMINATED'],
    },
    {
      label: 'session_not_ready',
      matches: ['session is not ready for command execution'],
    },
    {
      label: 'http2_goaway',
      matches: ['received GOAWAY without any open streams'],
    },
    { label: 'http2_refused_stream', matches: ['NGHTTP2_REFUSED_STREAM'] },
    {
      label: 'tls_handshake_failed',
      matches: ['SSL alert number 80', 'tlsv1 alert internal error'],
    },
    { label: 'connection_reset', matches: ['ECONNRESET'] },
    { label: 'network_timeout', matches: ['ETIMEDOUT', 'socket hang up'] },
    { label: 'dns_lookup_failed', matches: ['ENOTFOUND', 'EAI_AGAIN', 'Could not resolve host'] },
    { label: 'connection_refused', matches: ['ECONNREFUSED'] },
  ];

  for (const pattern of patterns) {
    if (pattern.matches.some((match) => message.includes(match))) return pattern.label;
  }
  return undefined;
}

function sandboxSessionStartErrorMessage(error: unknown): string {
  if (error instanceof CallContextError) return error.rawMessage;
  return error instanceof Error ? error.message : String(error);
}

function workerOutputText(result: CodexRunResult): string {
  return [result.lastMessage, result.stdout, result.stderr]
    .filter((value): value is string => Boolean(value))
    .join('\n');
}

function finalResponseText(result: CodexRunResult): string {
  return finalAgentMessageText(result.events) ?? result.lastMessage ?? workerOutputText(result);
}

function logReviewFailureReport(validation: LogReviewTelemetryValidation): {
  type: string;
  message: string;
} {
  const reason = validation.reason ?? 'unknown';
  return validation.failure === 'handoff_contract'
    ? {
        type: 'agent.scan_output_invalid',
        message: `Log review output failed the handoff contract: ${reason}`,
      }
    : {
        type: 'agent.logs_reachable_failed',
        message: `Log review did not prove telemetry access: ${reason}`,
      };
}

export function finalAgentMessageText(events: unknown[]): string | undefined {
  let finalText: string | undefined;
  for (const event of events) {
    if (typeof event !== 'object' || event === null || Array.isArray(event)) continue;
    const item = (event as Record<string, unknown>).item;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const itemRecord = item as Record<string, unknown>;
    if (itemRecord.type !== 'agent_message') continue;
    const text = itemRecord.text;
    if (typeof text === 'string' && text.trim().length > 0) finalText = text;
  }
  return finalText;
}

function normalizeUnknown(value: unknown): Record<string, unknown> {
  const redacted = redactUnknown(value);
  if (typeof redacted === 'object' && redacted !== null && !Array.isArray(redacted)) {
    return redacted as Record<string, unknown>;
  }
  return { value: redacted };
}

function redactUnknown(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof Uint8Array) return '[binary]';
  if (depth > 8) return '[redacted-depth-limit]';
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, depth + 1));

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = redactUnknown(nested, depth + 1);
  }
  return output;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '[redacted-github-token]')
    .replace(/\bgh[opsru]_[A-Za-z0-9_]+\b/g, '[redacted-github-token]');
}

function safeEventData(value: Record<string, unknown>): Record<string, unknown> {
  return {
    ...value,
    githubToken: value.githubToken ? '[redacted]' : undefined,
    env: '[redacted]',
  };
}

function commandOutput(result: WorkerSandboxExecResult | string): string {
  return [execString(result, ['stdout', 'output']), execString(result, ['stderr', 'error'])]
    .filter((value) => value.trim().length > 0)
    .join('\n');
}

export function mcpListIncludesServer(output: string, serverName: string): boolean {
  return mcpListServerLines(output, serverName).length > 0;
}

export function mcpListServerRequiresLogin(output: string, serverName: string): boolean {
  return mcpListServerLines(output, serverName).some((line) => /not logged in/i.test(line));
}

export function buildAuthenticatedFetchPrCommand(options: {
  repoDir: string;
  prNumber: number;
  headRef?: string;
  branchPrefix?: string;
  tokenEnv?: string;
}): string {
  if (!Number.isInteger(options.prNumber) || options.prNumber <= 0) {
    throw new Error('pr number must be > 0');
  }

  const headRef = options.headRef?.trim();
  const branchPrefix = options.branchPrefix?.trim() || 'pr';
  const branch = headRef || `${branchPrefix}-${options.prNumber}`;
  const refspec = `pull/${options.prNumber}/head`;
  const tmpConfigExpansion = '${tmpcfg}';
  const git = `git -C ${shellQuote(options.repoDir)}`;

  return [
    ...oneShotGitHubAuthPreamble(options.tokenEnv ?? 'GITHUB_TOKEN', 'fetch PR refs'),
    `${git} -c include.path="${tmpConfigExpansion}" fetch origin ${shellQuote(refspec)}`,
    `${git} checkout -B ${shellQuote(branch)} FETCH_HEAD`,
    // Point the branch at the pull request so a plain push lands on it.
    ...(headRef
      ? [
          `${git} config ${shellQuote(`branch.${headRef}.remote`)} origin`,
          `${git} config ${shellQuote(`branch.${headRef}.merge`)} ${shellQuote(`refs/heads/${headRef}`)}`,
        ]
      : []),
  ].join(' && ');
}

export function buildGitHubCredentialHelperCommand(options: { tokenEnv?: string } = {}): string {
  const tokenEnv = options.tokenEnv ?? 'GITHUB_TOKEN';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) {
    throw new Error(`invalid token env var: ${tokenEnv}`);
  }
  const optionalTokenExpansion = `\${${tokenEnv}:-}`;
  const tokenExpansion = `\${${tokenEnv}}`;
  const helper = [
    '!f() {',
    'test "$1" = get || exit 0;',
    'echo username=x-access-token;',
    `echo "password=${tokenExpansion}";`,
    '}; f',
  ].join(' ');
  return [
    `if [ -z "${optionalTokenExpansion}" ]; then echo ${shellQuote(`${tokenEnv} is required to configure GitHub credentials`)} >&2; exit 1; fi`,
    `git config --global credential.https://github.com.helper ${shellQuote(helper)}`,
  ].join(' && ');
}

// The Docker daemon socket inside worker sandboxes.
const DOCKER_SOCKET_PATH = '/var/run/docker.sock';

// Best-effort, idempotent grant of the Docker daemon socket so the non-login
// worker exec can reach Docker. Always exits 0 and prints a single parseable
// `docker_socket=<status>` line the runner turns into an event:
//   absent       — no Docker socket in this sandbox (nothing to do)
//   no_sudo      — no sudo available to adjust the socket
//   granted      — socket made world-accessible
//   grant_failed — socket present but chmod failed (Docker steps may fail)
export function buildDockerSocketGrantCommand(socketPath: string = DOCKER_SOCKET_PATH): string {
  const quoted = shellQuote(socketPath);
  return [
    `if [ ! -S ${quoted} ]; then echo 'docker_socket=absent';`,
    `elif ! command -v sudo >/dev/null 2>&1; then echo 'docker_socket=no_sudo';`,
    `elif sudo -n chmod 666 ${quoted} 2>/dev/null; then echo 'docker_socket=granted';`,
    `else echo 'docker_socket=grant_failed'; fi`,
  ].join(' ');
}

// Pulls the `docker_socket=<status>` marker out of the grant command's output.
// Unknown/garbled output degrades to 'unknown' so the runner stays quiet rather
// than emitting a misleading event.
export function parseDockerSocketStatus(output: string): string {
  const match = output.match(/docker_socket=(\w+)/);
  return match ? match[1]! : 'unknown';
}

// The one-shot GitHub auth preamble shared by setup-time git commands: a
// temporary config file carrying an Authorization header, removed on exit, so
// the token never lands in the repo's .git/config or the process list.
function oneShotGitHubAuthPreamble(tokenEnv: string, purpose: string): string[] {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) {
    throw new Error(`invalid token env var: ${tokenEnv}`);
  }
  const tokenExpansion = `\${${tokenEnv}}`;
  const optionalTokenExpansion = `\${${tokenEnv}:-}`;
  const basicAuthExpansion = '${basic_auth}';
  const tmpConfigExpansion = '${tmpcfg}';
  return [
    `if [ -z "${optionalTokenExpansion}" ]; then echo ${shellQuote(`${tokenEnv} is required to ${purpose}`)} >&2; exit 1; fi`,
    'tmpcfg=$(umask 077 && mktemp)',
    `trap 'rm -f "$tmpcfg"' EXIT`,
    `basic_auth=$(printf 'x-access-token:%s' "${tokenExpansion}" | base64 | tr -d ${shellQuote('\\n')})`,
    `printf '[http "https://github.com/"]\\n\\textraheader = AUTHORIZATION: basic %s\\n' "${basicAuthExpansion}" > "${tmpConfigExpansion}"`,
    `chmod 600 "${tmpConfigExpansion}"`,
  ];
}

function mcpListServerLines(output: string, serverName: string): string[] {
  return output.split(/\r?\n/).filter((line) => line.trim().split(/\s+/)[0] === serverName);
}

function mcpHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

// isCodexCapacityError answers whether the model refused the run because it is full,
// which is the one failure another model can still answer.
export function isCodexCapacityError(result: {
  stdout?: string;
  stderr?: string;
  lastMessage?: string;
}): boolean {
  return [result.stdout, result.stderr, result.lastMessage].some((text) =>
    CAPACITY_REFUSAL.test(text ?? ''),
  );
}

const CAPACITY_REFUSAL = /model is at capacity/i;

function normalizeCodexResult(
  command: string,
  result: WorkerSandboxExecResult | string,
  lastMessage?: string,
): CodexRunResult {
  const stdout = execString(result, ['stdout', 'output']);
  const stderr = execString(result, ['stderr', 'error']);
  const events = parseJsonLines(stdout);
  return {
    command,
    exitCode: execExitCode(result),
    stdout,
    stderr,
    lastMessage,
    costUsd: extractCostUsd(result, events),
    events,
    raw: result,
  };
}

function extractCostUsd(...values: unknown[]): number | null {
  for (const value of values) {
    const cost = findCostUsd(value, new Set());
    if (cost !== null) return cost;
  }
  return null;
}

function findCostUsd(value: unknown, seen: Set<object>): number | null {
  if (typeof value !== 'object' || value === null) return null;
  if (value instanceof Uint8Array) return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const cost = findCostUsd(item, seen);
      if (cost !== null) return cost;
    }
    return null;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (isCostUsdKey(key)) {
      const cost = finiteNumber(nested);
      if (cost !== null && cost >= 0) return cost;
    }
    const cost = findCostUsd(nested, seen);
    if (cost !== null) return cost;
  }
  return null;
}

function isCostUsdKey(key: string): boolean {
  return [
    'costUsd',
    'cost_usd',
    'totalCostUsd',
    'total_cost_usd',
    'totalCost',
    'total_cost',
  ].includes(key);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function parseJsonLines(value: string): unknown[] {
  const events: unknown[] = [];
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {}
  }
  return events;
}

function codexEventType(event: unknown): string {
  if (typeof event === 'object' && event !== null && !Array.isArray(event)) {
    const type = (event as Record<string, unknown>).type;
    if (typeof type === 'string' && type.length > 0) return `agent.${type}`;
  }
  return 'agent.event';
}

// Item start/finish and thread/turn lifecycle are the coarse action trail that
// localizes a hang; per-token item.updated and everything else is verbose.
export function isCodexMilestone(type: string): boolean {
  return (
    type === 'agent.item.started' ||
    type === 'agent.item.completed' ||
    type.startsWith('agent.thread.') ||
    type.startsWith('agent.turn.')
  );
}

// Fields that identify a stuck action sit at the top level so the log line is
// scannable; the command Codex is running is the primary signal for a hang.
export function codexEventDetail(event: unknown): Record<string, unknown> {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return {};
  const record = event as Record<string, unknown>;
  const item = record.item;
  const hasItem = typeof item === 'object' && item !== null && !Array.isArray(item);
  const source = hasItem ? (item as Record<string, unknown>) : record;
  const detail: Record<string, unknown> = {};
  if (hasItem) {
    const itemType = source.item_type ?? source.type;
    if (typeof itemType === 'string' && itemType.length > 0) detail.item = itemType;
  }
  if (typeof source.command === 'string') detail.command = truncate(source.command, 500);
  if (typeof source.text === 'string') detail.text = truncate(source.text, 500);
  if (typeof source.status === 'string') detail.status = source.status;
  if (typeof source.exit_code === 'number') detail.exit_code = source.exit_code;
  return detail;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

// Reassembles line-delimited output from a chunked stream; a chunk boundary can
// fall inside a JSON line or a multi-byte character.
export class LineBuffer {
  private readonly decoder = new TextDecoder();
  private pending = '';

  constructor(private readonly maxLineLength = 256_000) {}

  push(data: Uint8Array, final: boolean): string[] {
    this.pending += this.decoder.decode(data, { stream: !final });
    const parts = this.pending.split('\n');
    const remainder = parts.pop() ?? '';
    if (final) {
      if (remainder) parts.push(remainder);
      this.pending = '';
    } else if (remainder.length > this.maxLineLength) {
      // An undelimited line past the cap is dropped so a pathological event can't
      // grow pending without bound.
      this.pending = '';
    } else {
      this.pending = remainder;
    }
    return parts.map((line) => line.trim()).filter((line) => line.length > 0);
  }
}

async function readTextFile(
  session: WorkerSandboxSession,
  path: string,
): Promise<string | undefined> {
  if (!session.readFile) return undefined;
  try {
    const value = await session.readFile(path);
    return typeof value === 'string' ? value : new TextDecoder().decode(value);
  } catch {
    return undefined;
  }
}

async function readJsonFile(
  session: WorkerSandboxSession,
  path: string,
): Promise<Record<string, unknown>> {
  try {
    const stream = await session.fs.readStream(path);
    const value = await streamToString(stream);
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new TextDecoder().decode(await streamToBytes(stream));
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return concatUint8Arrays(chunks);
}

function stringToReadableStream(value: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Run aborted.');
}
