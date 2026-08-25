import type { OverviewWindowKey } from '@shared';
import { cn } from '@/lib/utils';

const WINDOWS: OverviewWindowKey[] = ['24h', '7d', '30d'];

export const DEFAULT_WINDOW: OverviewWindowKey = '24h';

// WindowPicker is the one control every page filters time with, so a window reads and
// behaves the same wherever the operator lands.
export function WindowPicker({
  window,
  onChange,
}: {
  window: OverviewWindowKey;
  onChange: (value: OverviewWindowKey) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Window"
      className="flex items-center gap-1 rounded-lg border border-border p-1"
    >
      {WINDOWS.map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          aria-pressed={value === window}
          className={cn(
            'rounded-md px-2.5 py-1 font-bold text-[13px]',
            value === window ? 'bg-nav-active text-white' : 'text-muted-foreground',
          )}
        >
          {value}
        </button>
      ))}
    </div>
  );
}
