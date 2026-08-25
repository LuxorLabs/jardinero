import { useState } from 'react';
import type { OverviewWindowKey, PullRequestListResponse } from '@shared';
import { KpiCard } from '@/components/KpiCard';
import { SectionHeading, Workspace } from '@/components/layout';
import { StatusPill } from '@/components/StatusPill';
import { DEFAULT_WINDOW, WindowPicker } from '@/components/WindowPicker';
import { formatDuration, formatNumber, formatTimestamp } from '@/lib/format';
import { useDashboardResource } from '@/lib/hooks';
import { TONE_PILL } from '@/lib/tone';
import { CheckCheck, GitMerge, GitPullRequest, Hourglass } from 'lucide-react';

export function PrsTab() {
  const [window, setWindow] = useState<OverviewWindowKey>(DEFAULT_WINDOW);
  const [repository, setRepository] = useState('');
  const data = useDashboardResource<PullRequestListResponse>(
    `/dashboard/api/pull-requests?window=${window}`,
    'pull request list refresh failed',
  );

  const rows = (data?.pull_requests ?? []).filter(
    (row) => repository === '' || row.repository_full_name === repository,
  );
  const acceptedRate = data?.kpis.accepted_rate;

  return (
    <Workspace tab="prs">
      <SectionHeading
        title="Pull requests"
        description="The ones our machines opened or follow. Everything here is what we did, never a re-read of GitHub."
        right={
          <div className="flex items-center gap-2">
            <select
              value={repository}
              onChange={(event) => setRepository(event.target.value)}
              aria-label="Filter by repository"
              className="h-8 rounded-md border border-border bg-background px-2 text-[13px]"
            >
              <option value="">Every repository</option>
              {(data?.repositories ?? []).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <WindowPicker window={window} onChange={setWindow} />
          </div>
        }
      />

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Created by us"
          value={formatNumber(data?.kpis.created ?? 0)}
          Icon={GitPullRequest}
          index={0}
        />
        <KpiCard
          label="Merged"
          value={formatNumber(data?.kpis.merged ?? 0)}
          Icon={GitMerge}
          index={1}
        />
        <KpiCard
          label="Accepted"
          value={
            acceptedRate === null || acceptedRate === undefined
              ? '--'
              : `${Math.round(acceptedRate * 100)}%`
          }
          Icon={CheckCheck}
          index={2}
        />
        <KpiCard
          label="Median time open"
          value={formatDuration(data?.kpis.median_time_open_ms)}
          Icon={Hourglass}
          index={3}
        />
      </section>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="bg-table-header text-left text-muted-foreground">
              <th className="p-2">Pull request</th>
              <th className="p-2">State</th>
              <th className="p-2">Opened by</th>
              <th className="p-2">Opened</th>
              <th className="p-2">Ended</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={`${row.repository_full_name}#${row.pull_request_number}`}
                className="border-border border-t"
              >
                <td className="p-2">
                  <a href={row.url} target="_blank" rel="noreferrer" className="underline">
                    {row.repository_full_name}#{row.pull_request_number}
                  </a>
                </td>
                <td className="p-2">
                  <StatusPill status={TONE_PILL[row.tone]} label={row.state_label} />
                </td>
                <td className="p-2">{row.opened_by_workflow_label ?? 'somebody else'}</td>
                <td className="p-2 whitespace-nowrap">{formatTimestamp(row.created_at)}</td>
                <td className="p-2 whitespace-nowrap">
                  {row.finished_at === null ? '--' : formatTimestamp(row.finished_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && (
        <p className="text-[13px] text-muted-foreground">No pull request in this window.</p>
      )}
    </Workspace>
  );
}
