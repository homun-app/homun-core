import { useEffect, useRef, useState } from "react";
import { Search, X, ArrowUpRight } from "lucide-react";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import type { ConversationSearchSources } from "@/hooks/useConversationSearchEntries";
export type SearchEntry = {
  id: string;
  title: string;
  kind: string;
  context: string;
  text: string;
  open: () => void;
};
/**
 * Global ⌘K dialog. No footer: the global engine state is the workspace
 * banner's job, and the data-source mode is declared once in the main
 * interface — never here. A source that did not answer is stated where the
 * user is looking: the empty state when nothing came back, one discreet
 * line on top when only part of the index did.
 */
export function ConversationSearch({
  search,
  onClose,
}: {
  /** What ⌘K reads: index entries plus the health of its engine sources. */
  search: { entries: SearchEntry[]; sources?: ConversationSearchSources };
  onClose: () => void;
}) {
  const { entries, sources } = search;
  const ref = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("Tutto");
  const [index, setIndex] = useState(0);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const normalize = (v: string) =>
    v
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  const results = entries.filter(
    (e) =>
      (kind === "Tutto" || e.kind === kind) &&
      terms.every((t) => normalize(`${e.title} ${e.text} ${e.context}`).includes(t)),
  );
  const materialsMissing = sources?.materials?.status === "unavailable";
  return (
    <dialog
      ref={ref}
      className="cw-super-search"
      aria-label="Ricerca globale"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section>
        <header>
          <Search size={20} />
          <input
            autoFocus
            aria-label="Cerca in tutto lo spazio"
            placeholder="Persone, lavori, messaggi, documenti…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, results.length - 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              }
              if (e.key === "Enter" && results[index]) {
                e.preventDefault();
                results[index]!.open();
                onClose();
              }
            }}
          />
          <button className="cw-icon" aria-label="Chiudi ricerca" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <nav aria-label="Filtri ricerca">
          {["Tutto", ...new Set(entries.map((e) => e.kind))].map((k) => (
            <button
              className={k === kind ? "active" : ""}
              key={k}
              onClick={() => {
                setKind(k);
                setIndex(0);
              }}
            >
              {k}
            </button>
          ))}
        </nav>
        <div className="cs-search-results">
          {results.length > 0 && materialsMissing && (
            <HomunErrorNotice
              error={sources?.materials?.error}
              label="Alcuni materiali mancano:"
              className="cs-search-source-note"
            />
          )}
          {results.map((r, i) => (
            <button
              key={r.id}
              className={i === index ? "active" : ""}
              onClick={() => {
                r.open();
                onClose();
              }}
            >
              <span>
                <small>
                  {r.kind} · {r.context}
                </small>
                <strong>{r.title}</strong>
                {query && r.kind === "Messaggi" && <p>{r.text.slice(0, 180)}</p>}
              </span>
              <ArrowUpRight size={17} />
            </button>
          ))}
          {!results.length &&
            (materialsMissing ? (
              <div className="cs-search-empty">
                <p>Nessun risultato. I materiali non sono raggiungibili in questo momento.</p>
                <HomunErrorNotice
                  error={sources?.materials?.error}
                  className="cs-search-source-note"
                />
              </div>
            ) : (
              <p>Nessun risultato. Prova un nome o una parola presente nel contenuto.</p>
            ))}
        </div>
      </section>
    </dialog>
  );
}
