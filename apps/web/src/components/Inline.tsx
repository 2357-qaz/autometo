import { useEffect, useRef, useState } from 'react';

/** Click-to-edit text. Enter saves, Esc cancels. */
export function InlineEdit(props: {
  value: string;
  placeholder?: string;
  onSave: (v: string) => void;
  multiline?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(props.value);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) {
      setV(props.value);
      requestAnimationFrame(() => ref.current?.select());
    }
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!editing) {
    return (
      <span
        className={`editable ${props.className ?? ''}`}
        role="button"
        tabIndex={0}
        aria-label={props.ariaLabel ?? '编辑'}
        title="点击编辑"
        onClick={() => setEditing(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            setEditing(true);
          }
        }}
      >
        {props.value || <span className="faint">{props.placeholder ?? '（点击填写）'}</span>}
      </span>
    );
  }
  const commit = () => {
    setEditing(false);
    if (v !== props.value) props.onSave(v);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') setEditing(false);
    if (e.key === 'Enter' && (!props.multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit();
    }
  };
  return props.multiline ? (
    <textarea ref={ref} className="inline-input" rows={3} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={onKeyDown} aria-label={props.ariaLabel} />
  ) : (
    <input ref={ref} className="inline-input" value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={onKeyDown} aria-label={props.ariaLabel} />
  );
}

/** Small "add item" input row. */
export function AddRow(props: { placeholder: string; onAdd: (v: string) => void }) {
  const [v, setV] = useState('');
  return (
    <div className="add-row">
      <input
        value={v}
        placeholder={props.placeholder}
        aria-label={props.placeholder}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && v.trim()) {
            props.onAdd(v);
            setV('');
          }
          if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
}
