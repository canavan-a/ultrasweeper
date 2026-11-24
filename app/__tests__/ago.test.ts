import {formatAgo} from '../src/ago';

describe('formatAgo', () => {
  it('counts up in readable steps', () => {
    expect(formatAgo(0)).toBe('just now');
    expect(formatAgo(1999)).toBe('just now');
    expect(formatAgo(42_000)).toBe('42s ago');
    expect(formatAgo(185_000)).toBe('3m 05s ago');
    expect(formatAgo(3_725_000)).toBe('1h 02m ago');
    expect(formatAgo(-500)).toBe('just now'); // clock skew
  });
});
