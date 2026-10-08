/** Impostazioni → Spazi remoti: questa installazione come peer (F5 pilot).
 *
 * Onboarding guidato «Ho un invito»: host + token + nome, il motore riscatta
 * con la chiave del proprio dispositivo. Poi le connessioni con le proiezioni
 * sincronizzate (Fonte: motore remoto) e la sincronizzazione manuale. */
import { useCallback, useEffect, useState } from "react";
import { Globe, RefreshCw, ShieldCheck } from "lucide-react";

import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { useEngineStatus } from "@/hooks/useEngineStatus";
import {
  connectEnginePeer,
  listEnginePeerConnections,
  listEnginePeerProjections,
  syncEnginePeerProject,
  type PeerConnection,
  type PeerProjection,
} from "@/lib/engine-peers-client";

export function EngineRemoteSpacesSection() {
  const status = useEngineStatus();
  const enabled = status.connection === "connected";
  const [connections, setConnections] = useState<PeerConnection[]>([]);
  const [projections, setProjections] = useState<PeerProjection[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ host: "", invite: "", name: "" });

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      setError(null);
      const [nextConnections, nextProjections] = await Promise.all([
        listEnginePeerConnections(), listEnginePeerProjections(),
      ]);
      setConnections(nextConnections);
      setProjections(nextProjections);
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function act(operation: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await refresh();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="st-people" aria-label="Spazi remoti">
      <h3><Globe size={15} /> Spazi remoti</h3>
      <p className="cw-hint">
        Entra in uno spazio Homun di un'altra macchina con l'invito ricevuto: il tuo
        dispositivo si registra con la propria chiave e vedi solo i progetti che ti
        vengono condivisi. Fonte: motore remoto, mai mescolato col tuo spazio.
      </p>

      <form
        className="st-people__invite-row"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !form.host || !form.invite || !form.name) return;
          void act(async () => {
            await connectEnginePeer({
              host: form.host, inviteToken: form.invite, displayName: form.name,
              deviceName: "Homun di questo Mac",
            });
            setForm({ host: "", invite: "", name: "" });
          });
        }}
      >
        <label>Host
          <input value={form.host} placeholder="http://192.168.1.10:8765"
                 disabled={busy} onChange={(e) => setForm({ ...form, host: e.target.value })} />
        </label>
        <label>Codice invito
          <input value={form.invite} placeholder="invite:pinv_…" disabled={busy}
                 onChange={(e) => setForm({ ...form, invite: e.target.value })} />
        </label>
        <label>Il tuo nome
          <input value={form.name} placeholder="Giulia" disabled={busy}
                 onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <button type="submit" className="cw-primary" disabled={busy || !form.host || !form.invite || !form.name}>
          Entra nello spazio
        </button>
      </form>

      {loading ? (
        <p className="cw-hint">Caricamento…</p>
      ) : (
        <div className="st-people__list">
          {connections.map((connection) => (
            <article key={connection.host} className="st-person">
              <header>
                <strong>{connection.display_name || connection.person_id}</strong>
                <small>{connection.host}</small>
              </header>
              <p className="cw-hint">
                <ShieldCheck size={12} /> dispositivo {connection.key_fingerprint.slice(0, 19)}… ·
                collegato dal {new Date(connection.paired_at).toLocaleDateString("it-IT")}
              </p>
              {projections.filter((p) => p.host === connection.host).map((projection) => (
                <p key={projection.project_id} className="cw-hint">
                  🌐 {projection.project?.name ?? projection.project_id}
                  <small> · Fonte: motore remoto</small>
                  <button type="button" className="cs-link" disabled={busy}
                          onClick={() => void act(() => syncEnginePeerProject(
                            connection.host, projection.project_id))}>
                    <RefreshCw size={11} /> Sincronizza ora
                  </button>
                </p>
              ))}
              {projections.filter((p) => p.host === connection.host).length === 0 && (
                <p className="cw-hint">
                  Nessun progetto sincronizzato: servono un invito di condivisione e
                  «Sincronizza» dopo che l'host ti concede l'accesso.
                </p>
              )}
            </article>
          ))}
          {connections.length === 0 && (
            <p className="cw-hint">Nessuno spazio remoto: entra con un invito qui sopra.</p>
          )}
        </div>
      )}

      <HomunErrorNotice error={error} />
    </section>
  );
}
