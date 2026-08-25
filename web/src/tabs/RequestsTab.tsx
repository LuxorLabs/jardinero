import { useState } from 'react';
import type { OverviewWindowKey, RequestListResponse, RequestRow } from '@shared';
import { ExpandableCell } from '@/components/ExpandableCell';
import { SectionHeading, Workspace } from '@/components/layout';
import { DEFAULT_WINDOW, WindowPicker } from '@/components/WindowPicker';
import { formatTimestamp } from '@/lib/format';
import { useDashboardResource } from '@/lib/hooks';
import { cn } from '@/lib/utils';

const SOURCES = ['', 'github', 'linear', 'discord', 'cron', 'operator'];
const ASKED_INLINE_LIMIT = 180;

export function RequestsTab() {
  const [source, setSource] = useState('');
  const [window, setWindow] = useState<OverviewWindowKey>(DEFAULT_WINDOW);

  const query = new URLSearchParams({ window });
  if (source) query.set('source', source);
  const list = useDashboardResource<RequestListResponse>(
    `/dashboard/api/requests?${query.toString()}`,
    'request list refresh failed',
  );

  return (
    <Workspace tab="requests">
      <SectionHeading
        title="Requests"
        description="Every ask that reached us, and what became of it."
        right={
          <div className="flex items-center gap-2">
            <select
              value={source}
              onChange={(event) => setSource(event.target.value)}
              aria-label="Filter by source"
              className="h-8 rounded-md border border-border bg-background px-2 text-[13px]"
            >
              {SOURCES.map((value) => (
                <option key={value} value={value}>
                  {value === '' ? 'Every source' : value}
                </option>
              ))}
            </select>
            <WindowPicker window={window} onChange={setWindow} />
          </div>
        }
      />

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="bg-table-header text-left text-muted-foreground">
              <th className="p-2">Time</th>
              <th className="p-2">Came from</th>
              <th className="p-2">Requester</th>
              <th className="p-2">Request</th>
              <th className="p-2">Reference</th>
              <th className="p-2">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {(list?.requests ?? []).map((request) => (
              <tr key={request.id} className="border-border border-t align-top">
                <td className="p-2 whitespace-nowrap">{formatTimestamp(request.created_at)}</td>
                <td className="p-2">{request.request_source}</td>
                <td className="p-2">{request.requester ?? '--'}</td>
                <td className="max-w-[380px] p-2">
                  <AskedCell request={request} />
                </td>
                <td className="p-2 whitespace-nowrap">
                  {request.subject_external_id ?? '--'}
                  {request.repository_full_name ? ` · ${request.repository_full_name}` : ''}
                </td>
                <td className={cn('p-2', request.outcome === 'unresolvable' && 'text-danger-fg')}>
                  {request.outcome_label}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {list?.requests.length === 0 && (
        <p className="text-[13px] text-muted-foreground">
          No ask arrived in this window. If someone is waiting on one, the delivery never reached us.
        </p>
      )}

      {list?.page.next_cursor && (
        <p className="text-[13px] text-muted-foreground">
          Only the newest {list.page.limit} asks of this window are listed. Narrow the window or the
          source to reach the ones behind them.
        </p>
      )}
    </Workspace>
  );
}


// AskedCell clamps the ask to two lines and puts the rest behind a modal.
function AskedCell({ request }: { request: RequestRow }) {
  const text = request.request_text ?? '--';
  if (text.length <= ASKED_INLINE_LIMIT) return <span>{text}</span>;

  return (
    <ExpandableCell
      preview={text}
      actionLabel="Show more"
      ariaLabel={`Ask from ${request.request_source}`}
      heading="Asked"
      title={request.requester ?? request.request_source}
      subtitle={formatTimestamp(request.created_at)}
    >
      <p className="wrap-anywhere whitespace-pre-wrap text-slate leading-[1.45]">{text}</p>
    </ExpandableCell>
  );
}
