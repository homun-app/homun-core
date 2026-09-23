import { useEffect, useRef, useState } from "react";
import { ConversationSelect } from "./ConversationSelect";
import { createPortal } from "react-dom";
import { Check, Plus, Search, X, Puzzle } from "lucide-react";
import { memberPluginCatalog } from "./conversation-members";

export function ConversationPluginCatalog({
  assigned,
  target,
  onAdd,
  onClose,
  initialQuery = "",
}: {
  assigned: string[];
  target?: string;
  onAdd: (name: string) => void;
  onClose: () => void;
  initialQuery?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState(initialQuery);
  const [category, setCategory] = useState("Tutte");
  const [source, setSource] = useState("Tutte le origini");
  const [feedback, setFeedback] = useState("");
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => {
      element?.close();
      previous?.focus();
    };
  }, []);
  const visible = memberPluginCatalog.filter(
    (p) =>
      (category === "Tutte" || p.category === category) &&
      (source === "Tutte le origini" || p.source === source) &&
      `${p.name} ${p.description} ${p.source} ${p.category}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  return createPortal(
    <dialog
      ref={dialog}
      className="cp-catalog"
      aria-labelledby="plugin-catalog-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const box = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < box.left ||
            e.clientX > box.right ||
            e.clientY < box.top ||
            e.clientY > box.bottom
          )
            onClose();
        }
      }}
    >
      <header className="cp-header">
        <div>
          <h2 id="plugin-catalog-title">Aggiungi strumenti</h2>
          <p>{target ? `Collega a ${target}` : "Aggiungi al tuo spazio"}</p>
        </div>
        <button aria-label="Chiudi catalogo plugin" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <div className="cp-search">
        <Search size={18} />
        <input
          autoFocus
          aria-label="Cerca nel catalogo plugin"
          placeholder="Cerca uno strumento o cosa vuoi fare…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ConversationSelect
          label="Origine plugin"
          value={source}
          onChange={setSource}
          options={["Tutte le origini", "Composio", "MCP", "Skill", "Aziendale"]}
        />
      </div>
      <div className="cp-body">
        <nav aria-label="Categorie plugin">
          {["Tutte", ...new Set(memberPluginCatalog.map((p) => p.category))].map((c) => (
            <button key={c} aria-pressed={category === c} onClick={() => setCategory(c)}>
              {c}
            </button>
          ))}
        </nav>
        <section className="cp-results" aria-label="Risultati catalogo">
          <p className="cp-count">{visible.length} strumenti</p>
          <div className="cp-grid">
            {visible.map((p) => (
              <article key={p.name}>
                <div className="cp-card-title">
                  <span className="cp-icon">
                    <Puzzle size={18} />
                  </span>
                  <div>
                    <h3>{p.name}</h3>
                    <small>
                      {p.source} · {p.category}
                    </small>
                  </div>
                </div>
                <p>{p.description}</p>
                <button
                  disabled={assigned.includes(p.name)}
                  onClick={() => {
                    onAdd(p.name);
                    setFeedback(
                      `${p.name} ${target ? `collegato a ${target}` : "aggiunto allo spazio"}.`,
                    );
                  }}
                >
                  {assigned.includes(p.name) ? <Check size={14} /> : <Plus size={14} />}
                  {assigned.includes(p.name)
                    ? target
                      ? "Collegato"
                      : "Aggiunto"
                    : target
                      ? "Collega"
                      : "Aggiungi"}
                </button>
              </article>
            ))}
          </div>
          {!visible.length && (
            <div className="cp-empty">
              <h3>Nessun risultato</h3>
              <p>Prova un’altra parola o amplia i filtri.</p>
              <button
                onClick={() => {
                  setQuery("");
                  setCategory("Tutte");
                  setSource("Tutte le origini");
                }}
              >
                Azzera filtri
              </button>
            </div>
          )}
        </section>
      </div>
      <footer>
        <span role="status">
          {feedback || "Connessioni e autorizzazioni si configurano da te, strumento per strumento"}
        </span>
        <button onClick={onClose}>Fatto</button>
      </footer>
    </dialog>,
    document.body,
  );
}
