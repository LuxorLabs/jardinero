// Rewrites relative Grafana time ranges (`now-90m`/`now`) to absolute epoch-ms so
// evidence links keep showing the incident window; unparseable input passes through.

export interface GrafanaTimeWindow {
  // Anchor for relative `from` expressions; the run start, so evidence the agent
  // queried early in a long run stays inside the absolute window.
  fromAnchorMs: number;
  // Anchor for relative `to` expressions; the parse time at run end.
  toAnchorMs: number;
}

const RELATIVE_OFFSET_PATTERN = /^now-(\d+)([smhdwMy])$/;

// M and y are fixed 30/365 days on purpose; the window is evidence context where
// calendar precision does not matter and this keeps the math dependency-free.
const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  M: 2_592_000_000,
  y: 31_536_000_000,
};

export function toAbsoluteGrafanaTimeRange(rawUrl: string, window: GrafanaTimeWindow): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  let changed = false;

  const topLevel = resolveRangePair(
    url.searchParams.get('from'),
    url.searchParams.get('to'),
    window,
  );
  if (topLevel) {
    url.searchParams.set('from', topLevel.from);
    url.searchParams.set('to', topLevel.to);
    changed = true;
  }

  const panes = url.searchParams.get('panes');
  const rewrittenPanes = panes === null ? undefined : rewritePanes(panes, window);
  if (rewrittenPanes !== undefined) {
    url.searchParams.set('panes', rewrittenPanes);
    changed = true;
  }

  return changed ? url.toString() : rawUrl;
}

function rewritePanes(panesJson: string, window: GrafanaTimeWindow): string | undefined {
  let panes: unknown;
  try {
    panes = JSON.parse(panesJson);
  } catch {
    return undefined;
  }
  if (typeof panes !== 'object' || panes === null || Array.isArray(panes)) return undefined;

  let changed = false;
  for (const pane of Object.values(panes as Record<string, unknown>)) {
    if (typeof pane !== 'object' || pane === null) continue;
    const range = (pane as Record<string, unknown>).range;
    if (typeof range !== 'object' || range === null) continue;
    const rangeRecord = range as Record<string, unknown>;
    const resolved = resolveRangePair(
      typeof rangeRecord.from === 'string' ? rangeRecord.from : null,
      typeof rangeRecord.to === 'string' ? rangeRecord.to : null,
      window,
    );
    if (!resolved) continue;
    rangeRecord.from = resolved.from;
    rangeRecord.to = resolved.to;
    changed = true;
  }
  return changed ? JSON.stringify(panes) : undefined;
}

// Rewrites a from/to pair only when every relative value in it is convertible;
// otherwise the pair is left untouched so a range is never half-converted.
function resolveRangePair(
  from: string | null,
  to: string | null,
  window: GrafanaTimeWindow,
): { from: string; to: string } | undefined {
  if (from === null || to === null) return undefined;
  if (!isRelative(from) && !isRelative(to)) return undefined;
  const resolvedFrom = resolveValue(from, window.fromAnchorMs);
  const resolvedTo = resolveValue(to, window.toAnchorMs);
  if (resolvedFrom === undefined || resolvedTo === undefined) return undefined;
  return { from: resolvedFrom, to: resolvedTo };
}

function isRelative(value: string): boolean {
  return value.startsWith('now');
}

// Absolute values pass through; `now` and `now-<N><unit>` convert to epoch ms;
// other relative forms (`now/d` rounding, `now+`) are not convertible.
function resolveValue(value: string, anchorMs: number): string | undefined {
  if (!isRelative(value)) return value;
  if (value === 'now') return String(anchorMs);
  const match = RELATIVE_OFFSET_PATTERN.exec(value);
  if (!match) return undefined;
  const unitMs = UNIT_MS[match[2]];
  if (unitMs === undefined) return undefined;
  const result = anchorMs - Number(match[1]) * unitMs;
  // A non-safe or pre-epoch result would serialize to a value Grafana cannot
  // parse; leaving the pair relative beats emitting a broken absolute range.
  if (!Number.isSafeInteger(result) || result < 0) return undefined;
  return String(result);
}
