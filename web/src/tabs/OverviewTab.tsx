import { type ReactNode, useState } from 'react';
import type {
  OverviewMetricKey,
  OverviewResponse,
  OverviewWindowKey,
  WorkflowInstanceRow,
  WorkflowMachineRow,
} from '@shared';
import { Panel, SectionHeading } from '@/components/layout';
import { StatusPill } from '@/components/StatusPill';
import { DEFAULT_WINDOW, WindowPicker } from '@/components/WindowPicker';
import { WorkflowInstanceActions } from '@/components/WorkflowInstanceActions';
import { formatNumber, formatRelativeTime, formatTimestamp } from '@/lib/format';
import { useDashboardResource } from '@/lib/hooks';
import { operationHref } from '@/lib/links';
import { RUN_STATE_PILL, TONE_PILL } from '@/lib/tone';

const METRIC_LABELS: Record<OverviewMetricKey, string> = {
  items_triaged: 'Items triaged',
  prs_opened: 'PRs opened',
  prs_merged: 'PRs merged',
  incidents_handled: 'Incidents handled',
};
const SCROLL_PANE = 'max-h-[22rem] overflow-y-auto';
const HEADER_CELL = 'sticky top-0 z-10 bg-table-header p-2';

export function OverviewTab() {
  const [window, setWindow] = useState<OverviewWindowKey>(DEFAULT_WINDOW);
  const data = useDashboardResource<OverviewResponse>(
    `/dashboard/api/overview?window=${window}`,
    'dashboard overview refresh failed',
  );
  const metrics = data?.metrics[window];

  return (
    <>
      <Panel>
        <SectionHeading
          title="Workflows"
          description="Open instances per state. Every count links into Operation filtered by it."
        />
        <div className="grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-3">
          {(data?.machines ?? []).map((machine) => (
            <MachineCard key={machine.workflow_type} machine={machine} />
          ))}
        </div>
      </Panel>

      <Panel>
        <SectionHeading
          title="Requires attention"
          description="Instances a person has to move, newest first. Retry runs the machine again; dismiss ends the instance."
        />
        <InstanceQueue
          instances={data?.attention ?? []}
          action={(instance) => <WorkflowInstanceActions instance={instance} />}
        />
        {data?.attention.length === 0 && (
          <p className="text-[13px] text-muted-foreground">Nothing is waiting for a person.</p>
        )}
      </Panel>

      <Panel>
        <SectionHeading
          title="In progress"
          description="Every open instance the machines are still moving, newest first. Each reference opens it in Operation."
        />
        <InstanceQueue instances={data?.in_progress ?? []} />
        {data?.in_progress.length === 0 && (
          <p className="text-[13px] text-muted-foreground">No instance is in flight.</p>
        )}
      </Panel>

      <div className="flex justify-end">
        <WindowPicker window={window} onChange={setWindow} />
      </div>

      <Panel>
        <SectionHeading
          title="Output"
          description="Counted from the transitions the machines recorded."
        />
        <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
          {(Object.keys(METRIC_LABELS) as OverviewMetricKey[]).map((metric) => (
            <div key={metric} className="grid gap-2 rounded-lg border border-border bg-tile p-3">
              <span className="text-[13px] text-muted-foreground">{METRIC_LABELS[metric]}</span>
              <span className="font-bold text-2xl">{formatNumber(metrics?.totals[metric] ?? 0)}</span>
              <Sparkline values={(metrics?.series[metric] ?? []).map((point) => point.value)} />
            </div>
          ))}
        </div>
      </Panel>


      <div className="grid gap-5 lg:grid-cols-2">
        <Panel className="content-start">
          <SectionHeading title="Recent failures" description="Sandbox runs that did not finish." />
          <div className={SCROLL_PANE}>
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className={HEADER_CELL}>Sandbox run</th>
                  <th className={HEADER_CELL}>Workflow agent</th>
                  <th className={HEADER_CELL}>Reference</th>
                  <th className={HEADER_CELL}>Ended</th>
                  <th className={HEADER_CELL}>State</th>
                </tr>
              </thead>
              <tbody>
                {(data?.recent_failures ?? []).map((run) => (
                  <tr key={run.sandbox_run_id} className="border-border border-t">
                    <td
                      className="p-2 font-mono whitespace-nowrap text-muted-foreground"
                      title={run.sandbox_run_id}
                    >
                      {run.sandbox_run_id.slice(0, 8)}
                    </td>
                    <td className="p-2 whitespace-nowrap">{run.agent_name}</td>
                    <td
                      className="max-w-[220px] truncate p-2 font-mono"
                      title={run.subject_label ?? undefined}
                    >
                      {run.subject_label ?? '--'}
                    </td>
                    <td className="p-2 font-mono whitespace-nowrap text-muted-foreground">
                      {run.ended_at === null ? '--' : formatTimestamp(run.ended_at)}
                    </td>
                    <td className="p-2" title={run.error ?? undefined}>
                      <StatusPill status={RUN_STATE_PILL[run.run_state]} label={run.run_state} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data?.recent_failures.length === 0 && (
            <p className="text-[13px] text-muted-foreground">No run failed.</p>
          )}
        </Panel>

        <Panel className="content-start">
          <SectionHeading title="Recent pull requests" description="The ones we touched." />
          <div className={SCROLL_PANE}>
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className={HEADER_CELL}>Pull request</th>
                  <th className={HEADER_CELL}>Created</th>
                  <th className={HEADER_CELL}>State</th>
                </tr>
              </thead>
              <tbody>
                {(data?.recent_pull_requests ?? []).map((pullRequest) => (
                  <tr
                    key={`${pullRequest.repository_full_name}#${pullRequest.pull_request_number}`}
                    className="border-border border-t"
                  >
                    <td className="p-2 font-mono">
                      <a
                        href={pullRequest.url}
                        target="_blank"
                        rel="noreferrer"
                        className="underline"
                      >
                        {pullRequest.repository_full_name}#{pullRequest.pull_request_number}
                      </a>
                    </td>
                    <td className="p-2 font-mono whitespace-nowrap text-muted-foreground">
                      {formatTimestamp(pullRequest.created_at)}
                    </td>
                    <td className="p-2">
                      <StatusPill
                        status={TONE_PILL[pullRequest.tone]}
                        label={pullRequest.state_label}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data?.recent_pull_requests.length === 0 && (
            <p className="text-[13px] text-muted-foreground">No pull request in this window.</p>
          )}
        </Panel>
      </div>
    </>
  );
}

// InstanceQueue is the shape both Overview queues share: the same columns, and an
// action cell only where a person has something to do with the row.
function InstanceQueue({
  instances,
  action,
}: {
  instances: WorkflowInstanceRow[];
  action?: (instance: WorkflowInstanceRow) => ReactNode;
}) {
  return (
    <div className={SCROLL_PANE}>
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className={HEADER_CELL}>Reference</th>
            <th className={HEADER_CELL}>Workflow</th>
            <th className={HEADER_CELL}>State</th>
            <th className={HEADER_CELL}>Last state change</th>
            {action && <th className={HEADER_CELL}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {instances.map((instance) => (
            <tr
              key={`${instance.workflow_type}:${instance.workflow_instance_id}`}
              className="border-border border-t"
            >
              <td className="max-w-[280px] p-2 font-mono">
                <a
                  href={operationHref(instance.workflow_instance_id)}
                  title={instance.subject.label}
                  className="block truncate underline"
                >
                  {instance.subject.label}
                </a>
              </td>
              <td className="p-2 whitespace-nowrap">{instance.workflow_label}</td>
              <td className="flex flex-wrap items-center gap-2 p-2">
                <span title={instance.workflow_state}>
                  <StatusPill status={TONE_PILL[instance.tone]} label={instance.state_label} />
                </span>
                {instance.needs_human_reason && (
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
              {action && <td className="p-2">{action(instance)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MachineCard({ machine }: { machine: WorkflowMachineRow }) {
  return (
    <article className="grid content-start gap-2 rounded-lg border border-border bg-card p-3">
      <header className="flex items-baseline justify-between gap-2">
        <h4 className="text-[14px]">{machine.label}</h4>
        <span className="text-[12px] text-muted-foreground">
          {machine.sandboxes_running} / {machine.concurrency}
        </span>
      </header>
      {!machine.enabled && <p className="text-[12px] text-muted-foreground">disabled in config</p>}
      {machine.states.length === 0 && (
        <p className="text-[12px] text-muted-foreground">nothing open</p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {machine.states.map((state) => (
          <a
            key={state.workflow_state}
            href={`/dashboard/operation?workflow_type=${machine.workflow_type}&workflow_state=${state.workflow_state}`}
          >
            <StatusPill
              status={TONE_PILL[state.tone]}
              label={`${state.state_label} ${state.instance_count}`}
            />
          </a>
        ))}
      </div>
    </article>
  );
}

// Sparkline draws the series as bars, tall as the busiest bucket, so a shape reads
// without an axis.
function Sparkline({ values }: { values: number[] }) {
  const peak = Math.max(1, ...values);
  return (
    <span aria-hidden="true" className="flex h-8 items-end gap-[2px]">
      {values.map((value, index) => (
        <span
          key={index}
          className="flex-1 rounded-sm bg-nav-active/70"
          style={{ height: `${Math.max(2, (value / peak) * 100)}%` }}
        />
      ))}
    </span>
  );
}
