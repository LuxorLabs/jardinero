import { cn } from '@/lib/utils';

// Several status values intentionally share a semantic color family: what is in
// flight reads the same whether it runs or waits, and each family is theme-aware.
const STATUS_CLASSES: Record<string, string> = {
  running: 'border-info-border bg-info-bg text-info-fg',
  pending: 'border-info-border bg-info-bg text-info-fg',
  succeeded: 'border-success-border bg-success-bg text-success-fg',
  failed: 'border-danger-border bg-danger-bg text-danger-fg',
  // A run the process lost is recovered on the next boot, so it reads as trouble that
  // fixes itself, not as a failure.
  orphaned: 'border-warning-border bg-warning-bg text-warning-fg',
  skipped: 'border-neutral-border bg-neutral-bg text-neutral-fg',
  aborted: 'border-neutral-border bg-neutral-bg text-neutral-fg',
  neutral: 'border-neutral-border bg-neutral-bg text-neutral-fg',
};

// Base pill, and the fallback for a status with no family of its own.
const BASE_PILL =
  'inline-flex items-center rounded-full border border-neutral-border bg-neutral-bg px-2 py-[5px] font-extrabold text-[12px] text-neutral-fg';

export function StatusPill({
  status,
  label,
  className,
}: {
  status: string;
  label: string;
  className?: string;
}) {
  return (
    <span className={cn(BASE_PILL, STATUS_CLASSES[status], className)}>{label}</span>
  );
}
