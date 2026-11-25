export const NOTE_MAX = 500;

// One-line preview of a flag note for list rows; empty when there is none.
export function noteLabel(note: string | undefined): string {
  const first = (note || '').replace(/\s+/g, ' ').trim();
  if (!first) return '';
  return first.length > 80 ? first.slice(0, 79) + '…' : first;
}
