import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
export type MaterialDestination = {
  id: string;
  name: string;
  kind: "project" | "work";
  detail: string;
};
export function ConversationMaterialLinker({
  count,
  destinations,
  recent,
  contextId,
  restricted,
  onClose,
  onConfirm,
}: {
  count: number;
  destinations: MaterialDestination[];
  recent: string[];
  contextId?: string | undefined;
  restricted: boolean;
  onClose: () => void;
  onConfirm: (selected: MaterialDestination[]) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("Tutti");
  const [chosen, setChosen] = useState<string[]>([]);
  const [ack, setAck] = useState(false);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement;
    ref.current?.showModal();
    return () => prev?.focus();
  }, []);
  const key = (d: MaterialDestination) => d.kind + ":" + d.id;
  const visible = destinations
    .filter(
      (d) =>
        (kind === "Tutti" || d.kind === (kind === "Progetti" ? "project" : "work")) &&
        (d.name + " " + d.detail).toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) => {
      const rank = (d: MaterialDestination) =>
        d.kind === "work" && d.id === contextId ? -2 : recent.includes(key(d)) ? -1 : 0;
      return rank(a) - rank(b) || a.name.localeCompare(b.name, "it", { numeric: true });
    });
  return createPortal(
    <dialog
      className="cm-linker"
      ref={ref}
      aria-labelledby="cm-link-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <div>
          <h2 id="cm-link-title">
            Collega {count} {count === 1 ? "materiale" : "materiali"}
          </h2>
          <p>Gli originali restano nella raccolta.</p>
        </div>
        <button aria-label="Chiudi collegamenti" onClick={onClose}>
          ×
        </button>
      </header>
      <input
        autoFocus
        aria-label="Cerca destinazioni"
        placeholder="Cerca progetto, conversazione o collaboratore…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <nav aria-label="Tipo di destinazione">
        {["Tutti", "Progetti", "Conversazioni"].map((k) => (
          <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
            {k}
          </button>
        ))}
      </nav>
      {chosen.length > 0 && (
        <div className="cm-link-chips">
          {destinations
            .filter((d) => chosen.includes(key(d)))
            .map((d) => (
              <button
                key={key(d)}
                onClick={() => setChosen(chosen.filter((k) => k !== key(d)))}
                aria-label={"Rimuovi destinazione " + d.name}
              >
                {d.name} ×
              </button>
            ))}
        </div>
      )}
      <small>{visible.length} destinazioni · contesto attuale e recenti per primi</small>
      <div className="cm-link-results">
        {visible.map((d) => (
          <label key={key(d)}>
            <input
              type="checkbox"
              checked={chosen.includes(key(d))}
              onChange={() =>
                setChosen(
                  chosen.includes(key(d))
                    ? chosen.filter((k) => k !== key(d))
                    : [...chosen, key(d)],
                )
              }
            />
            <span>
              <strong>{d.name}</strong>
              <small>
                {d.kind === "project" ? "Progetto" : "Conversazione"} · {d.detail}
                {d.kind === "work" && d.id === contextId
                  ? " · attuale"
                  : recent.includes(key(d))
                    ? " · recente"
                    : ""}
              </small>
            </span>
          </label>
        ))}
        {!visible.length && <p>Nessun risultato. Prova un altro nome.</p>}
      </div>
      {restricted && (
        <label className="cm-link-access">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          Mantieni gli accessi limitati dei materiali selezionati. Il collegamento non concede nuovi
          permessi.
        </label>
      )}
      <footer>
        <button onClick={onClose}>Annulla</button>
        <button
          disabled={!chosen.length || (restricted && !ack)}
          onClick={() => onConfirm(destinations.filter((d) => chosen.includes(key(d))))}
        >
          Collega a {chosen.length} destinazioni
        </button>
      </footer>
    </dialog>,
    document.body,
  );
}
