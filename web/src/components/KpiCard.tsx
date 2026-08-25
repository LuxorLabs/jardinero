import type { LucideIcon } from 'lucide-react';
import { CountUp } from '@/components/CountUp';
import { useReveal } from '@/components/Reveal';
import { cn } from '@/lib/utils';

/** Headline metric card: label and icon on top, big value below. The featured
 *  variant renders on the brand-blue mesh gradient with white text. The value
 *  counts up on reveal; index staggers a row of cards. */
export function KpiCard({
  label,
  value,
  id,
  Icon,
  featured = false,
  index = 0,
}: {
  label: string;
  value: string | number;
  id?: string;
  Icon: LucideIcon;
  featured?: boolean;
  index?: number;
}) {
  const reveal = useReveal({ delay: index * 70 });
  return (
    <div
      ref={reveal.ref}
      style={reveal.style}
      className={cn(
        'flex min-h-[132px] flex-col justify-between gap-6 rounded-2xl border p-5',
        featured ? 'kpi-mesh-blue border-transparent text-white' : 'border-border bg-card',
        reveal.className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span
          className={cn('font-normal text-[15px]', featured ? 'text-white/85' : 'text-muted-foreground')}
        >
          {label}
        </span>
        <span
          className={cn(
            'inline-flex size-9 shrink-0 items-center justify-center rounded-full border',
            featured ? 'border-white/40 text-white' : 'border-border text-slate',
          )}
        >
          <Icon aria-hidden="true" className="size-[18px]" />
        </span>
      </div>
      <CountUp
        id={id}
        value={value}
        className="block font-bold text-4xl leading-none tabular-nums"
      />
    </div>
  );
}
