// Single-line editor state machine (pure, so it's easy to test).
import type { Key } from 'ink';

export interface LineState {
  value: string;
  cursor: number; // index in code points
}

export const emptyLine: LineState = { value: '', cursor: 0 };

const chars = (s: string) => Array.from(s);

export function lineFrom(value: string): LineState {
  return { value, cursor: chars(value).length };
}

/** Returns the new state, or null if the key isn't an editing key. */
export function editLine(st: LineState, input: string, key: Partial<Key>): LineState | null {
  const cs = chars(st.value);
  const c = Math.min(st.cursor, cs.length);
  const set = (arr: string[], cursor: number): LineState => ({ value: arr.join(''), cursor: Math.max(0, Math.min(cursor, arr.length)) });

  if (key.leftArrow) return set(cs, c - 1);
  if (key.rightArrow) return set(cs, c + 1);
  if (key.home || (key.ctrl && input === 'a')) return set(cs, 0);
  if (key.end || (key.ctrl && input === 'e')) return set(cs, cs.length);
  if (key.ctrl && input === 'u') return set(cs.slice(c), 0);
  if (key.ctrl && input === 'k') return set(cs.slice(0, c), c);
  if (key.ctrl && input === 'w') {
    let i = c;
    while (i > 0 && cs[i - 1] === ' ') i--;
    while (i > 0 && cs[i - 1] !== ' ') i--;
    return set([...cs.slice(0, i), ...cs.slice(c)], i);
  }
  // Most terminals send DEL (0x7f) for the backspace key; Ink may report it as either.
  if (key.backspace || key.delete) {
    if (c === 0) return st;
    return set([...cs.slice(0, c - 1), ...cs.slice(c)], c - 1);
  }
  if (key.ctrl || key.meta || key.escape || key.return || key.tab || key.upArrow || key.downArrow) return null;
  if (!input) return null;
  // Typed text or a paste; flatten newlines so the line stays single-line.
  const ins = chars(input.replace(/\r?\n|\r/g, ' ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''));
  if (!ins.length) return st;
  return set([...cs.slice(0, c), ...ins, ...cs.slice(c)], c + ins.length);
}
