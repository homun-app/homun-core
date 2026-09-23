/** Update card for the desktop shell: installed version and a manual check.
 * Rendered only when the preload exposes the update verbs (packaged app). */
import { useEffect, useState } from "react";

type UpdateState = {
  current: string;
  available: boolean;
  version: string | null;
  error?: string;
};

export function ConversationUpdateStatus() {
  const desktop = typeof window !== "undefined" ? window.homunDesktop : undefined;
  const [current, setCurrent] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    desktop?.updateStatus
      ?.()
      .then((status) => {
        if (live) setCurrent(status.current);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (!desktop?.updateCheck) return null;

  async function check() {
    setChecking(true);
    setError(null);
    setResult(null);
    try {
      const outcome = await desktop!.updateCheck!();
      if (outcome.error) setError("Controllo non riuscito: riprova più tardi.");
      else setResult(outcome);
    } catch {
      setError("Controllo non riuscito: riprova più tardi.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="cv-settings-card">
      <strong>Aggiornamenti</strong>
      <p>
        {current ? (
          <>
            Versione installata <strong>{current}</strong>. Il controllo automatico avviene
            all'avvio; nulla si installa senza il tuo consenso.
          </>
        ) : (
          "Il controllo automatico avviene all'avvio; nulla si installa senza il tuo consenso."
        )}
      </p>
      <div className="cs-actions">
        <button type="button" className="cw-secondary" disabled={checking} onClick={() => void check()}>
          {checking ? "Controllo…" : "Controlla aggiornamenti adesso"}
        </button>
      </div>
      {result &&
        (result.available ? (
          <p role="status">Nuova versione {result.version}: segui la finestra di aggiornamento.</p>
        ) : (
          <p role="status">Homun è aggiornato ({result.current}).</p>
        ))}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
