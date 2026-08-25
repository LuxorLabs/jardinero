import { type ReactNode, useState } from 'react';
import { DetailModal } from '@/components/DetailModal';

/** A table cell whose value is too long to show: two clamped lines, and the rest of it
 *  in a modal. The caller decides when a value is long enough to need one. */
export function ExpandableCell({
  preview,
  actionLabel,
  ariaLabel,
  heading,
  title,
  subtitle,
  children,
}: {
  preview: string;
  actionLabel: string;
  ariaLabel: string;
  heading: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="grid justify-items-start gap-1">
      <p className="line-clamp-2 break-all">{preview}</p>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="underline decoration-dotted text-muted-foreground hover:text-ink"
      >
        {actionLabel}
      </button>
      {open && (
        <DetailModal ariaLabel={ariaLabel} onClose={() => setOpen(false)}>
          <div className="grid gap-3">
            <div>
              <p className="font-extrabold text-[12px] text-muted-foreground uppercase">{heading}</p>
              <h3 className="font-mono">{title}</h3>
              {subtitle && <p className="text-[12px] text-muted-foreground">{subtitle}</p>}
            </div>
            {children}
          </div>
        </DetailModal>
      )}
    </div>
  );
}
