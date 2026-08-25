PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- global

CREATE TABLE IF NOT EXISTS repository (
  id                  TEXT PRIMARY KEY,
  full_name           TEXT NOT NULL UNIQUE CHECK (full_name = lower(full_name)),
  is_enabled          INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- ---------------------------------------------------------------- workflows

CREATE TABLE IF NOT EXISTS request_router (
  id                    TEXT PRIMARY KEY,
  request_source        TEXT NOT NULL CHECK (
    request_source IN ('discord', 'github', 'linear', 'cron', 'operator')
  ),
  workflow_state        TEXT NOT NULL CHECK (
    workflow_state IN ('rr_pending', 'rr_routing', 'rr_resolved', 'rr_unresolvable')
  ),
  request_text          TEXT,
  requester_external_id TEXT,
  reply_target_type     TEXT CHECK (
    reply_target_type IN ('discord_thread', 'github_comment', 'linear_session')
  ),
  reply_target_id       TEXT,
  repository_id         TEXT REFERENCES repository(id),
  subject_type          TEXT CHECK (
    subject_type IN ('linear_issue', 'pull_request', 'log_target')
  ),
  subject_external_id   TEXT,
  resolution_note       TEXT,
  workflow_type         TEXT,
  workflow_instance_id  TEXT,
  consumed_at           INTEGER,
  sandbox_run_id        TEXT,
  last_state_checked_at INTEGER,
  state_changed_at      INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_request_router_pending
  ON request_router (subject_type, subject_external_id, created_at)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS linear_implementer (
  id                    TEXT PRIMARY KEY,
  request_router_id     TEXT REFERENCES request_router(id),
  workflow_state        TEXT NOT NULL CHECK (
    workflow_state IN (
      'li_pending', 'li_implementing', 'li_verifying', 'li_needs_human',
      'li_waiting_pr', 'li_done', 'li_abandoned', 'li_dismissed'
    )
  ),
  repository_id         TEXT NOT NULL REFERENCES repository(id),
  linear_issue_id       TEXT NOT NULL,
  linear_issue_identifier TEXT NOT NULL,
  linear_session_id     TEXT,
  prompt_context        TEXT,
  pull_request_number   INTEGER,
  iteration_number      INTEGER NOT NULL DEFAULT 0,
  verified_commit_sha   TEXT,
  verifier_verdict      TEXT,
  verifier_issues       TEXT,
  sandbox_run_id        TEXT,
  needs_human_reason    TEXT,
  last_state_checked_at INTEGER,
  state_changed_at      INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

-- One open instance per ticket, so re-assigning while a pass is running joins
-- the pass instead of starting a second one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_linear_implementer_open
  ON linear_implementer (linear_issue_id)
  WHERE workflow_state NOT IN ('li_done', 'li_abandoned', 'li_dismissed');

CREATE INDEX IF NOT EXISTS idx_linear_implementer_due
  ON linear_implementer (workflow_state, last_state_checked_at)
  WHERE workflow_state NOT IN ('li_done', 'li_abandoned', 'li_dismissed');

CREATE TABLE IF NOT EXISTS log_reviewer (
  id                    TEXT PRIMARY KEY,
  request_router_id     TEXT REFERENCES request_router(id),
  workflow_state        TEXT NOT NULL CHECK (
    workflow_state IN ('lr_pending', 'lr_working', 'lr_done', 'lr_failed')
  ),
  repository_id         TEXT NOT NULL REFERENCES repository(id),
  service_name          TEXT,
  environment_name      TEXT,
  finding_count         INTEGER NOT NULL DEFAULT 0,
  sandbox_run_id        TEXT,
  last_state_checked_at INTEGER,
  state_changed_at      INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

-- No unique index: two scans of one target are two legitimate scans, unlike a
-- ticket or a pull request, which have one open instance each.
CREATE INDEX IF NOT EXISTS idx_log_reviewer_due
  ON log_reviewer (workflow_state, last_state_checked_at)
  WHERE workflow_state NOT IN ('lr_done', 'lr_failed');

-- One scan of a target at a time: two scans of the same target are two legitimate
-- scans, one after the other, not at once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_log_reviewer_open
  ON log_reviewer (repository_id, service_name, environment_name)
  WHERE workflow_state NOT IN ('lr_done', 'lr_failed');

CREATE TABLE IF NOT EXISTS fix_implementer (
  id                    TEXT PRIMARY KEY,
  log_reviewer_id       TEXT REFERENCES log_reviewer(id),
  workflow_state        TEXT NOT NULL CHECK (
    workflow_state IN (
      'fi_pending', 'fi_implementing', 'fi_verifying', 'fi_needs_human',
      'fi_discarded', 'fi_waiting_pr', 'fi_done', 'fi_abandoned', 'fi_dismissed'
    )
  ),
  repository_id         TEXT NOT NULL REFERENCES repository(id),
  finding_fingerprint   TEXT NOT NULL,
  service_name          TEXT,
  environment_name      TEXT,
  finding_evidence      TEXT,
  pull_request_number   INTEGER,
  verified_commit_sha   TEXT,
  verifier_verdict      TEXT,
  verifier_issues       TEXT,
  sandbox_run_id        TEXT,
  needs_human_reason    TEXT,
  discard_reason        TEXT,
  last_state_checked_at INTEGER,
  state_changed_at      INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

-- One open instance per finding, which is what stops the same error being fixed
-- twice because two scans saw it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fix_implementer_open
  ON fix_implementer (finding_fingerprint)
  WHERE workflow_state NOT IN ('fi_discarded', 'fi_done', 'fi_abandoned', 'fi_dismissed');

CREATE INDEX IF NOT EXISTS idx_fix_implementer_due
  ON fix_implementer (workflow_state, last_state_checked_at)
  WHERE workflow_state NOT IN ('fi_discarded', 'fi_done', 'fi_abandoned', 'fi_dismissed');

CREATE TABLE IF NOT EXISTS pr_maintainer (
  id                     TEXT PRIMARY KEY,
  request_router_id      TEXT REFERENCES request_router(id),
  workflow_state         TEXT NOT NULL CHECK (
    workflow_state IN (
      'prm_pending', 'prm_working', 'prm_waiting',
      'prm_attempts_exhausted', 'prm_merged', 'prm_closed', 'prm_dismissed'
    )
  ),
  repository_id          TEXT NOT NULL REFERENCES repository(id),
  pull_request_number    INTEGER NOT NULL,
  attempt_count          INTEGER NOT NULL DEFAULT 0,
  last_acted_commit_sha  TEXT,
  sandbox_run_id         TEXT,
  needs_human_reason     TEXT,
  last_state_checked_at  INTEGER,
  state_changed_at       INTEGER NOT NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

-- One open instance per pull request. This is what stops two webhooks arriving
-- together from opening two instances for the same PR.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pr_maintainer_open
  ON pr_maintainer (repository_id, pull_request_number)
  WHERE workflow_state NOT IN ('prm_merged', 'prm_closed', 'prm_dismissed');

-- Drives the periodic check: the sweep reads the instances that are due instead
-- of scanning every open one on each tick.
CREATE INDEX IF NOT EXISTS idx_pr_maintainer_due
  ON pr_maintainer (workflow_state, last_state_checked_at)
  WHERE workflow_state NOT IN ('prm_merged', 'prm_closed', 'prm_dismissed');

CREATE INDEX IF NOT EXISTS idx_pr_maintainer_state
  ON pr_maintainer (workflow_state, updated_at);

-- The reply cap per review thread has to survive between poll cycles.
CREATE TABLE IF NOT EXISTS pr_maintainer_thread (
  id               TEXT PRIMARY KEY,
  pr_maintainer_id TEXT NOT NULL REFERENCES pr_maintainer(id) ON DELETE CASCADE,
  review_thread_id TEXT NOT NULL,
  reply_count      INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pr_maintainer_thread
  ON pr_maintainer_thread (pr_maintainer_id, review_thread_id);

-- ---------------------------------------------------------------- execution

-- One execution of one agent in one sandbox. workflow_type + workflow_instance_id
-- say which workflow row it belongs to; there is no foreign key because the
-- parent can be any of the workflow tables.
CREATE TABLE IF NOT EXISTS sandbox_run (
  id                   TEXT PRIMARY KEY,
  agent_name           TEXT NOT NULL,
  run_state            TEXT NOT NULL CHECK (
    run_state IN (
      'pending', 'running', 'succeeded', 'failed',
      'aborted', 'orphaned', 'skipped'
    )
  ),
  workflow_type        TEXT NOT NULL,
  workflow_instance_id TEXT NOT NULL,
  sandbox_session_id   TEXT,
  cost_usd             REAL,
  error_message        TEXT,
  started_at           INTEGER NOT NULL,
  ended_at             INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sandbox_run_state ON sandbox_run (run_state);
CREATE INDEX IF NOT EXISTS idx_sandbox_run_instance
  ON sandbox_run (workflow_type, workflow_instance_id, started_at);

CREATE TABLE IF NOT EXISTS event_log (
  id                   TEXT PRIMARY KEY,
  event_type           TEXT NOT NULL,
  workflow_type        TEXT,
  workflow_instance_id TEXT,
  sandbox_run_id       TEXT REFERENCES sandbox_run(id),
  repository_id        TEXT REFERENCES repository(id),
  metadata             TEXT,
  created_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_log_instance
  ON event_log (workflow_type, workflow_instance_id, created_at);
CREATE INDEX IF NOT EXISTS idx_event_log_created ON event_log (created_at);
CREATE INDEX IF NOT EXISTS idx_event_log_feed ON event_log (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_event_log_arrivals
  ON event_log (json_extract(metadata, '$.to_state'), created_at);

CREATE INDEX IF NOT EXISTS idx_event_log_repository
  ON event_log (repository_id, created_at);

CREATE TABLE IF NOT EXISTS discord_conversation (
  conversation_key TEXT PRIMARY KEY,
  thread_id        TEXT NOT NULL,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_delivery (
  id                   TEXT PRIMARY KEY,
  provider_name        TEXT NOT NULL,
  provider_delivery_id TEXT NOT NULL,
  payload              TEXT,
  expires_at           INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_delivery
  ON webhook_delivery (provider_name, provider_delivery_id);
CREATE INDEX IF NOT EXISTS idx_webhook_delivery_expires
  ON webhook_delivery (expires_at);

-- ---------------------------------------------------------------------------
-- Operator prompt overrides
-- ---------------------------------------------------------------------------

-- Operator-editable guidance, replacing the editable segment of an agent's built-in
-- prompt at run start. Scope is either a lowercased 'owner/repo' or '*' for all repos;
-- repo text wins over global. Like the tables above, no SQL foreign keys: the length
-- cap and enum semantics are enforced in code so re-running schema.sql stays idempotent.
CREATE TABLE IF NOT EXISTS prompts (
  repo         TEXT NOT NULL CHECK (repo = lower(repo)),  -- 'owner/repo' or '*' for all repos
  agent        TEXT NOT NULL CHECK (agent IN (
    'log_reviewer', 'fix_implementer', 'pr_maintainer', 'linear_implementer',
    'linear_verifier', 'request_router'
  )),
  instructions TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (repo, agent)
);

