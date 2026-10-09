import { useState, type ReactNode } from 'react';

/** Collapsed-by-default secondary section, like Claude Code's "ctrl+r to expand". */
export function Fold({ title, meta, children, defaultOpen = false }: { title: string; meta?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`fold ${open ? 'open' : ''}`}>
      <button className="fold-h" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="fold-caret">{open ? '▾' : '▸'}</span>
        <span>{title}</span>
        {meta != null && <span className="faint">{meta}</span>}
      </button>
      {open && <div className="fold-body">{children}</div>}
    </section>
  );
}
