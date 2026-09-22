/** Automations: honest "not yet" — the recurring loop lands with the engine scheduler. */
export function ConversationAutomationsSettingsSection() {
  return (
    <>
      <h3>Automazioni</h3>
      <p>
        Lavori ripetibili e routine ricorrenti: la struttura a fasi del motore è pronta, ma lo
        scheduler che li fa ripartire da solo non è ancora attivo. Non ti promettiamo
        automazioni che poi restano ferme.
      </p>
      <div className="cv-settings-card">
        <strong>Cosa funziona già</strong>
        <p>
          Puoi rifidare lo stesso lavoro quando vuoi: la chat conserva accordo, fasi e
          risultati, e i materiali restano nel progetto.
        </p>
      </div>
      <div className="cv-settings-card">
        <strong>Cosa arriva</strong>
        <p>
          Routine con cadenza («ogni lunedì alle 9»), verifica dei risultati prima della
          consegna e arresto con un tocco. Compariranno qui.
        </p>
      </div>
    </>
  );
}
