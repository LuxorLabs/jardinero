import { useEffect, useRef, useState } from 'react';

interface Metric {
  prefix: string;
  value: number;
  decimals: number;
  group: boolean;
  suffix: string;
}

const groupedFormatters = new Map<number, Intl.NumberFormat>();

// Splits a formatted metric string into an animatable number plus its prefix
// (e.g. "$") and suffix (e.g. "%", "h", "ms"). Returns null for values with no
// clean numeric core (e.g. "Healthy", the version "0.2.0") so they render as-is.
function parseMetric(input: string): Metric | null {
  const match = /^([^\d-]*)(-?\d[\d,]*(?:\.\d+)?)([^\d]*)$/.exec(input);
  if (!match) return null;
  const raw = match[2];
  const value = Number.parseFloat(raw.replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  return {
    prefix: match[1],
    value,
    decimals: raw.includes('.') ? raw.split('.')[1].length : 0,
    group: raw.includes(','),
    suffix: match[3],
  };
}

function formatMetric(current: number, metric: Metric): string {
  let body: string;
  if (metric.group) {
    let formatter = groupedFormatters.get(metric.decimals);
    if (!formatter) {
      formatter = new Intl.NumberFormat(undefined, {
        minimumFractionDigits: metric.decimals,
        maximumFractionDigits: metric.decimals,
      });
      groupedFormatters.set(metric.decimals, formatter);
    }
    body = formatter.format(current);
  } else {
    body = metric.decimals > 0 ? current.toFixed(metric.decimals) : String(Math.round(current));
  }
  return `${metric.prefix}${body}${metric.suffix}`;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

// Renders a metric value and animates its numeric part from the previously
// shown value up to the new target (from 0 on first mount) with an eased tween.
// Non-numeric values are passed straight through.
export function CountUp({
  value,
  className,
  id,
  duration = 900,
}: {
  value: string | number;
  className?: string;
  id?: string;
  duration?: number;
}) {
  const target = String(value);
  const metric = parseMetric(target);
  const fromRef = useRef(0);
  const currentRef = useRef(0);
  const frameRef = useRef<number | undefined>(undefined);
  const [display, setDisplay] = useState(() => (metric ? formatMetric(0, metric) : target));

  useEffect(() => {
    if (!metric) {
      fromRef.current = 0;
      currentRef.current = 0;
      setDisplay(target);
      return;
    }
    const to = metric.value;
    const from = fromRef.current;
    if (prefersReducedMotion() || from === to) {
      fromRef.current = to;
      currentRef.current = to;
      setDisplay(formatMetric(to, metric));
      return;
    }
    let start: number | null = null;
    const step = (now: number) => {
      if (start === null) start = now;
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - progress) ** 3;
      const current = from + (to - from) * eased;
      currentRef.current = current;
      setDisplay(formatMetric(current, metric));
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        fromRef.current = to;
        frameRef.current = undefined;
      }
    };
    frameRef.current = requestAnimationFrame(step);
    return () => {
      fromRef.current = currentRef.current;
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    };
    // Re-run whenever the formatted target changes; metric is derived from it.
  }, [target, duration]);

  return (
    <strong id={id} className={className}>
      {metric ? display : target}
    </strong>
  );
}
