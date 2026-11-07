"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";

interface C { id: string; name: string; abn?: string }

/** Type-to-search client picker (name or ABN). Works like a select: value is the client id. */
export default function ClientPicker({ clients, value, onChange, id, disabled, required, placeholder = "Search clients…", emptyLabel, style }: {
  clients: C[]; value: string; onChange: (id: string) => void; id?: string; disabled?: boolean; required?: boolean;
  placeholder?: string; emptyLabel?: string; style?: React.CSSProperties;
}) {
  const listId = useId();
  const selected = clients.find((c) => c.id === value);
  const [text, setText] = useState(selected?.name ?? "");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // The list is positioned on the page (fixed) so tables and panels with scrolling don't cut it off.
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = inputRef.current?.getBoundingClientRect();
      if (!r) return;
      const up = window.innerHeight - r.bottom < 220 && r.top > 280;
      setPos({ left: r.left, top: up ? r.top - 4 : r.bottom + 4, width: Math.max(r.width, 320), up });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [open]);
  useEffect(() => { if (!open) setText(selected?.name ?? ""); }, [selected?.name, open]);

  const q = text.trim().toLowerCase();
  const typed = open && q && q !== (selected?.name ?? "").toLowerCase();
  const matches = useMemo(() => {
    if (!typed) return clients.slice(0, 200);
    const digits = q.replace(/\D/g, "");
    const starts: C[] = [], has: C[] = [];
    for (const c of clients) {
      const n = c.name.toLowerCase();
      if (n.startsWith(q) || n.split(/\s+/).some((w) => w.startsWith(q))) starts.push(c);
      else if (n.includes(q) || (digits.length >= 3 && (c.abn ?? "").replace(/\D/g, "").includes(digits))) has.push(c);
    }
    return [...starts, ...has].slice(0, 200);
  }, [clients, q, typed]);
  const opts: { id: string; label: string; sub?: string }[] = [
    ...(emptyLabel && !typed ? [{ id: "", label: emptyLabel }] : []),
    ...matches.map((c) => ({ id: c.id, label: c.name, sub: c.abn ? `ABN ${c.abn}` : undefined })),
  ];
  useEffect(() => { setHi(0); }, [q]);
  useEffect(() => { listRef.current?.children[hi]?.scrollIntoView({ block: "nearest" }); }, [hi]);

  const pick = (o: { id: string; label: string }) => { onChange(o.id); setText(o.id ? o.label : ""); setOpen(false); };
  return (
    <div className="picker" style={style}>
      <input ref={inputRef} id={id} type="text" role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" autoComplete="off"
        disabled={disabled} required={required} placeholder={selected ? selected.name : emptyLabel ?? placeholder} value={text}
        onFocus={(e) => { setOpen(true); e.target.select(); }}
        onChange={(e) => { setText(e.target.value); setOpen(true); if (!e.target.value && emptyLabel) onChange(""); }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, opts.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === "Enter" && open && opts[hi]) { e.preventDefault(); pick(opts[hi]); }
          else if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); }
        }} />
      {open && !disabled ? (
        <ul className="pickerlist" id={listId} role="listbox" ref={listRef}
          style={pos ? { position: "fixed", left: pos.left, width: pos.width, right: "auto", ...(pos.up ? { top: "auto", bottom: window.innerHeight - pos.top } : { top: pos.top }) } : undefined}>
          {opts.length ? opts.map((o, i) => (
            <li key={o.id || "__all"} role="option" aria-selected={o.id === value} className={`${i === hi ? "hi" : ""} ${o.id === value ? "sel" : ""}`}
              onMouseDown={(e) => { e.preventDefault(); pick(o); }} onMouseEnter={() => setHi(i)}>
              <span>{o.label}</span>{o.sub ? <small>{o.sub}</small> : null}</li>
          )) : <li className="none">No client matches “{text}”</li>}
        </ul>) : null}
    </div>
  );
}
