/** "just now", "42s ago", "3m 05s ago", "1h 02m ago" */
export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 2) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s ago`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m ago`;
}
