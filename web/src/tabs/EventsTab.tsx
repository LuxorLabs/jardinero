import { useState } from 'react';
import type { EventListResponse, EventRow, OverviewWindowKey } from '@shared';
import { ExpandableCell } from '@/components/ExpandableCell';
import { DetailGrid, SectionHeading, Workspace } from '@/components/layout';
import { DEFAULT_WINDOW, WindowPicker } from '@/components/WindowPicker';
import { formatNumber, formatTimestamp } from '@/lib/format';
import { useDashboardResource } from '@/lib/hooks';
import { operationHref } from '@/lib/links';
import { EVENT_FAMILY_TEXT } from '@/lib/tone';
import { cn } from '@/lib/utils';

const FAMILIES = ['workflow', 'sandbox', 'agent', 'orchestrator', 'operator'];
const METADATA_INLINE_LIMIT = 180;


export function EventsTab() {
  const [families, setFamilies] = useState<string[]>([]);
  const [window, setWindow] = useState<OverviewWindowKey>(DEFAULT_WINDOW);

  const query = new URLSearchParams({ window });
  for (const family of families) query.append('family', family);
  const list = useDashboardResource<EventListResponse>(
    `/dashboard/api/events?${query.toString()}`,
    'event log refresh failed',
  );

  return (
    <Workspace tab="events">
      <SectionHeading
        title="Event logs"
        description="Everything the engine recorded, including what belongs to no instance: boot, backups, dropped deliveries."
        right={
          <div className="flex flex-wrap items-center gap-2">
            {FAMILIES.map((family) => (
              <label
                key={family}
                className={cn('inline-flex items-center gap-1.5 text-[13px]', EVENT_FAMILY_TEXT[family])}
              >
                <input
                  type="checkbox"
                  checked={families.includes(family)}
                  onChange={(event) =>
                    setFamilies(
                      event.target.checked
                        ? [...families, family]
                        : families.filter((value) => value !== family),
                    )
                  }
                />
                {family}
              </label>
            ))}
            <WindowPicker window={window} onChange={setWindow} />
          </div>
        }
      />

      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-[12px]">
          <thead>
            <tr className="bg-table-header text-left text-muted-foreground">
              <th className="p-2">Time</th>
              <th className="p-2">Event type</th>
              <th className="p-2">Workflow</th>
              <th className="p-2">Workflow instance</th>
              <th className="p-2">Sandbox run</th>
              <th className="p-2">Details</th>
            </tr>
          </thead>
          <tbody>
            {(list?.events ?? []).map((event) => (
              <tr key={event.id} className="border-border border-t align-top">
                <td className="p-2 whitespace-nowrap">{formatTimestamp(event.created_at)}</td>
                <td
                  className={cn(
                    'p-2 whitespace-nowrap font-bold',
                    EVENT_FAMILY_TEXT[event.family],
                  )}
                >
                  {event.event_type}
                </td>
                <td className="p-2 whitespace-nowrap">{event.workflow_type ?? '--'}</td>
                <td className="p-2 whitespace-nowrap">
                  {event.workflow_instance_id ? (
                    <a
                      href={operationHref(event.workflow_instance_id, event.sandbox_run_id)}
                      title={event.workflow_instance_id}
                      className="underline"
                    >
                      {shortId(event.workflow_instance_id)}
                    </a>
                  ) : (
                    '--'
                  )}
                </td>
                <td className="p-2 whitespace-nowrap" title={event.sandbox_run_id ?? undefined}>
                  {event.sandbox_run_id ? shortId(event.sandbox_run_id) : '--'}
                </td>
                <td className="max-w-[520px] p-2">
                  <MetadataCell event={event} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {list?.page.next_cursor && (
        <p className="text-[13px] text-muted-foreground">
          Only the newest {list.page.limit} events of this window are listed. Narrow the window or
          the families to reach the ones behind them.
        </p>
      )}
    </Workspace>
  );
}

// MetadataCell clamps the value to two lines and puts the rest behind a modal.
function MetadataCell({ event }: { event: EventRow }) {
  const heldBackBytes = heldBackBytesOf(event);
  const text =
    heldBackBytes === null
      ? metadataOf(event)
      : `${formatNumber(heldBackBytes)} bytes of metadata, not carried by this feed`;
  if (heldBackBytes === null && text.length <= METADATA_INLINE_LIMIT) {
    return <span className="break-all">{text}</span>;
  }

  return (
    <ExpandableCell
      preview={text}
      actionLabel="Show more"
      ariaLabel={`Metadata of ${event.event_type}`}
      heading="Details"
      title={event.event_type}
      subtitle={formatTimestamp(event.created_at)}
    >
      {heldBackBytes === null ? (
        <div className="max-h-[60vh] overflow-y-auto font-mono text-[12px]">
          <DetailGrid rows={metadataEntriesOf(event)} />
        </div>
      ) : (
        <div className="grid gap-3">
          <p className="text-slate leading-[1.45]">
            This event carries {formatNumber(heldBackBytes)} bytes of metadata. The feed leaves a
            value that size out so the page stays fast; the whole of it is on the timeline of the
            instance that wrote it, behind Show data.
          </p>
          {event.workflow_instance_id && (
            <a
              href={operationHref(event.workflow_instance_id, event.sandbox_run_id)}
              className="underline"
            >
              Open it in Operation
            </a>
          )}
          <DetailGrid
            rows={[
              ['Workflow', event.workflow_type],
              ['Workflow instance id', event.workflow_instance_id],
              ['Sandbox run id', event.sandbox_run_id],
            ]}
          />
        </div>
      )}
    </ExpandableCell>
  );
}

// heldBackBytesOf reads the size the store reports in place of a metadata value too
// large to serialize into the feed.
function heldBackBytesOf(event: EventRow): number | null {
  if (event.metadata?.truncated !== true) return null;
  const size = event.metadata.original_size_bytes;
  return typeof size === 'number' ? size : null;
}

// shortId keeps the head of a uuid, which is what a person compares by eye; the full
// value stays in the title attribute.
export function shortId(id: string): string {
  return id.slice(0, 8);
}

// metadataEntriesOf lists what the event carries, with the transition states first.
export function metadataEntriesOf(event: EventRow): Array<[string, string]> {
  const transition =
    event.from_state === null && event.to_state === null
      ? {}
      : { from_state: event.from_state, to_state: event.to_state };
  return Object.entries({ ...transition, ...(event.metadata ?? {}) }).map(([key, value]) => [
    key,
    String(value),
  ]);
}

// metadataOf renders those entries as the single line a table cell holds.
export function metadataOf(event: EventRow): string {
  const entries = metadataEntriesOf(event);
  return entries.length === 0 ? '--' : entries.map(([key, value]) => `${key}=${value}`).join(' · ');
}
