import { useEffect, useRef, useState } from "react";
import { Search, X, ArrowUpRight } from "lucide-react";
export type SearchEntry = {
  id: string;
  title: string;
  kind: string;
  context: string;
  text: string;
  open: () => void;
};
export function ConversationSearch({
  entries,
  onClose,
}: {
  entries: SearchEntry[];
  onClose: () => void;
}) {
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
          {!results.length && (
            <p>Nessun risultato. Prova un nome o una parola presente nel contenuto.</p>
          )}
        </div>
        <footer>
          {results.length} risultati · ↑ ↓ per scegliere · Invio per aprire · ricerca testuale nei
          dati della demo
        </footer>
      </section>
    </dialog>
  );
}
