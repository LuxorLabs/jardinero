import { useState } from 'react';
import type {
  OverviewWindowKey,
  SandboxRunDetailResponse,
  SandboxRunRow,
  WorkflowInstanceDetailResponse,
  WorkflowInstanceListResponse,
  WorkflowInstanceRow,
} from '@shared';
import { DetailGrid, DetailSection, SectionHeading, Workspace } from '@/components/layout';
import { EventTimeline } from '@/components/EventTimeline';
import { StatusPill } from '@/components/StatusPill';
import { DEFAULT_WINDOW, WindowPicker } from '@/components/WindowPicker';
import { WorkflowInstanceActions } from '@/components/WorkflowInstanceActions';
import { postJson, readJsonBody } from '@/lib/api';
import { formatDuration, formatNumber, formatRelativeTime, formatTimestamp } from '@/lib/format';
import { useDashboardResource } from '@/lib/hooks';
import { operationHref } from '@/lib/links';
import { RUN_STATE_PILL, TONE_PILL } from '@/lib/tone';
import { shortId } from '@/tabs/EventsTab';
import { cn } from '@/lib/utils';

const WORKFLOW_FILTERS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Every workflow' },
  { value: 'linear_implementer', label: 'LinearImplementer' },
  { value: 'fix_implementer', label: 'FixImplementer' },
  { value: 'log_reviewer', label: 'LogReviewer' },
  { value: 'pr_maintainer', label: 'PrMaintainer' },
];

export function OperationTab() {
  const [workflowType, setWorkflowType] = useState('');
  const [subject, setSubject] = useState(() => searchParam('subject') ?? '');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [selectedWindow, setSelectedWindow] = useState<OverviewWindowKey>(DEFAULT_WINDOW);
  // A deep link names one instance, and optionally the run inside it, so a link from
  // an event lands on the row it is about however old that row is.
  const [focusedInstanceId, setFocusedInstanceId] = useState(() =>
    searchParam('workflow_instance_id'),
  );
  const [focusedRunId] = useState(() => searchParam('sandbox_run_id'));
  const [openInstanceId, setOpenInstanceId] = useState<string | null>(focusedInstanceId);

  const query = new URLSearchParams();
  if (focusedInstanceId) {
    query.set('workflow_instance_id', focusedInstanceId);
  } else {
    query.set('window', selectedWindow);
    if (workflowType) query.set('workflow_type', workflowType);
    if (subject) query.set('subject', subject);
    if (attentionOnly) query.set('attention', 'true');
  }
  const list = useDashboardResource<WorkflowInstanceListResponse>(
    `/dashboard/api/workflow-instances?${query.toString()}`,
    'instance list refresh failed',
  );

  return (
    <Workspace tab="operation">
      <SectionHeading
        title="Operation"
        description="One row per workflow instance, its sandbox runs underneath, and the stream of the run you open."
        right={
          focusedInstanceId ? (
            <div className="flex items-center gap-2 text-[13px]">
              <span className="text-muted-foreground">
                One instance, linked to: <span className="font-mono">{shortId(focusedInstanceId)}</span>
              </span>
              <button
                type="button"
                onClick={() => setFocusedInstanceId(null)}
                className="h-8 rounded-md border border-control bg-card px-2.5 font-bold"
              >
                Show every instance
              </button>
            </div>
          ) : (
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder="Reference: ENG-61, #4688, owner/repo"
              aria-label="Search reference"
              className="h-8 rounded-md border border-input bg-background px-2.5 text-[13px]"
            />
            <select
              value={workflowType}
              onChange={(event) => setWorkflowType(event.target.value)}
              aria-label="Filter by workflow"
              className="h-8 rounded-md border border-input bg-background px-2 text-[13px]"
            >
              {WORKFLOW_FILTERS.map((filter) => (
                <option key={filter.value} value={filter.value}>
                  {filter.label}
                </option>
              ))}
            </select>
            <WindowPicker window={selectedWindow} onChange={setSelectedWindow} />
            <label className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <input
                type="checkbox"
                checked={attentionOnly}
                onChange={(event) => setAttentionOnly(event.target.checked)}
              />
              Requires attention
            </label>
          </div>
          )
        }
      />

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="bg-table-header text-left text-muted-foreground">
              <th className="p-2">Reference</th>
              <th className="p-2">Workflow</th>
              <th className="p-2">Workflow instance</th>
              <th className="p-2">State</th>
              <th className="p-2">Last state change</th>
              <th className="p-2">Attempts</th>
              <th className="p-2">Sandbox runs</th>
              <th className="p-2">Latest run</th>
            </tr>
          </thead>
          <tbody>
            {(list?.instances ?? []).map((instance) => (
              <InstanceRows
                key={instance.workflow_instance_id}
                instance={instance}
                initialRunId={
                  instance.workflow_instance_id === focusedInstanceId ? focusedRunId : null
                }
                open={openInstanceId === instance.workflow_instance_id}
                onToggle={() =>
                  setOpenInstanceId(
                    openInstanceId === instance.workflow_instance_id
                      ? null
                      : instance.workflow_instance_id,
                  )
                }
              />
            ))}
          </tbody>
        </table>
      </div>

      {list?.instances.length === 0 && (
        <p className="text-[13px] text-muted-foreground">No instance matches this filter.</p>
      )}

      {list?.page.next_cursor && (
        <p className="text-[13px] text-muted-foreground">
          Only the newest instances of this window are listed. Narrow the window or the filters to
          reach the ones behind them.
        </p>
      )}
    </Workspace>
  );
}

function InstanceRows({
  instance,
  initialRunId,
  open,
  onToggle,
}: {
  instance: WorkflowInstanceRow;
  initialRunId: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          'cursor-pointer border-border border-t hover:bg-muted',
          instance.requires_attention && 'border-l-4 border-l-danger-border',
        )}
      >
        <td className="max-w-[320px] p-2 font-mono">
          <span aria-hidden="true" className="mr-1.5 text-muted-foreground">
            {open ? '▾' : '▸'}
          </span>
          {instance.subject.url ? (
            <a
              href={instance.subject.url}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => event.stopPropagation()}
              title={instance.subject.label}
              className="underline"
            >
              {instance.subject.label}
            </a>
          ) : (
            <span title={instance.subject.label}>{instance.subject.label}</span>
          )}
        </td>
        <td className="p-2 whitespace-nowrap">{instance.workflow_label}</td>
        <td className="p-2 font-mono whitespace-nowrap text-muted-foreground">
          {/* The link an operator copies to hand this one instance to somebody outside
              the dashboard. */}
          <a
            href={operationHref(instance.workflow_instance_id)}
            onClick={(event) => event.stopPropagation()}
            title={instance.workflow_instance_id}
            className="underline"
          >
            {shortId(instance.workflow_instance_id)}
          </a>
        </td>
        <td className="flex flex-wrap items-center gap-2 p-2">
          <span title={instance.workflow_state}>
            <StatusPill status={TONE_PILL[instance.tone]} label={instance.state_label} />
          </span>
          {instance.requires_attention && instance.needs_human_reason && (
            <span className="font-mono text-[12px] text-danger-fg">
              {instance.needs_human_reason}
            </span>
          )}
        </td>
        <td
          className="p-2 font-mono whitespace-nowrap text-muted-foreground"
          title={formatRelativeTime(instance.state_changed_at)}
        >
          {formatTimestamp(instance.state_changed_at)}
        </td>
        <td className="p-2 font-mono whitespace-nowrap">{instance.attempts ?? '--'}</td>
        <td className="p-2 font-mono">{instance.sandbox_run_count}</td>
        <td className="p-2 font-mono whitespace-nowrap text-muted-foreground">
          {instance.last_run_state === null
            ? '--'
            : `${instance.last_run_state}${
                instance.last_run_ended_at === null
                  ? ''
                  : ` ${formatTimestamp(instance.last_run_ended_at)}`
              }`}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8} className="bg-muted p-0">
            <InstanceDetail instance={instance} initialRunId={initialRunId} />
          </td>
        </tr>
      )}
    </>
  );
}

function InstanceDetail({
  instance,
  initialRunId,
}: {
  instance: WorkflowInstanceRow;
  initialRunId: string | null;
}) {
  const [openRunId, setOpenRunId] = useState<string | null>(initialRunId);
  const detail = useDashboardResource<WorkflowInstanceDetailResponse>(
    `/dashboard/api/workflow-instances/${instance.workflow_type}/${instance.workflow_instance_id}`,
    'instance detail refresh failed',
  );
  const runs = detail?.sandbox_runs ?? [];

  return (
    <div className="grid border-border border-t lg:grid-cols-[minmax(300px,380px)_1fr]">
      <div className="grid content-start gap-2 border-border border-r p-3.5">
        <p className="font-extrabold text-[12px] text-muted-foreground uppercase">
          Details
        </p>
        <button
          type="button"
          onClick={() => setOpenRunId(null)}
          className={cn(
            'grid gap-1 rounded-md border border-border bg-card p-2.5 text-left',
            openRunId === null && 'border-selected-border bg-selected',
          )}
        >
          <span className="flex items-baseline justify-between gap-2">
            <span className="font-bold text-[13px]">Workflow</span>
            <span title={instance.workflow_state}>
              <StatusPill status={TONE_PILL[instance.tone]} label={instance.state_label} />
            </span>
          </span>
        </button>
        {runs.map((run) => (
          <button
            key={run.sandbox_run_id}
            type="button"
            onClick={() => setOpenRunId(run.sandbox_run_id)}
            className={cn(
              'grid gap-1 rounded-md border border-border bg-card p-2.5 text-left',
              openRunId === run.sandbox_run_id && 'border-selected-border bg-selected',
            )}
          >
            <span className="flex items-baseline justify-between gap-2">
              <span className="font-bold text-[13px]">Sandbox {run.agent_name}</span>
              <StatusPill status={RUN_STATE_PILL[run.run_state]} label={run.run_state} />
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {formatTimestamp(run.started_at)}
            </span>
          </button>
        ))}

      </div>

      {openRunId ? (
        <RunStream sandboxRunId={openRunId} />
      ) : (
        <InstanceTimeline instance={instance} detail={detail} />
      )}
    </div>
  );
}

function InstanceTimeline({
  instance,
  detail,
}: {
  instance: WorkflowInstanceRow;
  detail: WorkflowInstanceDetailResponse | null;
}) {
  return (
    <div className="grid content-start gap-3 p-3.5">
      <div className="flex items-start justify-between gap-3 border-border border-b pb-3">
        <div>
          <p className="font-extrabold text-[12px] text-muted-foreground uppercase">
            Workflow instance
          </p>
          <h3>{instance.subject.label}</h3>
        </div>
        {instance.requires_attention && <WorkflowInstanceActions instance={instance} />}
      </div>

      <DetailSection title="Instance">
        <DetailGrid
          rows={[
            ['Workflow', instance.workflow_label],
            ['State', instance.state_label],
            ['State changed', formatTimestamp(instance.state_changed_at)],
            ['Opened', formatTimestamp(instance.created_at)],
            ['Attempts', instance.attempts],
            ['Needs human', instance.needs_human_reason],
            ['Repository', instance.repository_full_name],
            ['Workflow instance id', instance.workflow_instance_id],
            ...Object.entries(detail?.fields ?? {})
              .filter(([key]) => key !== 'finding_count')
              .map(([key, value]) => [key, String(value)] as [string, string]),
          ]}
        />
      </DetailSection>

      {(detail?.asks ?? []).length > 0 && (
        <DetailSection title="What was asked">
          <ul className="m-0 grid list-none gap-2 p-0">
            {(detail?.asks ?? []).map((ask) => (
              <li key={ask.id} className="grid gap-1 rounded-md border border-border bg-card p-2.5">
                <span className="flex items-baseline justify-between gap-2.5 text-[12px] text-muted-foreground">
                  <span>
                    {ask.request_source}
                    {ask.requester ? ` · ${ask.requester}` : ''}
                  </span>
                  <span className="whitespace-nowrap">{formatTimestamp(ask.created_at)}</span>
                </span>
                {ask.request_text && <span className="wrap-anywhere">{ask.request_text}</span>}
                <span className="text-[12px] text-muted-foreground">{ask.outcome_label}</span>
              </li>
            ))}
          </ul>
        </DetailSection>
      )}

      <DetailSection title="Event Timeline">
        <EventTimeline events={detail?.events ?? []} />
      </DetailSection>
    </div>
  );
}

function RunStream({ sandboxRunId }: { sandboxRunId: string }) {
  const detail = useDashboardResource<SandboxRunDetailResponse>(
    `/dashboard/api/sandbox-runs/${sandboxRunId}`,
    'sandbox run refresh failed',
  );
  const run = detail?.run;

  return (
    <div className="grid content-start gap-3 p-3.5">
      <div className="flex items-start justify-between gap-3 border-border border-b pb-3">
        <div>
          <p className="font-extrabold text-[12px] text-muted-foreground uppercase">Run detail</p>
          <h3>{run === undefined ? 'Sandbox run' : `Sandbox ${run.agent_name}`}</h3>
        </div>
        {run && <KillButton run={run} />}
      </div>

      <DetailSection title="Run Status">
        <DetailGrid
          rows={[
            ['Target', run?.subject_label],
            ['State', run?.run_state],
            ['Duration', run && formatDuration(run.duration_ms)],
            ['Started', run && formatTimestamp(run.started_at)],
            ['Ended', run?.ended_at ? formatTimestamp(run.ended_at) : 'Still running'],
            ['Sandbox run id', sandboxRunId],
            ['Sandbox session', run?.sandbox_session_id],
            ['Workflow instance id', run?.workflow_instance_id],
          ]}
        />
      </DetailSection>

      {detail?.summary && (
        <DetailSection title="Agent Summary">
          <p className="wrap-anywhere text-slate leading-[1.45]">{detail.summary}</p>
        </DetailSection>
      )}

      {run?.error && (
        <DetailSection title="Error">
          <p className="m-0 wrap-anywhere rounded-md border border-danger-border bg-danger-bg px-3 py-2.5 text-danger-fg">
            {run.error}
          </p>
        </DetailSection>
      )}

      <DetailSection title="Artifacts">
        {detail !== null && detail.artifacts.length === 0 ? (
          <p className="text-muted-foreground">
            No artifacts are on disk for this run. A run whose files were pruned, or that ran
            before they were kept, reads this way.
          </p>
        ) : (
          <ul className="m-0 grid list-none gap-2 p-0">
            {(detail?.artifacts ?? []).map((artifact) => (
              <li
                key={artifact.name}
                className="flex items-baseline justify-between gap-2.5 rounded-md border border-border bg-card px-2.5 py-2"
              >
                <a href={artifact.url} target="_blank" rel="noreferrer">
                  {artifact.name}
                </a>
                <span className="whitespace-nowrap text-[12px] text-muted-foreground">
                  {formatNumber(artifact.size_bytes)} bytes
                </span>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>

      <DetailSection title="Event Timeline">
        <EventTimeline events={detail?.events ?? []} />
      </DetailSection>
    </div>
  );
}

function KillButton({ run }: { run: SandboxRunRow }) {
  const [message, setMessage] = useState('');
  if (run.run_state !== 'pending' && run.run_state !== 'running') return null;
  return (
    <span className="flex items-center gap-2">
      {message && <span className="text-[12px] text-muted-foreground">{message}</span>}
      <button
        type="button"
        className="h-8 rounded-md border border-danger-border bg-danger-bg px-2.5 font-bold text-[13px] text-danger-fg"
        onClick={async () => {
          const response = await postJson(`/dashboard/api/sandbox-runs/${run.sandbox_run_id}/kill`);
          const body = await readJsonBody<{ reason?: string }>(response);
          setMessage(response.ok ? 'killed' : (body.reason ?? 'could not kill it'));
        }}
      >
        Kill run
      </button>
    </span>
  );
}

// searchParam reads a deep link's parameter; the tab is server-routed, so the query
// string is only read when the page loads.
function searchParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}
