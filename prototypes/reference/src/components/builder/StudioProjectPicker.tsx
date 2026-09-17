import { useEffect, useRef, useState, useId } from "react";
import { ChevronDown, Search, X } from "lucide-react";
export function StudioProjectPicker({
  label,
  options,
  value,
  onChange,
  emptyLabel = "Spazio generale",
}: {
  label: string;
  options: { id: string; name: string }[];
  value: string[];
  onChange: (ids: string[]) => void;
  emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const filtered = options.filter((p) =>
    p.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const selected = options.filter((p) => value.includes(p.id));
  return (
    <div
      className="st-project-picker"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <span className="st-picker-label" id={id + "-label"}>
        {label}
      </span>
      <button
        type="button"
        ref={trigger}
        className="st-picker-trigger"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <span>
          {!value.length
            ? emptyLabel
            : selected.length === 1
              ? selected[0]!.name
              : `${value.length} selezionati`}
        </span>
        <ChevronDown size={15} />
      </button>
      {!!value.length && (
        <div className="st-picker-tags">
          {selected.slice(0, 2).map((p) => (
            <span key={p.id}>
              {p.name}
              <button
                type="button"
                aria-label={`Rimuovi ${p.name}`}
                onClick={() => onChange(value.filter((x) => x !== p.id))}
              >
                <X size={11} />
              </button>
            </span>
          ))}
          {value.length > 2 && <small>+{value.length - 2}</small>}
        </div>
      )}
      {open && (
        <div id={id} className="st-picker-panel" role="group" aria-labelledby={id + "-label"}>
          <div className="st-picker-search">
            <Search size={14} />
            <input
              ref={search}
              aria-label={`Cerca: ${label}`}
              placeholder="Cerca…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="st-picker-results">
            {filtered.map((p) => (
              <label key={p.id}>
                <input
                  type="checkbox"
                  checked={value.includes(p.id)}
                  onChange={(e) =>
                    onChange(e.target.checked ? [...value, p.id] : value.filter((x) => x !== p.id))
                  }
                />
                <span>{p.name}</span>
              </label>
            ))}
            {!filtered.length && <p>Nessun progetto trovato.</p>}
          </div>
          <div className="st-picker-footer">
            <button type="button" onClick={() => onChange([])}>
              {emptyLabel}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              Fatto
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
