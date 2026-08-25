import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';

import {
  PROMPT_GLOBAL_REPO,
  type Prompt,
  type AgentKind,
  MAX_PROMPT_LENGTH,
} from '../workflows/agents.js';
import { EDITABLE_PROMPT_SEGMENT } from '../workflows/prompt-segment.js';
import { logger } from '../platform/logger.js';
import { iso, nowMs } from '../platform/time.js';
import {
  AWAITING_A_PERSON_STATES,
  FIX_IMPLEMENTER_TERMINAL_STATES,
  LINEAR_IMPLEMENTER_TERMINAL_STATES,
  LOG_REVIEWER_TERMINAL_STATES,
  PR_MAINTAINER_TERMINAL_STATES,
  REQUEST_ROUTER_TERMINAL_STATES,
  TERMINAL_STATES,
  type EventLogEntry,
  type EventLogFilter,
  type FixImplementer,
  type FixImplementerState,
  type LinearImplementer,
  type LinearImplementerState,
  type LogReviewer,
  type LogReviewerState,
  type DiscordConversation,
  type OurPullRequest,
  type Page,
  type PageRequest,
  type PrMaintainer,
  type PrMaintainerState,
  type PrMaintainerThread,
  type Repository,
  type RequestFilter,
  type RequestRouter,
  type RequestRouterState,
  type RequestSource,
  type RequestSummary,
  type ReplyTargetType,
  type SandboxRunState,
  type SandboxRun,
  type StateArrivalBucket,
  type SubjectType,
  type VerifierVerdict,
  type WorkflowInstanceFilter,
  type WorkflowInstanceStateCount,
  type WorkflowInstanceSummary,
  type WorkflowSubjectKind,
  type WorkflowType,
} from './types.js';

type DbRow = Record<string, unknown>;

// WORKFLOW_INSTANCE_UNION projects the five machines into one shape. Only the first
// SELECT names the columns, so every branch has to keep this order.
const WORKFLOW_INSTANCE_UNION = `
  SELECT 'request_router' AS workflow_type, rr.id AS workflow_instance_id,
         rr.workflow_state AS workflow_state, rr.repository_id AS repository_id,
         r.full_name AS repository_full_name, 'request' AS subject_kind,
         rr.request_source || ' · ' || COALESCE(rr.requester_external_id, 'unknown') AS subject_label,
         NULL AS pull_request_number, NULL AS attempt_count, NULL AS iteration_number,
         NULL AS needs_human_reason, rr.sandbox_run_id AS sandbox_run_id,
         rr.state_changed_at AS state_changed_at, rr.created_at AS created_at,
         (SELECT COUNT(*) FROM sandbox_run s
           WHERE s.workflow_type = 'request_router' AND s.workflow_instance_id = rr.id
         ) AS sandbox_run_count,
         (SELECT s.run_state FROM sandbox_run s
           WHERE s.workflow_type = 'request_router' AND s.workflow_instance_id = rr.id
           ORDER BY s.started_at DESC LIMIT 1
         ) AS last_run_state,
         (SELECT s.ended_at FROM sandbox_run s
           WHERE s.workflow_type = 'request_router' AND s.workflow_instance_id = rr.id
           ORDER BY s.started_at DESC LIMIT 1
         ) AS last_run_ended_at
  FROM request_router rr LEFT JOIN repository r ON r.id = rr.repository_id
  UNION ALL
  SELECT 'linear_implementer', li.id, li.workflow_state, li.repository_id, r.full_name,
         'linear_issue', li.linear_issue_identifier, li.pull_request_number,
         NULL, li.iteration_number, li.needs_human_reason, li.sandbox_run_id,
         li.state_changed_at, li.created_at,
         (SELECT COUNT(*) FROM sandbox_run s
           WHERE s.workflow_type = 'linear_implementer' AND s.workflow_instance_id = li.id),
         (SELECT s.run_state FROM sandbox_run s
           WHERE s.workflow_type = 'linear_implementer' AND s.workflow_instance_id = li.id
           ORDER BY s.started_at DESC LIMIT 1),
         (SELECT s.ended_at FROM sandbox_run s
           WHERE s.workflow_type = 'linear_implementer' AND s.workflow_instance_id = li.id
           ORDER BY s.started_at DESC LIMIT 1)
  FROM linear_implementer li LEFT JOIN repository r ON r.id = li.repository_id
  UNION ALL
  SELECT 'fix_implementer', fi.id, fi.workflow_state, fi.repository_id, r.full_name,
         'finding', fi.finding_fingerprint, fi.pull_request_number,
         NULL, NULL, fi.needs_human_reason, fi.sandbox_run_id,
         fi.state_changed_at, fi.created_at,
         (SELECT COUNT(*) FROM sandbox_run s
           WHERE s.workflow_type = 'fix_implementer' AND s.workflow_instance_id = fi.id),
         (SELECT s.run_state FROM sandbox_run s
           WHERE s.workflow_type = 'fix_implementer' AND s.workflow_instance_id = fi.id
           ORDER BY s.started_at DESC LIMIT 1),
         (SELECT s.ended_at FROM sandbox_run s
           WHERE s.workflow_type = 'fix_implementer' AND s.workflow_instance_id = fi.id
           ORDER BY s.started_at DESC LIMIT 1)
  FROM fix_implementer fi LEFT JOIN repository r ON r.id = fi.repository_id
  UNION ALL
  SELECT 'log_reviewer', lr.id, lr.workflow_state, lr.repository_id, r.full_name,
         'log_target',
         CASE
           WHEN lr.service_name IS NOT NULL AND lr.environment_name IS NOT NULL
             THEN lr.service_name || ' @ ' || lr.environment_name
           WHEN lr.service_name IS NOT NULL THEN lr.service_name
           ELSE r.full_name
         END,
         NULL, NULL, NULL, NULL, lr.sandbox_run_id, lr.state_changed_at, lr.created_at,
         (SELECT COUNT(*) FROM sandbox_run s
           WHERE s.workflow_type = 'log_reviewer' AND s.workflow_instance_id = lr.id),
         (SELECT s.run_state FROM sandbox_run s
           WHERE s.workflow_type = 'log_reviewer' AND s.workflow_instance_id = lr.id
           ORDER BY s.started_at DESC LIMIT 1),
         (SELECT s.ended_at FROM sandbox_run s
           WHERE s.workflow_type = 'log_reviewer' AND s.workflow_instance_id = lr.id
           ORDER BY s.started_at DESC LIMIT 1)
  FROM log_reviewer lr LEFT JOIN repository r ON r.id = lr.repository_id
  UNION ALL
  SELECT 'pr_maintainer', pm.id, pm.workflow_state, pm.repository_id, r.full_name,
         'pull_request', r.full_name || '#' || pm.pull_request_number, pm.pull_request_number,
         pm.attempt_count, NULL, pm.needs_human_reason, pm.sandbox_run_id,
         pm.state_changed_at, pm.created_at,
         (SELECT COUNT(*) FROM sandbox_run s
           WHERE s.workflow_type = 'pr_maintainer' AND s.workflow_instance_id = pm.id),
         (SELECT s.run_state FROM sandbox_run s
           WHERE s.workflow_type = 'pr_maintainer' AND s.workflow_instance_id = pm.id
           ORDER BY s.started_at DESC LIMIT 1),
         (SELECT s.ended_at FROM sandbox_run s
           WHERE s.workflow_type = 'pr_maintainer' AND s.workflow_instance_id = pm.id
           ORDER BY s.started_at DESC LIMIT 1)
  FROM pr_maintainer pm LEFT JOIN repository r ON r.id = pm.repository_id
`;

// OPEN_WORKFLOW_INSTANCE_UNION reads the state of every instance that has not ended,
// which is what the counts of the Overview are.
const WORKFLOW_TABLES: Record<WorkflowType, string> = {
  request_router: 'request_router',
  linear_implementer: 'linear_implementer',
  fix_implementer: 'fix_implementer',
  log_reviewer: 'log_reviewer',
  pr_maintainer: 'pr_maintainer',
};

const OPEN_WORKFLOW_INSTANCE_UNION = [
  ['request_router', REQUEST_ROUTER_TERMINAL_STATES],
  ['linear_implementer', LINEAR_IMPLEMENTER_TERMINAL_STATES],
  ['fix_implementer', FIX_IMPLEMENTER_TERMINAL_STATES],
  ['log_reviewer', LOG_REVIEWER_TERMINAL_STATES],
  ['pr_maintainer', PR_MAINTAINER_TERMINAL_STATES],
]
  .map(([table, terminalStates]) => {
    const quoted = (terminalStates as readonly string[]).map((state) => `'${state}'`).join(', ');
    return `SELECT '${table as string}' AS workflow_type, workflow_state
            FROM ${table as string} WHERE workflow_state NOT IN (${quoted})`;
  })
  .join(' UNION ALL ');

// WORKFLOW_INSTANCE_UPDATED_UNION reads when each instance was last written, which is
// half of the version the live snapshot keys off.
const WORKFLOW_INSTANCE_UPDATED_UNION = [
  'request_router',
  'linear_implementer',
  'fix_implementer',
  'log_reviewer',
  'pr_maintainer',
]
  .map((table) => `SELECT updated_at FROM ${table}`)
  .join(' UNION ALL ');

// PULL_REQUEST_UNION can hold the same pull request twice: the machine that opened
// it and the machine that follows it.
const PULL_REQUEST_UNION = `
  SELECT 'pr_maintainer' AS workflow_type, pm.id AS workflow_instance_id,
         pm.workflow_state AS workflow_state, pm.repository_id AS repository_id,
         r.full_name AS repository_full_name, pm.pull_request_number AS pull_request_number,
         0 AS opened_by_us, pm.created_at AS created_at,
         pm.state_changed_at AS state_changed_at
  FROM pr_maintainer pm JOIN repository r ON r.id = pm.repository_id
  UNION ALL
  SELECT 'linear_implementer', li.id, li.workflow_state, li.repository_id, r.full_name,
         li.pull_request_number, 1, li.created_at, li.state_changed_at
  FROM linear_implementer li JOIN repository r ON r.id = li.repository_id
  WHERE li.pull_request_number IS NOT NULL
  UNION ALL
  SELECT 'fix_implementer', fi.id, fi.workflow_state, fi.repository_id, r.full_name,
         fi.pull_request_number, 1, fi.created_at, fi.state_changed_at
  FROM fix_implementer fi JOIN repository r ON r.id = fi.repository_id
  WHERE fi.pull_request_number IS NOT NULL
`;

export interface SqliteBackupFailure extends Error {
  backupDir: string;
  backupTargetPath: string;
  code?: unknown;
  partialTargetRemoved: boolean;
  partialTargetRemovalCode?: unknown;
}

export interface SandboxRunArtifactLink {
  name: string;
  path: string;
  url: string;
  size_bytes: number;
}

export interface SandboxRunArtifactFile extends SandboxRunArtifactLink {
  content: Buffer;
}

type Row = Record<string, SQLInputValue>;

export interface StorePaths {
  dataPath: string;
  schemaPath: string;
  backupIntervalMin?: number;
  backupRetentionCount?: number;
}

export interface CreateRequestInput {
  requestSource: RequestSource;
  requestText?: string;
  requesterExternalId?: string;
  replyTargetType?: ReplyTargetType;
  replyTargetId?: string;
  repositoryId?: string;
  subjectType?: SubjectType;
  subjectExternalId?: string;
}

export interface ResolveRequestInput {
  repositoryId?: string;
  subjectType?: SubjectType;
  subjectExternalId?: string;
  resolutionNote?: string;
  sandboxRunId?: string | null;
}

export interface OpenPrMaintainerInput {
  repositoryId: string;
  pullRequestNumber: number;
  requestRouterId?: string;
}

export interface OpenLinearImplementerInput {
  repositoryId: string;
  linearIssueId: string;
  linearIssueIdentifier: string;
  linearSessionId?: string;
  promptContext?: string;
  requestRouterId?: string;
}

export interface LinearImplementerFields {
  linearSessionId?: string | null;
  promptContext?: string | null;
  pullRequestNumber?: number | null;
  iterationNumber?: number;
  verifiedCommitSha?: string | null;
  verifierVerdict?: VerifierVerdict | null;
  verifierIssues?: string | null;
  sandboxRunId?: string | null;
  needsHumanReason?: string | null;
}

export interface OpenFixImplementerInput {
  repositoryId: string;
  findingFingerprint: string;
  logReviewerId?: string;
  serviceName?: string;
  environmentName?: string;
  findingEvidence?: string;
}

export interface FixImplementerTargetScope {
  repositoryId: string;
  serviceName?: string;
  environmentName?: string;
}

export interface FixImplementerFields {
  pullRequestNumber?: number | null;
  verifiedCommitSha?: string | null;
  verifierVerdict?: VerifierVerdict | null;
  verifierIssues?: string | null;
  sandboxRunId?: string | null;
  needsHumanReason?: string | null;
  discardReason?: string | null;
}

export interface OpenLogReviewerInput {
  repositoryId: string;
  serviceName?: string;
  environmentName?: string;
  requestRouterId?: string;
}

export interface LogReviewerFields {
  findingCount?: number;
  sandboxRunId?: string | null;
}

export interface StartSandboxRunInput {
  agentName: string;
  workflowType: WorkflowType;
  workflowInstanceId: string;
}

export interface FinishSandboxRunInput {
  runState: Exclude<SandboxRunState, 'pending' | 'running'>;
  sandboxSessionId?: string;
  costUsd?: number | null;
  errorMessage?: string;
}

export interface AppendEventInput {
  eventType: string;
  workflowType?: WorkflowType;
  workflowInstanceId?: string;
  sandboxRunId?: string;
  repositoryId?: string;
  fromState?: string;
  toState?: string;
  metadata?: Record<string, unknown>;
}

const EVENT_LIST_METADATA_MAX_BYTES = 4_096;

// STATE_CHECK_MIGRATIONS names, per table, a state this code writes that an older
// database's CHECK would reject. SQLite cannot alter a constraint, so the table is rebuilt
// from the DDL in schema.sql, which stays the only place its shape is written.
const STATE_CHECK_MIGRATIONS: Readonly<Record<string, string>> = {
  linear_implementer: 'li_dismissed',
  fix_implementer: 'fi_dismissed',
  pr_maintainer: 'prm_dismissed',
};

// Store is every read and write of Jardinero state.
export class Store {
  private readonly log = logger.child('store');

  readonly db: DatabaseSync;
  readonly runsDir: string;
  readonly backupsDir: string;

  constructor(private readonly paths: StorePaths) {
    mkdirSync(paths.dataPath, { recursive: true });
    this.runsDir = path.join(paths.dataPath, 'runs');
    this.backupsDir = path.join(paths.dataPath, 'backups');
    mkdirSync(this.runsDir, { recursive: true });
    mkdirSync(this.backupsDir, { recursive: true });

    this.db = new DatabaseSync(path.join(paths.dataPath, 'state.db'));
    // SQLite's default busy_timeout is 0 — a write that collides with any
    // concurrent transaction (e.g. a long-running dashboard query on the same
    // connection pool, or the audit log flushing) fails immediately with
    // SQLITE_BUSY instead of retrying. Set a 5s window so contention resolves
    // itself under bursty load without orphaning runs or losing bookkeeping.
    this.db.exec('PRAGMA busy_timeout = 5000');
    const schema = readFileSync(paths.schemaPath, 'utf8');
    this.db.exec(schema);
    migrateStateChecks(this.db, schema);
  }

  close(): void {
    this.db.close();
  }

  initializeAfterBoot(): void {
    const result = this.db
      .prepare(
        `UPDATE sandbox_run SET run_state = 'orphaned', ended_at = ?, error_message = ?
         WHERE run_state IN ('pending', 'running')`,
      )
      .run(nowMs(), 'orchestrator restarted while run was in flight');
    if (result.changes > 0) {
      this.appendEvent({
        eventType: 'orchestrator.runs_left_by_dead_process',
        metadata: { count: result.changes },
      });
    }
  }

  listSandboxRunArtifacts(sandboxRunId: string): SandboxRunArtifactLink[] {
    const safeId = safeSandboxRunId(sandboxRunId);
    const artifactRoot = path.resolve(this.runsDir, safeId, 'artifacts');
    try {
      if (!statSync(artifactRoot).isDirectory()) return [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const links: SandboxRunArtifactLink[] = [];
    const visit = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.resolve(dir, entry.name);
        if (!isInsideDirectory(artifactRoot, absolute)) continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          visit(absolute, relative);
          continue;
        }
        if (!stat.isFile()) continue;
        links.push({
          name: relative,
          path: `runs/${safeId}/artifacts/${relative}`,
          url: `/dashboard/api/sandbox-runs/${encodeURIComponent(safeId)}/artifacts/${relative
            .split('/')
            .map((part) => encodeURIComponent(part))
            .join('/')}`,
          size_bytes: stat.size,
        });
      }
    };
    visit(artifactRoot, '');
    return links.sort((left, right) => left.name.localeCompare(right.name));
  }

  readSandboxRunArtifact(sandboxRunId: string, name: string): SandboxRunArtifactFile | undefined {
    const safeId = safeSandboxRunId(sandboxRunId);
    const artifact = this.listSandboxRunArtifacts(safeId).find((link) => link.name === name);
    if (!artifact) return undefined;
    const absolutePath = path.resolve(this.paths.dataPath, artifact.path);
    const artifactRoot = path.resolve(this.runsDir, safeId, 'artifacts');
    if (!isInsideDirectory(artifactRoot, absolutePath)) return undefined;
    return {
      ...artifact,
      content: readFileSync(absolutePath),
    };
  }

  writeSandboxRunArtifact(sandboxRunId: string, name: string, content: string | Buffer): string {
    const relativeName = safeRelativePath(name);
    const relativePath = path.join(
      'runs',
      safeSandboxRunId(sandboxRunId),
      'artifacts',
      relativeName,
    );
    const absolutePath = path.join(this.paths.dataPath, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
    return relativePath;
  }

  listPrompts(): Prompt[] {
    return (this.db.prepare('SELECT * FROM prompts ORDER BY repo, agent').all() as DbRow[]).map(
      mapPrompt,
    );
  }

  getPrompt(repo: string, agent: AgentKind): Prompt | undefined {
    const row = this.db
      .prepare('SELECT * FROM prompts WHERE repo = ? AND agent = ?')
      .get(repo.trim().toLowerCase(), agent) as DbRow | undefined;
    return row ? mapPrompt(row) : undefined;
  }

  upsertPrompt(input: {
    repo: string;
    agent: AgentKind;
    instructions: string;
    enabled?: boolean;
  }): Prompt {
    if (input.instructions.length > MAX_PROMPT_LENGTH) {
      throw new Error(`prompt guidance exceeds ${MAX_PROMPT_LENGTH} characters`);
    }
    const repo = input.repo.trim().toLowerCase();
    const enabled = input.enabled === false ? 0 : 1;
    // updated_at is the revision and the dashboard change marker; it must strictly
    // increase so same-millisecond writes don't collide on a shared value.
    const priorMax = Number(
      (
        this.db.prepare('SELECT MAX(updated_at) AS max_updated FROM prompts').get() as
          | DbRow
          | undefined
      )?.max_updated ?? 0,
    );
    const timestamp = Math.max(nowMs(), priorMax + 1);
    this.db
      .prepare(
        `INSERT INTO prompts (repo, agent, instructions, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, agent) DO UPDATE SET
           instructions = excluded.instructions,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(repo, input.agent, input.instructions, enabled, timestamp, timestamp);
    this.appendEvent({
      eventType: 'operator.prompt_saved',
      metadata: {
        repo,
        agent: input.agent,
        enabled: enabled === 1,
        length: input.instructions.length,
      },
    });
    const stored = this.getPrompt(repo, input.agent);
    if (!stored) throw new Error('prompt vanished after upsert');
    return stored;
  }

  deletePrompt(repo: string, agent: AgentKind): boolean {
    const normalizedRepo = repo.trim().toLowerCase();
    const result = this.db
      .prepare('DELETE FROM prompts WHERE repo = ? AND agent = ?')
      .run(normalizedRepo, agent);
    const deleted = result.changes > 0;
    if (deleted) {
      this.appendEvent({
        eventType: 'operator.prompt_deleted',
        metadata: { repo: normalizedRepo, agent },
      });
    }
    return deleted;
  }

  // resolvePromptOverrides answers the operator's guidance for a run, keyed by prompt
  // segment. The repo entry wins over the global '*', and a disabled or blank row is ignored
  // so the built-in guidance stays in force.
  resolvePromptOverrides(repo: string | undefined, agent: AgentKind): Record<string, string> {
    const pick = (row: Prompt | undefined): string | undefined =>
      row?.enabled && row.instructions.trim().length > 0 ? row.instructions : undefined;
    const normalizedRepo = (repo ?? '').trim().toLowerCase();
    // Payloads carry caller casing; the sentinel is skipped so a repo never
    // resolves against the global row twice.
    const repoOverride =
      normalizedRepo && normalizedRepo !== PROMPT_GLOBAL_REPO
        ? pick(this.getPrompt(normalizedRepo, agent))
        : undefined;
    const winner = repoOverride ?? pick(this.getPrompt(PROMPT_GLOBAL_REPO, agent));
    return winner ? { [EDITABLE_PROMPT_SEGMENT]: winner } : {};
  }

  // promptsVersion marks a change for the dashboard snapshot. It counts the rows
  // too, because deleting a non-latest row leaves MAX(updated_at) where it was and connected
  // dashboards would never see the delete.
  promptsVersion(): string {
    const row = this.db
      .prepare('SELECT COUNT(*) AS row_count, MAX(updated_at) AS changed_at FROM prompts')
      .get() as DbRow | undefined;
    return `${Number(row?.row_count ?? 0)}.${Number(row?.changed_at ?? 0)}`;
  }

  queryReadOnly(sql: string, params: SQLInputValue[] = []): unknown[] {
    const trimmed = sql.trim().replace(/;\s*$/, '');
    if (!/^(select|with|pragma)\b/i.test(trimmed)) {
      throw new Error('Only read-only SELECT, WITH, and PRAGMA statements are allowed');
    }
    if (/;\s*\S/.test(trimmed)) {
      throw new Error('Only a single SQL statement is allowed');
    }
    return this.db.prepare(trimmed).all(...params) as unknown[];
  }

  async backupNow(): Promise<string> {
    mkdirSync(this.backupsDir, { recursive: true });
    const safeTimestamp = iso(nowMs()).replace(/[:.]/g, '-');
    const target = path.join(this.backupsDir, `state-${safeTimestamp}.db`);
    try {
      await backup(this.db, target);
    } catch (error) {
      const failure = withBackupFailureContext(error, this.backupsDir, target);
      try {
        rmSync(target, { force: true, recursive: true });
        failure.partialTargetRemoved = true;
      } catch (cleanupError) {
        failure.partialTargetRemoved = false;
        failure.partialTargetRemovalCode = errorCode(cleanupError);
      }
      throw failure;
    }
    this.appendEvent({ eventType: 'orchestrator.backup_written', metadata: { path: target } });
    return target;
  }

  pruneBackups(retainCount: number): string[] {
    if (retainCount < 1) return [];
    const backups = readdirSync(this.backupsDir)
      .filter((file) => file.startsWith('state-') && file.endsWith('.db'))
      .map((file) => {
        const absolutePath = path.join(this.backupsDir, file);
        return { absolutePath, mtimeMs: statSync(absolutePath).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const removed: string[] = [];
    for (const backup of backups.slice(retainCount)) {
      rmSync(backup.absolutePath, { force: true });
      removed.push(backup.absolutePath);
    }
    if (removed.length > 0) {
      this.appendEvent({
        eventType: 'orchestrator.backups_deleted',
        metadata: { removed_count: removed.length },
      });
    }
    return removed;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // ------------------------------------------------------------- repository

  upsertRepository(fullName: string): Repository {
    const slug = fullName.toLowerCase();
    const timestamp = nowMs();
    this.db
      .prepare(
        `INSERT INTO repository (id, full_name, is_enabled, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(full_name) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run(randomUUID(), slug, timestamp, timestamp);
    const found = this.findRepositoryByFullName(slug);
    if (!found) throw new Error(`repository ${slug} missing after upsert`);
    return found;
  }

  getRepositoryById(id: string): Repository | undefined {
    const row = this.db.prepare('SELECT * FROM repository WHERE id = ?').get(id) as Row | undefined;
    return row ? toRepository(row) : undefined;
  }

  // findRepositoriesNamed answers by the half after the slash, which is how a person names
  // a repository when they do not write the owner.
  findRepositoriesNamed(name: string): Repository[] {
    const rows = this.db
      .prepare("SELECT * FROM repository WHERE substr(full_name, instr(full_name, '/') + 1) = ?")
      .all(name.trim().toLowerCase()) as Row[];
    return rows.map(toRepository);
  }

  findRepositoryByFullName(fullName: string): Repository | undefined {
    const row = this.db
      .prepare('SELECT * FROM repository WHERE full_name = ?')
      .get(fullName.toLowerCase()) as Row | undefined;
    return row ? toRepository(row) : undefined;
  }

  // --------------------------------------------------- discord conversation

  findDiscordConversation(conversationKey: string): DiscordConversation | undefined {
    const row = this.db
      .prepare('SELECT * FROM discord_conversation WHERE conversation_key = ?')
      .get(conversationKey) as Row | undefined;
    return row ? toDiscordConversation(row) : undefined;
  }

  // findDiscordConversationByThread answers which work a thread is about, which is how a
  // command run inside one knows what it was asked about without being told.
  findDiscordConversationByThread(threadId: string): DiscordConversation | undefined {
    const row = this.db
      .prepare('SELECT * FROM discord_conversation WHERE thread_id = ?')
      .get(threadId) as Row | undefined;
    return row ? toDiscordConversation(row) : undefined;
  }

  saveDiscordConversation(input: {
    conversationKey: string;
    threadId: string;
  }): DiscordConversation {
    this.db
      .prepare(
        `INSERT INTO discord_conversation (conversation_key, thread_id, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(conversation_key) DO NOTHING`,
      )
      .run(input.conversationKey, input.threadId, nowMs());
    const found = this.findDiscordConversation(input.conversationKey);
    if (!found) throw new Error(`discord conversation ${input.conversationKey} missing`);
    return found;
  }

  // ---------------------------------------------------------------- request

  createRequest(input: CreateRequestInput): RequestRouter {
    const id = randomUUID();
    const timestamp = nowMs();
    // A request that already carries its subject is born resolved: the Router
    // traverses that state without stopping, and only free text waits.
    const state: RequestRouterState = input.subjectType ? 'rr_resolved' : 'rr_pending';
    this.db
      .prepare(
        `INSERT INTO request_router (
           id, request_source, workflow_state, request_text, requester_external_id,
           reply_target_type, reply_target_id, repository_id,
           subject_type, subject_external_id, resolution_note,
           workflow_type, workflow_instance_id, consumed_at,
           last_state_checked_at, state_changed_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        input.requestSource,
        state,
        input.requestText ?? null,
        input.requesterExternalId ?? null,
        input.replyTargetType ?? null,
        input.replyTargetId ?? null,
        input.repositoryId ?? null,
        input.subjectType ?? null,
        input.subjectExternalId ?? null,
        timestamp,
        timestamp,
        timestamp,
      );
    return this.getRequest(id) as RequestRouter;
  }

  getRequest(id: string): RequestRouter | undefined {
    const row = this.db.prepare('SELECT * FROM request_router WHERE id = ?').get(id) as
      | Row
      | undefined;
    return row ? toRequest(row) : undefined;
  }

  setRequestState(id: string, state: RequestRouterState, input: ResolveRequestInput = {}): void {
    const timestamp = nowMs();
    this.db
      .prepare(
        `UPDATE request_router
         SET workflow_state = ?,
             repository_id = COALESCE(?, repository_id),
             subject_type = COALESCE(?, subject_type),
             subject_external_id = COALESCE(?, subject_external_id),
             resolution_note = COALESCE(?, resolution_note),
             sandbox_run_id = COALESCE(?, sandbox_run_id),
             state_changed_at = CASE WHEN workflow_state = ? THEN state_changed_at ELSE ? END,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        state,
        input.repositoryId ?? null,
        input.subjectType ?? null,
        input.subjectExternalId ?? null,
        input.resolutionNote ?? null,
        input.sandboxRunId ?? null,
        state,
        timestamp,
        timestamp,
        id,
      );
  }

  markRequestChecked(id: string): void {
    this.db
      .prepare('UPDATE request_router SET last_state_checked_at = ? WHERE id = ?')
      .run(nowMs(), id);
  }

  listRequestsDue(waits: Partial<Record<RequestRouterState, number>>): RequestRouter[] {
    return this.listDue('request_router', REQUEST_ROUTER_TERMINAL_STATES, waits, toRequest);
  }

  listOpenRequests(): RequestRouter[] {
    return this.listOpen('request_router', REQUEST_ROUTER_TERMINAL_STATES, toRequest);
  }

  // listUnconsumedRequests answers the asks about a subject no workflow has taken yet,
  // oldest first. This is the queue, so a non-empty answer is what "pending" means.
  listUnconsumedRequests(
    subjectType: SubjectType,
    subjectExternalId: string,
    repositoryId?: string,
  ): RequestRouter[] {
    // A pull request number only identifies a pull request within its
    // repository, so anything repository-scoped has to say which one.
    const rows = this.db
      .prepare(
        `SELECT * FROM request_router
         WHERE subject_type = ? AND subject_external_id = ? AND consumed_at IS NULL
           AND workflow_state != 'rr_unresolvable'
           AND (? IS NULL OR repository_id = ?)
         ORDER BY created_at ASC`,
      )
      .all(subjectType, subjectExternalId, repositoryId ?? null, repositoryId ?? null) as Row[];
    return rows.map(toRequest);
  }

  // markRequestConsumed records which instance answered an ask, and rewrites its repository
  // with the one the work opened in, which is where the ask actually landed.
  markRequestConsumed(
    id: string,
    workflowType: WorkflowType,
    workflowInstanceId: string,
    repositoryId: string,
  ): void {
    const timestamp = nowMs();
    this.db
      .prepare(
        `UPDATE request_router
         SET workflow_type = ?, workflow_instance_id = ?, repository_id = ?,
             consumed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(workflowType, workflowInstanceId, repositoryId, timestamp, timestamp, id);
  }

  // ----------------------------------------------------- linear_implementer

  // findLinearImplementerByIdentifier answers the ticket's row by the identifier a person
  // writes, which is what a conversation is filed under.
  findLinearImplementerByIdentifier(linearIssueIdentifier: string): LinearImplementer | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM linear_implementer WHERE linear_issue_identifier = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(linearIssueIdentifier.toUpperCase()) as Row | undefined;
    return row ? toLinearImplementer(row) : undefined;
  }

  // findLinearImplementerByPullRequest answers which ticket opened a pull request, which is
  // how work that started as a ticket keeps one conversation once the maintainer takes over.
  findLinearImplementerByPullRequest(
    repositoryId: string,
    pullRequestNumber: number,
  ): LinearImplementer | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM linear_implementer
         WHERE repository_id = ? AND pull_request_number = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(repositoryId, pullRequestNumber) as Row | undefined;
    return row ? toLinearImplementer(row) : undefined;
  }

  openLinearImplementer(input: OpenLinearImplementerInput): LinearImplementer {
    const existing = this.findOpenLinearImplementer(input.linearIssueId);
    if (existing) return existing;
    const id = randomUUID();
    const timestamp = nowMs();
    this.db
      .prepare(
        `INSERT INTO linear_implementer (
           id, request_router_id, workflow_state, repository_id, linear_issue_id,
           linear_issue_identifier, linear_session_id, prompt_context,
           pull_request_number, iteration_number, verified_commit_sha,
           verifier_verdict, verifier_issues, sandbox_run_id, needs_human_reason,
           last_state_checked_at, state_changed_at, created_at, updated_at
         ) VALUES (?, ?, 'li_pending', ?, ?, ?, ?, ?, NULL, 0, NULL, NULL,
                   NULL, NULL, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        input.requestRouterId ?? null,
        input.repositoryId,
        input.linearIssueId,
        input.linearIssueIdentifier,
        input.linearSessionId ?? null,
        input.promptContext ?? null,
        timestamp,
        timestamp,
        timestamp,
      );
    return this.getLinearImplementer(id) as LinearImplementer;
  }

  getLinearImplementer(id: string): LinearImplementer | undefined {
    const row = this.db.prepare('SELECT * FROM linear_implementer WHERE id = ?').get(id) as
      | Row
      | undefined;
    return row ? toLinearImplementer(row) : undefined;
  }

  private findOpenLinearImplementer(linearIssueId: string): LinearImplementer | undefined {
    const placeholders = LINEAR_IMPLEMENTER_TERMINAL_STATES.map(() => '?').join(', ');
    const row = this.db
      .prepare(
        `SELECT * FROM linear_implementer
         WHERE linear_issue_id = ? AND workflow_state NOT IN (${placeholders})`,
      )
      .get(linearIssueId, ...LINEAR_IMPLEMENTER_TERMINAL_STATES) as Row | undefined;
    return row ? toLinearImplementer(row) : undefined;
  }

  // findLinearImplementerByIssue answers the ticket's row whatever its state, so an entry
  // point can switch on an ending instead of mistaking it for a ticket never seen before.
  findLinearImplementerByIssue(linearIssueId: string): LinearImplementer | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM linear_implementer
         WHERE linear_issue_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(linearIssueId) as Row | undefined;
    return row ? toLinearImplementer(row) : undefined;
  }

  setLinearImplementerState(
    id: string,
    state: LinearImplementerState,
    fields: LinearImplementerFields = {},
  ): void {
    const timestamp = nowMs();
    this.db
      .prepare(
        `UPDATE linear_implementer
         SET workflow_state = ?,
             linear_session_id = COALESCE(?, linear_session_id),
             prompt_context = COALESCE(?, prompt_context),
             pull_request_number = COALESCE(?, pull_request_number),
             iteration_number = COALESCE(?, iteration_number),
             verified_commit_sha = COALESCE(?, verified_commit_sha),
             verifier_verdict = ?,
             verifier_issues = ?,
             sandbox_run_id = ?,
             needs_human_reason = ?,
             state_changed_at = CASE WHEN workflow_state = ? THEN state_changed_at ELSE ? END,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        state,
        fields.linearSessionId ?? null,
        fields.promptContext ?? null,
        fields.pullRequestNumber ?? null,
        fields.iterationNumber ?? null,
        fields.verifiedCommitSha ?? null,
        fields.verifierVerdict ?? null,
        fields.verifierIssues ?? null,
        fields.sandboxRunId ?? null,
        fields.needsHumanReason ?? null,
        state,
        timestamp,
        timestamp,
        id,
      );
  }

  markLinearImplementerChecked(id: string): void {
    this.db
      .prepare('UPDATE linear_implementer SET last_state_checked_at = ? WHERE id = ?')
      .run(nowMs(), id);
  }

  listLinearImplementersDue(
    waits: Partial<Record<LinearImplementerState, number>>,
  ): LinearImplementer[] {
    return this.listDue(
      'linear_implementer',
      LINEAR_IMPLEMENTER_TERMINAL_STATES,
      waits,
      toLinearImplementer,
    );
  }

  listOpenLinearImplementers(): LinearImplementer[] {
    return this.listOpen(
      'linear_implementer',
      LINEAR_IMPLEMENTER_TERMINAL_STATES,
      toLinearImplementer,
    );
  }

  // -------------------------------------------------------- fix_implementer

  openFixImplementer(input: OpenFixImplementerInput): FixImplementer {
    const existing = this.findOpenFixImplementer(input.findingFingerprint);
    if (existing) return existing;
    const id = randomUUID();
    const timestamp = nowMs();
    this.db
      .prepare(
        `INSERT INTO fix_implementer (
           id, log_reviewer_id, workflow_state, repository_id, finding_fingerprint,
           service_name, environment_name, finding_evidence,
           pull_request_number, verified_commit_sha, verifier_verdict, verifier_issues,
           sandbox_run_id, needs_human_reason, discard_reason,
           last_state_checked_at, state_changed_at, created_at, updated_at
         ) VALUES (?, ?, 'fi_pending', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL,
                   NULL, NULL, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        input.logReviewerId ?? null,
        input.repositoryId,
        input.findingFingerprint,
        input.serviceName ?? null,
        input.environmentName ?? null,
        input.findingEvidence ?? null,
        timestamp,
        timestamp,
        timestamp,
      );
    return this.getFixImplementer(id) as FixImplementer;
  }

  getFixImplementer(id: string): FixImplementer | undefined {
    const row = this.db.prepare('SELECT * FROM fix_implementer WHERE id = ?').get(id) as
      | Row
      | undefined;
    return row ? toFixImplementer(row) : undefined;
  }

  private findOpenFixImplementer(findingFingerprint: string): FixImplementer | undefined {
    const placeholders = FIX_IMPLEMENTER_TERMINAL_STATES.map(() => '?').join(', ');
    const row = this.db
      .prepare(
        `SELECT * FROM fix_implementer
         WHERE finding_fingerprint = ? AND workflow_state NOT IN (${placeholders})`,
      )
      .get(findingFingerprint, ...FIX_IMPLEMENTER_TERMINAL_STATES) as Row | undefined;
    return row ? toFixImplementer(row) : undefined;
  }

  findFixImplementerByFingerprint(findingFingerprint: string): FixImplementer | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM fix_implementer
         WHERE finding_fingerprint = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(findingFingerprint) as Row | undefined;
    return row ? toFixImplementer(row) : undefined;
  }

  setFixImplementerState(
    id: string,
    state: FixImplementerState,
    fields: FixImplementerFields = {},
  ): void {
    const timestamp = nowMs();
    this.db
      .prepare(
        `UPDATE fix_implementer
         SET workflow_state = ?,
             pull_request_number = COALESCE(?, pull_request_number),
             verified_commit_sha = COALESCE(?, verified_commit_sha),
             verifier_verdict = ?,
             verifier_issues = ?,
             sandbox_run_id = ?,
             needs_human_reason = ?,
             discard_reason = ?,
             state_changed_at = CASE WHEN workflow_state = ? THEN state_changed_at ELSE ? END,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        state,
        fields.pullRequestNumber ?? null,
        fields.verifiedCommitSha ?? null,
        fields.verifierVerdict ?? null,
        fields.verifierIssues ?? null,
        fields.sandboxRunId ?? null,
        fields.needsHumanReason ?? null,
        fields.discardReason ?? null,
        state,
        timestamp,
        timestamp,
        id,
      );
  }

  markFixImplementerChecked(id: string): void {
    this.db
      .prepare('UPDATE fix_implementer SET last_state_checked_at = ? WHERE id = ?')
      .run(nowMs(), id);
  }

  listFixImplementersDue(waits: Partial<Record<FixImplementerState, number>>): FixImplementer[] {
    return this.listDue(
      'fix_implementer',
      FIX_IMPLEMENTER_TERMINAL_STATES,
      waits,
      toFixImplementer,
    );
  }

  listOpenFixImplementers(): FixImplementer[] {
    return this.listOpen('fix_implementer', FIX_IMPLEMENTER_TERMINAL_STATES, toFixImplementer);
  }

  // listAbandonedFixImplementers answers the findings of one target whose fix a person
  // closed without merging.
  listAbandonedFixImplementers(scope: FixImplementerTargetScope): FixImplementer[] {
    return this.listFixImplementersForTarget(scope, "workflow_state = 'fi_abandoned'", []);
  }

  // listOpenFixImplementersForTarget answers the findings of one target still being
  // worked, which is what a finding under an unknown fingerprint is weighed against.
  listOpenFixImplementersForTarget(scope: FixImplementerTargetScope): FixImplementer[] {
    const placeholders = FIX_IMPLEMENTER_TERMINAL_STATES.map(() => '?').join(', ');
    return this.listFixImplementersForTarget(
      scope,
      `workflow_state NOT IN (${placeholders})`,
      FIX_IMPLEMENTER_TERMINAL_STATES,
    );
  }

  private listFixImplementersForTarget(
    scope: FixImplementerTargetScope,
    stateCondition: string,
    stateParams: readonly string[],
  ): FixImplementer[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM fix_implementer
         WHERE ${stateCondition}
           AND repository_id = ?
           AND COALESCE(service_name, '') = ?
           AND COALESCE(environment_name, '') = ?
         ORDER BY state_changed_at DESC`,
      )
      .all(
        ...stateParams,
        scope.repositoryId,
        scope.serviceName ?? '',
        scope.environmentName ?? '',
      ) as Row[];
    return rows.map(toFixImplementer);
  }

  // ------------------------------------------------------------ log_reviewer

  // openLogReviewer opens a scan. It always inserts, because two scans of one target are two
  // scans and there is nothing to converge on.
  openLogReviewer(input: OpenLogReviewerInput): LogReviewer {
    const id = randomUUID();
    const timestamp = nowMs();
    this.db
      .prepare(
        `INSERT INTO log_reviewer (
           id, request_router_id, workflow_state, repository_id, service_name,
           environment_name, finding_count, sandbox_run_id,
           last_state_checked_at, state_changed_at, created_at, updated_at
         ) VALUES (?, ?, 'lr_pending', ?, ?, ?, 0, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        input.requestRouterId ?? null,
        input.repositoryId,
        input.serviceName ?? null,
        input.environmentName ?? null,
        timestamp,
        timestamp,
        timestamp,
      );
    return this.getLogReviewer(id) as LogReviewer;
  }

  getLogReviewer(id: string): LogReviewer | undefined {
    const row = this.db.prepare('SELECT * FROM log_reviewer WHERE id = ?').get(id) as
      | Row
      | undefined;
    return row ? toLogReviewer(row) : undefined;
  }

  setLogReviewerState(id: string, state: LogReviewerState, fields: LogReviewerFields = {}): void {
    const timestamp = nowMs();
    this.db
      .prepare(
        `UPDATE log_reviewer
         SET workflow_state = ?,
             finding_count = COALESCE(?, finding_count),
             sandbox_run_id = ?,
             state_changed_at = CASE WHEN workflow_state = ? THEN state_changed_at ELSE ? END,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        state,
        fields.findingCount ?? null,
        fields.sandboxRunId ?? null,
        state,
        timestamp,
        timestamp,
        id,
      );
  }

  markLogReviewerChecked(id: string): void {
    this.db
      .prepare('UPDATE log_reviewer SET last_state_checked_at = ? WHERE id = ?')
      .run(nowMs(), id);
  }

  listLogReviewersDue(waits: Partial<Record<LogReviewerState, number>>): LogReviewer[] {
    return this.listDue('log_reviewer', LOG_REVIEWER_TERMINAL_STATES, waits, toLogReviewer);
  }

  // findLatestLogReviewerByTarget answers the last scan of a target whatever its state, which
  // is what tells a caller whether the window it would read was already read.
  findLatestLogReviewerByTarget(
    repositoryId: string,
    serviceName?: string,
    environmentName?: string,
  ): LogReviewer | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM log_reviewer
         WHERE repository_id = ? AND service_name IS ? AND environment_name IS ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(repositoryId, serviceName ?? null, environmentName ?? null) as Row | undefined;
    return row ? toLogReviewer(row) : undefined;
  }

  findOpenLogReviewerByTarget(
    repositoryId: string,
    serviceName?: string,
    environmentName?: string,
  ): LogReviewer | undefined {
    const placeholders = LOG_REVIEWER_TERMINAL_STATES.map(() => '?').join(', ');
    const row = this.db
      .prepare(
        `SELECT * FROM log_reviewer
         WHERE repository_id = ?
           AND service_name IS ?
           AND environment_name IS ?
           AND workflow_state NOT IN (${placeholders})`,
      )
      .get(
        repositoryId,
        serviceName ?? null,
        environmentName ?? null,
        ...LOG_REVIEWER_TERMINAL_STATES,
      ) as Row | undefined;
    return row ? toLogReviewer(row) : undefined;
  }

  listOpenLogReviewers(): LogReviewer[] {
    return this.listOpen('log_reviewer', LOG_REVIEWER_TERMINAL_STATES, toLogReviewer);
  }

  // ---------------------------------------------------------- pr_maintainer

  // openPrMaintainer answers the open instance for a pull request, creating it when there is
  // none. The unique index over non-terminal rows is what makes two concurrent webhooks
  // converge on one instance instead of opening two.
  openPrMaintainer(input: OpenPrMaintainerInput): PrMaintainer {
    const existing = this.findOpenPrMaintainer(input.repositoryId, input.pullRequestNumber);
    if (existing) return existing;
    const id = randomUUID();
    const timestamp = nowMs();
    this.db
      .prepare(
        `INSERT INTO pr_maintainer (
           id, request_router_id, workflow_state, repository_id, pull_request_number,
           attempt_count, last_acted_commit_sha, sandbox_run_id,
           needs_human_reason, last_state_checked_at, state_changed_at,
           created_at, updated_at
         ) VALUES (?, ?, 'prm_pending', ?, ?, 0, NULL, NULL, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        input.requestRouterId ?? null,
        input.repositoryId,
        input.pullRequestNumber,
        timestamp,
        timestamp,
        timestamp,
      );
    return this.getPrMaintainer(id) as PrMaintainer;
  }

  getPrMaintainer(id: string): PrMaintainer | undefined {
    const row = this.db.prepare('SELECT * FROM pr_maintainer WHERE id = ?').get(id) as
      | Row
      | undefined;
    return row ? toPrMaintainer(row) : undefined;
  }

  findOpenPrMaintainer(repositoryId: string, pullRequestNumber: number): PrMaintainer | undefined {
    const placeholders = PR_MAINTAINER_TERMINAL_STATES.map(() => '?').join(', ');
    const row = this.db
      .prepare(
        `SELECT * FROM pr_maintainer
         WHERE repository_id = ? AND pull_request_number = ?
           AND workflow_state NOT IN (${placeholders})`,
      )
      .get(repositoryId, pullRequestNumber, ...PR_MAINTAINER_TERMINAL_STATES) as Row | undefined;
    return row ? toPrMaintainer(row) : undefined;
  }

  findPrMaintainerByPullRequest(
    repositoryId: string,
    pullRequestNumber: number,
  ): PrMaintainer | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM pr_maintainer
         WHERE repository_id = ? AND pull_request_number = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(repositoryId, pullRequestNumber) as Row | undefined;
    return row ? toPrMaintainer(row) : undefined;
  }

  // setPrMaintainerState moves `state_changed_at` only when the state actually changes, so it
  // can be used to measure how long an instance has been where it is.
  setPrMaintainerState(
    id: string,
    state: PrMaintainerState,
    fields: {
      sandboxRunId?: string | null;
      lastActedCommitSha?: string;
      needsHumanReason?: string | null;
      attemptCount?: number;
    } = {},
  ): void {
    const timestamp = nowMs();
    this.db
      .prepare(
        `UPDATE pr_maintainer
         SET workflow_state = ?,
             sandbox_run_id = ?,
             last_acted_commit_sha = COALESCE(?, last_acted_commit_sha),
             needs_human_reason = ?,
             attempt_count = COALESCE(?, attempt_count),
             state_changed_at = CASE WHEN workflow_state = ? THEN state_changed_at ELSE ? END,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        state,
        fields.sandboxRunId ?? null,
        fields.lastActedCommitSha ?? null,
        fields.needsHumanReason ?? null,
        fields.attemptCount ?? null,
        state,
        timestamp,
        timestamp,
        id,
      );
  }

  markPrMaintainerChecked(id: string): void {
    this.db
      .prepare('UPDATE pr_maintainer SET last_state_checked_at = ? WHERE id = ?')
      .run(nowMs(), id);
  }

  listPrMaintainersDue(waits: Partial<Record<PrMaintainerState, number>>): PrMaintainer[] {
    return this.listDue('pr_maintainer', PR_MAINTAINER_TERMINAL_STATES, waits, toPrMaintainer);
  }

  listOpenPrMaintainers(): PrMaintainer[] {
    return this.listOpen('pr_maintainer', PR_MAINTAINER_TERMINAL_STATES, toPrMaintainer);
  }

  bumpThreadReply(prMaintainerId: string, reviewThreadId: string): PrMaintainerThread {
    const timestamp = nowMs();
    this.db
      .prepare(
        `INSERT INTO pr_maintainer_thread (
           id, pr_maintainer_id, review_thread_id, reply_count, created_at, updated_at
         ) VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(pr_maintainer_id, review_thread_id) DO UPDATE SET
           reply_count = pr_maintainer_thread.reply_count + 1,
           updated_at = excluded.updated_at`,
      )
      .run(randomUUID(), prMaintainerId, reviewThreadId, timestamp, timestamp);
    const row = this.db
      .prepare(
        'SELECT * FROM pr_maintainer_thread WHERE pr_maintainer_id = ? AND review_thread_id = ?',
      )
      .get(prMaintainerId, reviewThreadId) as Row;
    return toThread(row);
  }

  // ------------------------------------------------------------ sandbox_run

  startSandboxRun(input: StartSandboxRunInput): SandboxRun {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO sandbox_run (
           id, agent_name, run_state, workflow_type, workflow_instance_id,
           sandbox_session_id, cost_usd, error_message,
           started_at, ended_at
         ) VALUES (?, ?, 'pending', ?, ?, NULL, NULL, NULL, ?, NULL)`,
      )
      .run(id, input.agentName, input.workflowType, input.workflowInstanceId, nowMs());
    return this.getSandboxRun(id) as SandboxRun;
  }

  getSandboxRun(id: string): SandboxRun | undefined {
    const row = this.db.prepare('SELECT * FROM sandbox_run WHERE id = ?').get(id) as
      | Row
      | undefined;
    return row ? toRun(row) : undefined;
  }

  markSandboxRunRunning(id: string, sandboxSessionId?: string): void {
    this.db
      .prepare(
        `UPDATE sandbox_run
         SET run_state = 'running', sandbox_session_id = COALESCE(?, sandbox_session_id)
         WHERE id = ?`,
      )
      .run(sandboxSessionId ?? null, id);
  }

  finishSandboxRun(id: string, input: FinishSandboxRunInput): void {
    this.db
      .prepare(
        `UPDATE sandbox_run
           SET run_state = ?,
               sandbox_session_id = COALESCE(?, sandbox_session_id),
               cost_usd = ?,
               error_message = ?,
               ended_at = ?
         WHERE id = ?`,
      )
      .run(
        input.runState,
        input.sandboxSessionId ?? null,
        input.costUsd ?? null,
        input.errorMessage ?? null,
        nowMs(),
        id,
      );
  }

  listSandboxRuns(limit = 100, runState?: SandboxRunState): SandboxRun[] {
    const rows = runState
      ? (this.db
          .prepare(
            `SELECT * FROM sandbox_run WHERE run_state = ?
             ORDER BY started_at DESC LIMIT ?`,
          )
          .all(runState, limit) as Row[])
      : (this.db
          .prepare('SELECT * FROM sandbox_run ORDER BY started_at DESC LIMIT ?')
          .all(limit) as Row[]);
    return rows.map(toRun);
  }

  countRunningSandboxRuns(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS total FROM sandbox_run WHERE run_state IN ('pending', 'running')",
      )
      .get() as Row | undefined;
    return Number(row?.total ?? 0);
  }

  // countSandboxRunsByWorkflowAndState answers one row per pair that has runs, which is
  // what a gauge needs to publish a series per workflow.
  countSandboxRunsByWorkflowAndState(): Array<{
    workflowType: WorkflowType;
    runState: SandboxRunState;
    count: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT workflow_type, run_state, COUNT(*) AS total
         FROM sandbox_run GROUP BY workflow_type, run_state`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      workflowType: text(row.workflow_type) as WorkflowType,
      runState: text(row.run_state) as SandboxRunState,
      count: Number(row.total ?? 0),
    }));
  }

  listEventsForSandboxRun(sandboxRunId: string): EventLogEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM event_log WHERE sandbox_run_id = ? ORDER BY created_at ASC')
      .all(sandboxRunId) as Row[];
    return rows.map(toEvent);
  }

  listSandboxRunsForInstance(workflowType: WorkflowType, workflowInstanceId: string): SandboxRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sandbox_run
         WHERE workflow_type = ? AND workflow_instance_id = ?
         ORDER BY started_at ASC`,
      )
      .all(workflowType, workflowInstanceId) as Row[];
    return rows.map(toRun);
  }

  // --------------------------------------------------------- webhook_delivery

  // recordWebhookDelivery remembers one delivery, with what arrived, and answers false when
  // it was already seen, which is what makes a redelivery a no-op.
  recordWebhookDelivery(
    providerName: string,
    deliveryId: string,
    ttlMs: number,
    payload?: string,
  ): boolean {
    const timestamp = nowMs();
    this.db.prepare('DELETE FROM webhook_delivery WHERE expires_at <= ?').run(timestamp);
    try {
      this.db
        .prepare(
          `INSERT INTO webhook_delivery (id, provider_name, provider_delivery_id, payload, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), providerName, deliveryId, payload ?? null, timestamp + ttlMs);
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- event_log

  appendEvent(input: AppendEventInput): void {
    try {
      this.db
        .prepare(
          `INSERT INTO event_log (
             id, event_type, workflow_type, workflow_instance_id,
             sandbox_run_id, repository_id, metadata, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          input.eventType,
          input.workflowType ?? null,
          input.workflowInstanceId ?? null,
          input.sandboxRunId ?? null,
          input.repositoryId ?? null,
          eventMetadata(input),
          nowMs(),
        );
    } catch {
      // swallowed by design
    }
    this.mirrorSystemEvent(input);
  }

  // A system event has no instance to read it from, so it is also written to the
  // terminal, where a failure has to stand out without a reader querying the table.
  private mirrorSystemEvent(input: AppendEventInput): void {
    if (input.workflowInstanceId !== undefined) return;
    if (!/^(orchestrator|operator)\./.test(input.eventType)) return;
    const fields = input.metadata ?? {};
    if (
      /(_failed|_refused|_rejected|_invalid|_unknown)$|left_by_dead_process/.test(input.eventType)
    ) {
      this.log.warn(input.eventType, fields);
      return;
    }
    this.log.info(input.eventType, fields);
  }

  listEventsForInstance(workflowType: WorkflowType, workflowInstanceId: string): EventLogEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM event_log
         WHERE workflow_type = ? AND workflow_instance_id = ?
         ORDER BY created_at ASC`,
      )
      .all(workflowType, workflowInstanceId) as Row[];
    return rows.map(toEvent);
  }

  // ---------------------------------------------------------- operator reads

  listWorkflowInstances(
    filter: WorkflowInstanceFilter = {},
    page: PageRequest = { limit: 50 },
  ): Page<WorkflowInstanceSummary> {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.workflowType !== undefined) {
      conditions.push('workflow_type = ?');
      params.push(filter.workflowType);
    }
    if (filter.workflowTypes !== undefined) {
      // An empty list asks for no machine at all, which an IN clause cannot say.
      conditions.push(
        filter.workflowTypes.length === 0
          ? '1 = 0'
          : `workflow_type IN (${filter.workflowTypes.map(() => '?').join(', ')})`,
      );
      params.push(...filter.workflowTypes);
    }
    if (filter.workflowInstanceId !== undefined) {
      conditions.push('workflow_instance_id = ?');
      params.push(filter.workflowInstanceId);
    }
    if (filter.workflowState !== undefined) {
      conditions.push('workflow_state = ?');
      params.push(filter.workflowState);
    }
    if (filter.repositoryId !== undefined) {
      conditions.push('repository_id = ?');
      params.push(filter.repositoryId);
    }
    if (filter.subjectSearch !== undefined) {
      conditions.push('LOWER(subject_label) LIKE ?');
      params.push(`%${filter.subjectSearch.toLowerCase()}%`);
    }
    if (filter.open === true) {
      conditions.push(`workflow_state NOT IN (${TERMINAL_STATES.map(() => '?').join(', ')})`);
      params.push(...TERMINAL_STATES);
    }
    if (filter.awaitingAPerson !== undefined) {
      const operator = filter.awaitingAPerson ? 'IN' : 'NOT IN';
      conditions.push(
        `workflow_state ${operator} (${AWAITING_A_PERSON_STATES.map(() => '?').join(', ')})`,
      );
      params.push(...AWAITING_A_PERSON_STATES);
    }
    if (filter.changedSince !== undefined) {
      conditions.push('state_changed_at >= ?');
      params.push(filter.changedSince);
    }
    const cursor = decodeInstanceCursor(page.cursor);
    if (cursor) {
      conditions.push(
        '(state_changed_at < ? OR (state_changed_at = ? AND workflow_instance_id < ?))',
      );
      params.push(cursor.stateChangedAt, cursor.stateChangedAt, cursor.workflowInstanceId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM (${WORKFLOW_INSTANCE_UNION}) i ${where}
         ORDER BY state_changed_at DESC, workflow_instance_id DESC
         LIMIT ?`,
      )
      .all(...params, page.limit + 1) as Row[];
    return pageOf(rows, page.limit, toWorkflowInstanceSummary, (row) =>
      encodeInstanceCursor(Number(row.state_changed_at), text(row.workflow_instance_id)),
    );
  }

  getWorkflowInstance(
    workflowType: WorkflowType,
    workflowInstanceId: string,
  ): WorkflowInstanceSummary | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM (${WORKFLOW_INSTANCE_UNION})
         WHERE workflow_type = ? AND workflow_instance_id = ?`,
      )
      .get(workflowType, workflowInstanceId) as Row | undefined;
    return row ? toWorkflowInstanceSummary(row) : undefined;
  }

  // getWorkflowInstanceFields answers the row of that machine by its own column names,
  // which is what the detail shows without the surface knowing five tables.
  getWorkflowInstanceFields(
    workflowType: WorkflowType,
    workflowInstanceId: string,
  ): Record<string, SQLInputValue> | undefined {
    const row = this.db
      .prepare(`SELECT * FROM ${WORKFLOW_TABLES[workflowType]} WHERE id = ?`)
      .get(workflowInstanceId) as Row | undefined;
    return row;
  }

  // countWorkflowInstancesByState counts open instances only and never windows them,
  // because a window would hide what is still alive.
  countWorkflowInstancesByState(): WorkflowInstanceStateCount[] {
    const rows = this.db
      .prepare(
        `SELECT workflow_type, workflow_state, COUNT(*) AS instance_count
         FROM (${OPEN_WORKFLOW_INSTANCE_UNION})
         GROUP BY workflow_type, workflow_state`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      workflowType: row.workflow_type as WorkflowType,
      workflowState: text(row.workflow_state),
      instanceCount: Number(row.instance_count),
    }));
  }

  listFailedSandboxRuns(limit = 20, endedSince?: number): SandboxRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sandbox_run
         WHERE run_state IN ('failed', 'aborted', 'orphaned')
           AND (? IS NULL OR COALESCE(ended_at, started_at) >= ?)
         ORDER BY COALESCE(ended_at, started_at) DESC
         LIMIT ?`,
      )
      .all(endedSince ?? null, endedSince ?? null, limit) as Row[];
    return rows.map(toRun);
  }

  // countStateArrivals counts arrivals and not rows, because an instance only carries
  // the state it is in now.
  countStateArrivals(
    toStates: readonly string[],
    since: number,
    bucketMs: number,
  ): StateArrivalBucket[] {
    if (toStates.length === 0) return [];
    const placeholders = toStates.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT json_extract(metadata, '$.to_state') AS to_state,
                CAST(created_at / ? AS INTEGER) * ? AS bucket_start,
                COUNT(*) AS arrival_count
         FROM event_log
         WHERE event_type = 'workflow.state_changed'
           AND created_at >= ?
           AND json_extract(metadata, '$.to_state') IN (${placeholders})
         GROUP BY to_state, bucket_start
         ORDER BY bucket_start ASC`,
      )
      .all(bucketMs, bucketMs, since, ...toStates) as Row[];
    return rows.map((row) => ({
      toState: text(row.to_state),
      bucketStart: Number(row.bucket_start),
      arrivalCount: Number(row.arrival_count),
    }));
  }

  listEvents(filter: EventLogFilter = {}, page: PageRequest = { limit: 100 }): Page<EventLogEntry> {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.workflowType !== undefined) {
      conditions.push('workflow_type = ?');
      params.push(filter.workflowType);
    }
    if (filter.workflowInstanceId !== undefined) {
      conditions.push('workflow_instance_id = ?');
      params.push(filter.workflowInstanceId);
    }
    if (filter.sandboxRunId !== undefined) {
      conditions.push('sandbox_run_id = ?');
      params.push(filter.sandboxRunId);
    }
    if (filter.repositoryId !== undefined) {
      conditions.push('repository_id = ?');
      params.push(filter.repositoryId);
    }
    if (filter.eventTypePrefixes !== undefined && filter.eventTypePrefixes.length > 0) {
      conditions.push(`(${filter.eventTypePrefixes.map(() => 'event_type LIKE ?').join(' OR ')})`);
      params.push(...filter.eventTypePrefixes.map((prefix) => `${prefix}%`));
    }
    if (filter.since !== undefined) {
      conditions.push('created_at >= ?');
      params.push(filter.since);
    }
    const cursor = decodeEventCursor(page.cursor);
    if (cursor) {
      conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT id, event_type, workflow_type, workflow_instance_id, sandbox_run_id,
                repository_id,
                CASE
                  WHEN metadata IS NULL OR json_valid(metadata) = 0 THEN NULL
                  ELSE json_extract(metadata, '$.from_state')
                END AS from_state,
                CASE
                  WHEN metadata IS NULL OR json_valid(metadata) = 0 THEN NULL
                  ELSE json_extract(metadata, '$.to_state')
                END AS to_state,
                CASE
                  WHEN metadata IS NULL OR octet_length(metadata) <= ? THEN metadata
                  ELSE json_object('truncated', json('true'), 'original_size_bytes', octet_length(metadata))
                END AS metadata,
                created_at
         FROM event_log ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(EVENT_LIST_METADATA_MAX_BYTES, ...params, page.limit + 1) as Row[];
    return pageOf(rows, page.limit, toEvent, (row) =>
      encodeEventCursor(Number(row.created_at), text(row.id)),
    );
  }

  listRequests(
    filter: RequestFilter = {},
    page: PageRequest = { limit: 50 },
  ): Page<RequestSummary> {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.requestSource !== undefined) {
      conditions.push('rr.request_source = ?');
      params.push(filter.requestSource);
    }
    if (filter.since !== undefined) {
      conditions.push('rr.created_at >= ?');
      params.push(filter.since);
    }
    const cursor = decodeEventCursor(page.cursor);
    if (cursor) {
      conditions.push('(rr.created_at < ? OR (rr.created_at = ? AND rr.id < ?))');
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT rr.*, r.full_name AS repository_full_name
         FROM request_router rr
         LEFT JOIN repository r ON r.id = rr.repository_id
         ${where}
         ORDER BY rr.created_at DESC, rr.id DESC
         LIMIT ?`,
      )
      .all(...params, page.limit + 1) as Row[];
    return pageOf(rows, page.limit, toRequestSummary, (row) =>
      encodeEventCursor(Number(row.created_at), text(row.id)),
    );
  }

  listOurPullRequests(since: number): OurPullRequest[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (${PULL_REQUEST_UNION})
         WHERE created_at >= ?
         ORDER BY created_at DESC`,
      )
      .all(since) as Row[];
    const byPullRequest = new Map<string, OurPullRequest>();
    for (const row of rows) {
      const pullRequest = toOurPullRequest(row);
      const key = `${pullRequest.repositoryId}#${pullRequest.pullRequestNumber}`;
      const merged = mergePullRequestRow(byPullRequest.get(key), pullRequest);
      byPullRequest.set(key, merged);
    }
    return [...byPullRequest.values()].sort(
      (left, right) =>
        right.createdAt - left.createdAt || right.pullRequestNumber - left.pullRequestNumber,
    );
  }

  operatorSurfaceVersion(): string {
    const row = this.db
      .prepare(
        `SELECT (SELECT COALESCE(MAX(updated_at), 0) FROM (${WORKFLOW_INSTANCE_UPDATED_UNION})) AS instances,
                (SELECT COALESCE(MAX(COALESCE(ended_at, started_at)), 0) FROM sandbox_run) AS runs,
                (SELECT COALESCE(MAX(created_at), 0) FROM event_log) AS events`,
      )
      .get() as Row;
    return [
      Number(row.instances),
      Number(row.runs),
      Number(row.events),
      this.promptsVersion(),
    ].join('-');
  }

  // ------------------------------------------------------- shared traversals

  // The table name is interpolated because SQLite cannot parameterise it; every
  // caller passes a literal from this file, never anything from outside.
  private listOpen<T>(table: string, terminalStates: readonly string[], map: (row: Row) => T): T[] {
    const placeholders = terminalStates.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM ${table}
         WHERE workflow_state NOT IN (${placeholders})
         ORDER BY created_at ASC`,
      )
      .all(...terminalStates) as Row[];
    return rows.map(map);
  }

  // Instances the periodic check has to look at: never checked, or checked
  // longer ago than the wait their state asks for.
  private listDue<
    S extends string,
    T extends { workflowState: S; lastStateCheckedAt: number | null },
  >(
    table: string,
    terminalStates: readonly string[],
    waits: Partial<Record<S, number>>,
    map: (row: Row) => T,
  ): T[] {
    const now = nowMs();
    const placeholders = terminalStates.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM ${table}
         WHERE workflow_state NOT IN (${placeholders})
         ORDER BY state_changed_at ASC`,
      )
      .all(...terminalStates) as Row[];
    return rows.map(map).filter((instance) => {
      const wait = waits[instance.workflowState];
      if (wait === undefined) return false;
      return now - (instance.lastStateCheckedAt ?? 0) >= wait;
    });
  }
}

function withBackupFailureContext(
  error: unknown,
  backupDir: string,
  backupTargetPath: string,
): SqliteBackupFailure {
  const contextual: SqliteBackupFailure =
    error instanceof Error
      ? (error as SqliteBackupFailure)
      : (new Error(String(error)) as SqliteBackupFailure);
  contextual.backupDir = backupDir;
  contextual.backupTargetPath = backupTargetPath;
  if (contextual.code === undefined) {
    const code = errorCode(error);
    if (code !== undefined) contextual.code = code;
  }
  return contextual as SqliteBackupFailure;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function mapPrompt(row: DbRow): Prompt {
  return {
    repo: String(row.repo),
    agent: row.agent as AgentKind,
    instructions: String(row.instructions),
    enabled: Number(row.enabled) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function transitionState(metadata: SQLInputValue, key: string): string | null {
  if (typeof metadata !== 'string') return null;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    return typeof parsed[key] === 'string' ? parsed[key] : null;
  } catch {
    return null;
  }
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeSandboxRunId(sandboxRunId: string): string {
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sandboxRunId)
  ) {
    return sandboxRunId;
  }
  throw new Error(`Unsafe sandbox run id: ${sandboxRunId}`);
}

function safeRelativePath(name: string): string {
  const normalized = path.normalize(name);
  if (
    path.isAbsolute(normalized) ||
    normalized.startsWith('..') ||
    normalized.includes(`${path.sep}..${path.sep}`)
  ) {
    throw new Error(`Unsafe artifact path: ${name}`);
  }
  return normalized;
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function text(value: SQLInputValue): string {
  return String(value);
}

function nullableText(value: SQLInputValue): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toRepository(row: Row): Repository {
  return {
    id: text(row.id),
    fullName: text(row.full_name),
    isEnabled: Number(row.is_enabled) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toDiscordConversation(row: Row): DiscordConversation {
  return {
    conversationKey: text(row.conversation_key),
    threadId: text(row.thread_id),
    createdAt: Number(row.created_at),
  };
}

function toRequest(row: Row): RequestRouter {
  return {
    id: text(row.id),
    requestSource: text(row.request_source) as RequestSource,
    workflowState: text(row.workflow_state) as RequestRouterState,
    requestText: nullableText(row.request_text),
    requesterExternalId: nullableText(row.requester_external_id),
    replyTargetType: nullableText(row.reply_target_type) as ReplyTargetType | null,
    replyTargetId: nullableText(row.reply_target_id),
    repositoryId: nullableText(row.repository_id),
    subjectType: nullableText(row.subject_type) as SubjectType | null,
    subjectExternalId: nullableText(row.subject_external_id),
    resolutionNote: nullableText(row.resolution_note),
    workflowType: nullableText(row.workflow_type) as WorkflowType | null,
    workflowInstanceId: nullableText(row.workflow_instance_id),
    consumedAt: nullableNumber(row.consumed_at),
    sandboxRunId: nullableText(row.sandbox_run_id),
    lastStateCheckedAt: nullableNumber(row.last_state_checked_at),
    stateChangedAt: Number(row.state_changed_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toLinearImplementer(row: Row): LinearImplementer {
  return {
    id: text(row.id),
    requestRouterId: nullableText(row.request_router_id),
    workflowState: text(row.workflow_state) as LinearImplementerState,
    repositoryId: text(row.repository_id),
    linearIssueId: text(row.linear_issue_id),
    linearIssueIdentifier: text(row.linear_issue_identifier),
    linearSessionId: nullableText(row.linear_session_id),
    promptContext: nullableText(row.prompt_context),
    pullRequestNumber: nullableNumber(row.pull_request_number),
    iterationNumber: Number(row.iteration_number),
    verifiedCommitSha: nullableText(row.verified_commit_sha),
    verifierVerdict: nullableText(row.verifier_verdict) as VerifierVerdict | null,
    verifierIssues: nullableText(row.verifier_issues),
    sandboxRunId: nullableText(row.sandbox_run_id),
    needsHumanReason: nullableText(row.needs_human_reason),
    lastStateCheckedAt: nullableNumber(row.last_state_checked_at),
    stateChangedAt: Number(row.state_changed_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toFixImplementer(row: Row): FixImplementer {
  return {
    id: text(row.id),
    logReviewerId: nullableText(row.log_reviewer_id),
    workflowState: text(row.workflow_state) as FixImplementerState,
    repositoryId: text(row.repository_id),
    findingFingerprint: text(row.finding_fingerprint),
    serviceName: nullableText(row.service_name),
    environmentName: nullableText(row.environment_name),
    findingEvidence: nullableText(row.finding_evidence),
    pullRequestNumber: nullableNumber(row.pull_request_number),
    verifiedCommitSha: nullableText(row.verified_commit_sha),
    verifierVerdict: nullableText(row.verifier_verdict) as VerifierVerdict | null,
    verifierIssues: nullableText(row.verifier_issues),
    sandboxRunId: nullableText(row.sandbox_run_id),
    needsHumanReason: nullableText(row.needs_human_reason),
    discardReason: nullableText(row.discard_reason),
    lastStateCheckedAt: nullableNumber(row.last_state_checked_at),
    stateChangedAt: Number(row.state_changed_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toLogReviewer(row: Row): LogReviewer {
  return {
    id: text(row.id),
    requestRouterId: nullableText(row.request_router_id),
    workflowState: text(row.workflow_state) as LogReviewerState,
    repositoryId: text(row.repository_id),
    serviceName: nullableText(row.service_name),
    environmentName: nullableText(row.environment_name),
    findingCount: Number(row.finding_count),
    sandboxRunId: nullableText(row.sandbox_run_id),
    lastStateCheckedAt: nullableNumber(row.last_state_checked_at),
    stateChangedAt: Number(row.state_changed_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toPrMaintainer(row: Row): PrMaintainer {
  return {
    id: text(row.id),
    requestRouterId: nullableText(row.request_router_id),
    workflowState: text(row.workflow_state) as PrMaintainerState,
    repositoryId: text(row.repository_id),
    pullRequestNumber: Number(row.pull_request_number),
    attemptCount: Number(row.attempt_count),
    lastActedCommitSha: nullableText(row.last_acted_commit_sha),
    sandboxRunId: nullableText(row.sandbox_run_id),
    needsHumanReason: nullableText(row.needs_human_reason),
    lastStateCheckedAt: nullableNumber(row.last_state_checked_at),
    stateChangedAt: Number(row.state_changed_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toThread(row: Row): PrMaintainerThread {
  return {
    id: text(row.id),
    prMaintainerId: text(row.pr_maintainer_id),
    reviewThreadId: text(row.review_thread_id),
    replyCount: Number(row.reply_count),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toRun(row: Row): SandboxRun {
  return {
    id: text(row.id),
    agentName: text(row.agent_name),
    runState: text(row.run_state) as SandboxRunState,
    workflowType: text(row.workflow_type) as WorkflowType,
    workflowInstanceId: text(row.workflow_instance_id),
    sandboxSessionId: nullableText(row.sandbox_session_id),
    costUsd: nullableNumber(row.cost_usd),
    errorMessage: nullableText(row.error_message),
    startedAt: Number(row.started_at),
    endedAt: nullableNumber(row.ended_at),
  };
}

function eventMetadata(input: AppendEventInput): string | null {
  const transition =
    input.fromState === undefined && input.toState === undefined
      ? undefined
      : { from_state: input.fromState ?? null, to_state: input.toState ?? null };
  if (input.metadata === undefined && !transition) return null;
  return JSON.stringify({ ...input.metadata, ...transition });
}

function toEvent(row: Row): EventLogEntry {
  const fromState = nullableText(row.from_state);
  const toState = nullableText(row.to_state);
  return {
    id: text(row.id),
    eventType: text(row.event_type),
    workflowType: nullableText(row.workflow_type) as WorkflowType | null,
    workflowInstanceId: nullableText(row.workflow_instance_id),
    sandboxRunId: nullableText(row.sandbox_run_id),
    repositoryId: nullableText(row.repository_id),
    fromState: fromState ?? transitionState(row.metadata, 'from_state'),
    toState: toState ?? transitionState(row.metadata, 'to_state'),
    metadata: nullableText(row.metadata),
    createdAt: Number(row.created_at),
  };
}

function pageOf<T>(
  rows: Row[],
  limit: number,
  map: (row: Row) => T,
  cursorOf: (row: Row) => string,
): Page<T> {
  const rowsInPage = rows.slice(0, limit);
  const last = rowsInPage.at(-1);
  return {
    rows: rowsInPage.map(map),
    nextCursor: rows.length > limit && last ? cursorOf(last) : null,
  };
}

function encodeInstanceCursor(stateChangedAt: number, workflowInstanceId: string): string {
  return `${stateChangedAt}:${workflowInstanceId}`;
}

function decodeInstanceCursor(
  cursor: string | undefined,
): { stateChangedAt: number; workflowInstanceId: string } | undefined {
  const parts = splitCursor(cursor);
  return parts ? { stateChangedAt: parts.at, workflowInstanceId: parts.id } : undefined;
}

function encodeEventCursor(createdAt: number, id: string): string {
  return `${createdAt}:${id}`;
}

function decodeEventCursor(
  cursor: string | undefined,
): { createdAt: number; id: string } | undefined {
  const parts = splitCursor(cursor);
  return parts ? { createdAt: parts.at, id: parts.id } : undefined;
}

// migrateStateChecks widens the CHECK of a table an older database created narrower, and
// with it the partial indexes that name the same states.
function migrateStateChecks(db: DatabaseSync, schema: string): void {
  const stale = Object.entries(STATE_CHECK_MIGRATIONS).filter(([table, state]) => {
    const sql = schemaSql(db, 'table', table);
    return sql !== undefined && !sql.includes(state);
  });
  if (stale.length === 0) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [table] of stale) rebuildTable(db, table, createTableSqlOf(schema, table));
    for (const [table, state] of stale) dropStaleIndexes(db, table, state);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  // Dropping the table took its indexes with it, and the schema is what puts them back.
  db.exec(schema);
}

function rebuildTable(db: DatabaseSync, table: string, createSql: string): void {
  const rebuilt = `${table}__rebuilt`;
  db.exec(`DROP TABLE IF EXISTS ${rebuilt}`);
  db.exec(createSql.replace(/CREATE TABLE (IF NOT EXISTS )?\w+/, `CREATE TABLE ${rebuilt}`));
  // Only the columns both shapes carry, so a rebuild survives a column added meanwhile.
  const wanted = new Set(columnsOf(db, rebuilt));
  const columns = columnsOf(db, table)
    .filter((column) => wanted.has(column))
    .join(', ');
  db.exec(`INSERT INTO ${rebuilt} (${columns}) SELECT ${columns} FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${rebuilt} RENAME TO ${table}`);
}

// A partial index whose WHERE predates the state would count a dismissed instance as open,
// so it goes and the schema recreates it.
function dropStaleIndexes(db: DatabaseSync, table: string, state: string): void {
  const rows = db
    .prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = ?")
    .all(table) as Row[];
  for (const row of rows) {
    const sql = typeof row.sql === 'string' ? row.sql : '';
    if (sql === '' || sql.includes(state)) continue;
    db.exec(`DROP INDEX ${text(row.name)}`);
  }
}

// createTableSqlOf reads a table's statement out of schema.sql, which is what keeps the
// rebuilt shape identical to the declared one.
function createTableSqlOf(schema: string, table: string): string {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start === -1) throw new Error(`schema declares no table ${table}`);
  const end = schema.indexOf('\n);', start);
  if (end === -1) throw new Error(`schema never closes the statement for ${table}`);
  return schema.slice(start, end + 3);
}

function columnsOf(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
  return rows.map((row) => text(row.name));
}

function schemaSql(db: DatabaseSync, type: 'index' | 'table', name: string): string | undefined {
  const row = db
    .prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?')
    .get(type, name) as Row | undefined;
  return typeof row?.sql === 'string' ? row.sql : undefined;
}

// splitCursor reads a cursor the operator can edit in the URL, so an unreadable one
// reads as no cursor.
function splitCursor(cursor: string | undefined): { at: number; id: string } | undefined {
  if (cursor === undefined) return undefined;
  const separator = cursor.indexOf(':');
  if (separator <= 0) return undefined;
  const at = Number(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  if (!Number.isFinite(at) || id.length === 0) return undefined;
  return { at, id };
}

function toWorkflowInstanceSummary(row: Row): WorkflowInstanceSummary {
  return {
    workflowType: row.workflow_type as WorkflowType,
    workflowInstanceId: text(row.workflow_instance_id),
    workflowState: text(row.workflow_state),
    repositoryId: nullableText(row.repository_id),
    repositoryFullName: nullableText(row.repository_full_name),
    subjectKind: row.subject_kind as WorkflowSubjectKind,
    subjectLabel: nullableText(row.subject_label) ?? text(row.workflow_instance_id),
    pullRequestNumber: nullableNumber(row.pull_request_number),
    attemptCount: nullableNumber(row.attempt_count),
    iterationNumber: nullableNumber(row.iteration_number),
    needsHumanReason: nullableText(row.needs_human_reason),
    sandboxRunId: nullableText(row.sandbox_run_id),
    sandboxRunCount: Number(row.sandbox_run_count),
    lastRunState: (nullableText(row.last_run_state) as SandboxRunState | null) ?? null,
    lastRunEndedAt: nullableNumber(row.last_run_ended_at),
    stateChangedAt: Number(row.state_changed_at),
    createdAt: Number(row.created_at),
  };
}

function toRequestSummary(row: Row): RequestSummary {
  return {
    ...toRequest(row),
    repositoryFullName: nullableText(row.repository_full_name),
  };
}

function toOurPullRequest(row: Row): OurPullRequest {
  const workflowType = row.workflow_type as WorkflowType;
  const openedByUs = Number(row.opened_by_us) === 1;
  return {
    repositoryId: text(row.repository_id),
    repositoryFullName: text(row.repository_full_name),
    pullRequestNumber: Number(row.pull_request_number),
    workflowType,
    workflowInstanceId: text(row.workflow_instance_id),
    workflowState: text(row.workflow_state),
    openedByWorkflowType: openedByUs ? workflowType : null,
    openedByWorkflowInstanceId: openedByUs ? text(row.workflow_instance_id) : null,
    createdAt: Number(row.created_at),
    finishedAt: Number(row.state_changed_at),
  };
}

// mergePullRequestRow takes the state from the machine that follows the pull request
// and the origin from the machine that opened it.
function mergePullRequestRow(
  existing: OurPullRequest | undefined,
  incoming: OurPullRequest,
): OurPullRequest {
  if (!existing) return incoming;
  const follower = existing.workflowType === 'pr_maintainer' ? existing : incoming;
  const opener = existing.openedByWorkflowType !== null ? existing : incoming;
  return {
    ...follower,
    openedByWorkflowType: opener.openedByWorkflowType,
    openedByWorkflowInstanceId: opener.openedByWorkflowInstanceId,
    createdAt: Math.min(existing.createdAt, incoming.createdAt),
  };
}
