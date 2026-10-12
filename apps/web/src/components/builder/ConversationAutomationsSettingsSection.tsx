/** Impostazioni → Automazioni: source-aware summary. Counts come as props; the section stays presentational. */
export function ConversationAutomationsSettingsSection({
  source,
  activeCount = 0,
  pausedCount = 0,
  onOpenRoutines,
}: {
  source: "engine" | "simulation";
  activeCount?: number;
  pausedCount?: number;
  onOpenRoutines?: () => void;
}) {
  if (source === "simulation") {
    return (
      <>
        <h3>Automazioni</h3>
        <p>
          <strong>Fonte: simulazione.</strong> Le routine di questa prova vivono solo in questo
          browser: le esecuzioni partono con «Simula esecuzione» e nessun timer è reale.
        </p>
      </>
    );
  }
  return (
    <>
      <h3>Automazioni</h3>
      <p>
        <strong>Fonte: motore.</strong> Lo scheduler persistente crea un lavoro nuovo a ogni
        ricorrenza e ti avvisa in chat: l’approvazione resta tua.
      </p>
      <div className="cv-settings-card">
        <strong>
          {activeCount} attiv{activeCount === 1 ? "a" : "e"} · {pausedCount} in pausa
        </strong>
        <p>Routine ricorrenti presenti in questo spazio di lavoro.</p>
      </div>
      {onOpenRoutines && (
        <button type="button" className="cw-secondary" onClick={onOpenRoutines}>
          Apri Automazioni
        </button>
      )}
    </>
  );
}
