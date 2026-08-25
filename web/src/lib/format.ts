export function formatNumber(value: unknown): string {
  return new Intl.NumberFormat().format(Number(value || 0));
}

export function formatRelativeTime(timestamp: unknown): string {
  if (!timestamp) return 'Unknown time';
  const seconds = Math.round((Date.now() - Number(timestamp)) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function formatDuration(ms: unknown): string {
  const value = Number(ms || 0);
  if (value < 1000) return `${value}ms`;
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

export function formatTimestamp(timestamp: unknown): string {
  if (!timestamp || !Number.isFinite(Number(timestamp))) return 'Unknown time';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(Number(timestamp)));
}
