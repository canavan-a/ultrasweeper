export const NOTE_MAX = 500;

// cut at code points, not UTF-16 units, so an emoji is never sliced in half
function cut(s: string, n: number): string {
  const chars = Array.from(s);
  return chars.length <= n ? s : chars.slice(0, n).join('');
}

/** store-time cap for note fields */
export function capNote(note: string): string {
  return cut(note, NOTE_MAX);
}
