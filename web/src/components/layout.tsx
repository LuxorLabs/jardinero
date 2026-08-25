import type { ReactNode } from 'react';
import { useReveal } from '@/components/Reveal';
import { cn } from '@/lib/utils';

/** `.workspace` — the per-tab white card grid. */
export function Workspace({ tab, children }: { tab: string; children: ReactNode }) {
  return (
    <section
      data-tab={tab}
      className="grid min-h-[240px] gap-[18px] rounded-lg border border-border bg-card p-[18px]"
    >
      {children}
    </section>
  );
}

/** Page-level header rendered above (outside) a tab's white card: title and
 *  description on the left, an optional controls slot on the right. */
export function PageHeader({
  title,
  description,
  right,
}: {
  title: string;
  description?: string;
  right?: ReactNode;
}) {
  const reveal = useReveal();
  return (
    <div
      ref={reveal.ref}
      style={reveal.style}
      className={cn('flex flex-wrap items-start justify-between gap-3', reveal.className)}
    >
      <div>
        <h1 className="text-2xl">{title}</h1>
        {description && <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>}
      </div>
      {right}
    </div>
  );
}

/** `.workspace-header` — title + description on the left, optional right slot. */
export function WorkspaceHeader({
  title,
  description,
  right,
}: {
  title: string;
  description?: string;
  right?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-4">
      <div>
        <h2>{title}</h2>
        {description && <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>}
      </div>
      {right}
    </header>
  );
}

/** `.overview-section` — a nested white card with a 14px grid gap. */
export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  const reveal = useReveal();
  return (
    <section
      ref={reveal.ref}
      style={reveal.style}
      className={cn(
        'grid gap-[14px] rounded-lg border border-border bg-card p-[18px]',
        reveal.className,
        className,
      )}
    >
      {children}
    </section>
  );
}

/** `.section-heading` — h3 + description, with an optional right-aligned slot. */
export function SectionHeading({
  title,
  description,
  id,
  right,
  className,
}: {
  title: string;
  description?: string;
  id?: string;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div>
        <h3 id={id}>{title}</h3>
        {description && <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>}
      </div>
      {right}
    </div>
  );
}

/** `.detail-section` — an h4 with a rule above it, the shape the run detail uses. */
export function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2 border-border border-t pt-3 [&:first-of-type]:border-t-0 [&:first-of-type]:pt-0">
      <h4 className="text-[13px] text-ink">{title}</h4>
      {children}
    </section>
  );
}

/** Label and value pairs of a detail section; a pair with no value is left out. */
export function DetailGrid({ rows }: { rows: Array<[string, ReactNode]> }) {
  const visible = rows.filter(([, value]) => value !== null && value !== undefined && value !== '');
  return (
    <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-2">
      {visible.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="font-extrabold text-[12px] text-muted-foreground uppercase">{label}</dt>
          <dd className="m-0 break-words text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
