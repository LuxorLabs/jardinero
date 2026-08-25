# Capsule queries

Read-only queries for the orchestrator capsule (`POST /capsule/sql`). Timestamps are Unix milliseconds, so pass the start of the window as a number.

## What is running now

```sql
SELECT id, agent_name, workflow_type, run_state, started_at, sandbox_session_id
FROM sandbox_run
WHERE run_state IN ('pending', 'running')
ORDER BY started_at DESC;
```

## Recent runs

```sql
SELECT id, agent_name, workflow_type, run_state, cost_usd, started_at, ended_at, error_message
FROM sandbox_run
ORDER BY started_at DESC
LIMIT 100;
```

## Failed runs in a window

```sql
SELECT id, agent_name, workflow_type, error_message, started_at
FROM sandbox_run
WHERE run_state = 'failed'
  AND started_at >= ?
ORDER BY started_at DESC;
```

## Cost by workflow in a window

```sql
SELECT workflow_type, ROUND(COALESCE(SUM(cost_usd), 0), 4) AS known_cost_usd, COUNT(*) AS runs
FROM sandbox_run
WHERE started_at >= ?
GROUP BY workflow_type
ORDER BY known_cost_usd DESC;
```

`cost_usd` is `NULL` when the agent reported no parseable cost, so this sums what is known and never invents a zero.

## What is waiting for a person

```sql
SELECT 'linear_implementer' AS workflow_type, id, needs_human_reason, state_changed_at
FROM linear_implementer WHERE workflow_state = 'li_needs_human'
UNION ALL
SELECT 'fix_implementer', id, needs_human_reason, state_changed_at
FROM fix_implementer WHERE workflow_state = 'fi_needs_human'
UNION ALL
SELECT 'pr_maintainer', id, needs_human_reason, state_changed_at
FROM pr_maintainer WHERE workflow_state = 'prm_attempts_exhausted'
ORDER BY state_changed_at ASC;
```

## Pull requests we opened, and how they ended

```sql
SELECT r.full_name, pm.pull_request_number, pm.workflow_state, pm.attempt_count, pm.state_changed_at
FROM pr_maintainer pm
JOIN repository r ON r.id = pm.repository_id
WHERE pm.created_at >= ?
ORDER BY pm.created_at DESC;
```

## The history of one instance

```sql
SELECT created_at, event_type,
       json_extract(metadata, '$.from_state') AS from_state,
       json_extract(metadata, '$.to_state') AS to_state,
       json_extract(metadata, '$.message') AS message
FROM event_log
WHERE workflow_instance_id = ?
ORDER BY created_at ASC;
```
