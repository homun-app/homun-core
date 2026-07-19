import { useEffect, useMemo, useRef, useState } from "react";
import { FONT_FAMILIES, FONT_CATEGORIES } from "./fontsManifest";

const CATEGORY_ORDER = ["sans", "serif", "slab", "mono"];
const CATEGORY_LABEL: Record<string, string> = {
  sans: "Sans", serif: "Serif", slab: "Slab", mono: "Mono",
};

/** Searchable font picker over the bundled curated set (S4). Options render in
 *  their own family via the @font-face BrandDrawer injects once into <head>. A
 *  plain <select> can't search or show specimens — this can. Fail-open: a value
 *  outside the set still shows (legacy kits). */
export function FontSelect({
  value, onChange, label,
}: { value: string; onChange: (family: string) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = FONT_FAMILIES.filter((f) => f.toLowerCase().includes(q));
    return CATEGORY_ORDER.map((cat) => ({
      cat,
      fonts: match.filter((f) => (FONT_CATEGORIES[f] ?? "sans") === cat),
    })).filter((g) => g.fonts.length > 0);
  }, [query]);

  return (
    <div className="font-select" ref={rootRef}>
      <button
        type="button"
        className="font-select-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{ fontFamily: `'${value}', sans-serif` }}
        onClick={() => { setOpen((o) => !o); setQuery(""); }}
      >
        {value || label}
      </button>
      {open && (
        <div className="font-select-pop" role="listbox" aria-label={label}>
          <input
            className="font-select-search"
            autoFocus
            placeholder="Cerca font…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="font-select-list">
            {groups.map((g) => (
              <div key={g.cat} className="font-select-group">
                <div className="font-select-group-label">{CATEGORY_LABEL[g.cat]}</div>
                {g.fonts.map((f) => (
                  <button
                    type="button"
                    key={f}
                    role="option"
                    aria-selected={f === value}
                    className={`font-select-option${f === value ? " selected" : ""}`}
                    style={{ fontFamily: `'${f}', sans-serif` }}
                    onClick={() => { onChange(f); setOpen(false); }}
                  >
                    {f}
                  </button>
                ))}
              </div>
            ))}
            {groups.length === 0 && <div className="font-select-empty">Nessun font</div>}
          </div>
        </div>
      )}
    </div>
  );
}
