import type { DiffLine } from '../types';

/** Claude-Code-style edit diff: number gutter, sign, text, trailing note. */
export function DiffLines({ lines }: { lines: DiffLine[] }) {
  if (!lines.length) return null;
  return (
    <div className="diff">
      {lines.map((l, i) => (
        <div key={i} className={`dl s-${l.sign === '+' ? 'add' : l.sign === '-' ? 'del' : l.sign === ' ' ? 'ctx' : l.sign === '~' ? 'mod' : 'warn'}`}>
          <span className="ln">{l.num ?? ''}</span>
          <span className="sg">{l.sign}</span>
          <span className="tx">{l.text}</span>
          {l.note && <span className="nt">{l.note}</span>}
        </div>
      ))}
    </div>
  );
}
