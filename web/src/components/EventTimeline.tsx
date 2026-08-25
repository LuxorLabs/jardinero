import { useId, useState } from 'react';
import type { EventRow } from '@shared';
import { StatusPill } from '@/components/StatusPill';
import { formatTimestamp } from '@/lib/format';
import { EVENT_FAMILY_TEXT } from '@/lib/tone';
import { cn } from '@/lib/utils';

export function EventTimeline({ events }: { events: EventRow[] }) {
  if (events.length === 0) {
    return (
      <p className="text-muted-foreground">
        No events recorded. Every run that predates the event log reads this way.
      </p>
    );
  }
  return (
    <ol className="m-0 grid gap-2.5 pl-5">
      {events.map((event) => (
        <li key={event.id} className="border-control border-l-[3px] pl-2.5">
          <div className="flex items-baseline justify-between gap-2.5">
            <strong className={cn('font-mono text-[12px]', EVENT_FAMILY_TEXT[event.family])}>
              {event.event_type}
            </strong>
            <span className="whitespace-nowrap text-[12px] text-muted-foreground">
              {formatTimestamp(event.created_at)}
            </span>
          </div>
          {stateOf(event) && (
            <span className="mt-1.5 inline-block">
              <StatusPill status={stateOf(event) ?? ''} label={stateOf(event) ?? ''} />
            </span>
          )}
          {event.to_state !== null && (
            <p className="mt-1.5 font-mono text-[12px] text-slate">
              {event.from_state} → {event.to_state}
            </p>
          )}
          {messageOf(event) && (
            <p className="mt-1.5 wrap-anywhere text-slate">{messageOf(event)}</p>
          )}
          {event.metadata !== null && <EventData data={event.metadata} />}
        </li>
      ))}
    </ol>
  );
}

// messageOf reads the line the sandbox reported with the event, which is what a row
// says beyond its type.
function messageOf(event: EventRow): string | null {
  const message = event.metadata?.message;
  return typeof message === 'string' && message.length > 0 ? message : null;
}

// stateOf reads the run state an event carries, so a row that ends a run shows it the
// way every other surface does.
function stateOf(event: EventRow): string | null {
  const runState = event.metadata?.run_state;
  return typeof runState === 'string' ? runState : null;
}

// EventData keeps a payload collapsed, so one event carrying a whole Tenki request does
// not push the rest of the timeline out of view.
function EventData({ data }: { data: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const json = JSON.stringify(data, null, 2);

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex items-center gap-1.5 rounded font-[750] text-[12px] text-muted-foreground hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span aria-hidden="true" className={cn('inline-block transition-transform', open && 'rotate-90')}>
          ›
        </span>
        {open ? 'Hide data' : 'Show data'}
      </button>
      {open && (
        <pre
          id={panelId}
          className="mt-1.5 max-h-[240px] overflow-auto rounded-md bg-code p-2.5 font-mono text-[12px]"
        >
          {json}
        </pre>
      )}
    </div>
  );
}
