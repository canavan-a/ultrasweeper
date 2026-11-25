export const NOTE_MAX = 500; // UTF-16 units: the same unit a TextInput maxLength counts

/**
 * store-time cap for note fields. Backs off when the cut would land between
 * the two halves of a surrogate pair, so an emoji is never left half-written.
 */
export function capNote(note: string): string {
  if (note.length <= NOTE_MAX) {
    return note;
  }
  const last = note.charCodeAt(NOTE_MAX - 1);
  const splitSurrogate = last >= 0xd800 && last <= 0xdbff;
  return note.slice(0, splitSurrogate ? NOTE_MAX - 1 : NOTE_MAX);
}
