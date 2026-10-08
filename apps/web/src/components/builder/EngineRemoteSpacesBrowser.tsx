/** Spazi remoti — lettura dei progetti condivisi (Fonte: motore remoto).
 *
 * Il peer sfoglia le conversazioni sincronizzate dei propri spazi remoti:
 * read-only onesto, apertura con sync automatica, badge di provenienza.
 * L'onboarding (invito) resta nelle Impostazioni → Spazi remoti. */
import { useCallback, useEffect, useState } from "react";
import { Globe, RefreshCw, MessagesSquare, ListChecks, ChevronLeft } from "lucide-react";

import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { Markdown } from "./ChatMarkdown";
import { useEngineStatus } from "@/hooks/useEngineStatus";
import {
  fetchEnginePeerProjection,
  listEnginePeerProjections,
  syncEnginePeerProject,
  type PeerProjection,
  type PeerProjectionContent,
} from "@/lib/engine-peers-client";

export function EngineRemoteSpacesBrowser() {
  const status = useEngineStatus();
  const enabled = status.connection === "connected";
  const [projections, setProjections] = useState<PeerProjection[]>([]);
  const [open, setOpen] = useState<{ host: string; projectId: string } | null>(null);
  const [content, setContent] = useState<PeerProjectionContent | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      setError(null);
      setProjections(await listEnginePeerProjections());
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => { void refresh(); }, [refresh]);

  const openProject = useCallback(async (host: string, projectId: string) => {
    setSyncing(true);
    setError(null);
    try {
      await syncEnginePeerProject(host, projectId); // fresco all'apertura
    } catch (cause) {
      setError(cause); // sync fallito: si legge l'ultima proiezione avuta
    } finally {
      setSyncing(false);
    }
    try {
      const view = await fetchEnginePeerProjection(host, projectId);
      setContent(view);
      setOpen({ host, projectId });
      setConversationId(view.snapshot.conversations[0]?.id ?? null);
    } catch (cause) {
      setError(cause);
    }
  }, []);

  if (!enabled) {
    return (
      <section className="cw-workspace" aria-label="Spazi remoti">
        <h3><Globe size={15} /> Spazi remoti</h3>
        <p className="cw-hint">Motore non connesso.</p>
      </section>
    );
  }

  if (open && content) {
    const conversation = content.snapshot.conversations.find((c) => c.id === conversationId)
      ?? content.snapshot.conversations[0];
    return (
      <section className="cw-workspace cw-remote-space" aria-label={`Progetto remoto ${content.snapshot.project.name}`}>
        <header className="cw-remote-space__head">
          <button type="button" className="cs-link" onClick={() => { setOpen(null); setContent(null); }}>
            <ChevronLeft size={14} /> Spazi remoti
          </button>
          <h3>
            <Globe size={15} /> {content.snapshot.project.name}
            <small> · {open.host} · Fonte: motore remoto · sola lettura</small>
          </h3>
          <button type="button" className="cs-link" disabled={syncing}
                  onClick={() => void openProject(open.host, open.projectId)}>
            <RefreshCw size={13} className={syncing ? "animate-spin" : undefined} /> Sincronizza
          </button>
        </header>
        <div className="cw-remote-space__columns">
          <nav className="cw-remote-space__nav" aria-label="Conversazioni remote">
            {content.snapshot.conversations.map((c) => (
              <button key={c.id} type="button"
                      className={`cw-remote-space__conv ${c.id === conversation?.id ? "is-active" : ""}`}
                      onClick={() => setConversationId(c.id)}>
                <MessagesSquare size={13} /> {c.title || "Conversazione"}
                <small>{c.messages.length} messaggi</small>
              </button>
            ))}
            {content.snapshot.conversations.length === 0 && (
              <p className="cw-hint">Nessuna conversazione nel progetto condiviso.</p>
            )}
            {content.snapshot.works.length > 0 && (
              <>
                <div className="cw-remote-space__label">Lavori</div>
                {content.snapshot.works.map((w) => (
                  <div key={w.id} className="cw-remote-space__work">
                    <ListChecks size={13} /> {w.title}
                    <small>{w.status}</small>
                  </div>
                ))}
              </>
            )}
          </nav>
          <div className="cw-remote-space__thread">
            {conversation?.messages.map((m) => (
              <article key={m.id} className="cw-remote-space__message" data-role={m.author_id.startsWith("person_") ? "user" : "agent"}>
                <header>
                  <strong>{m.author_id === "homun_engine" ? "Homun" : m.author_id}</strong>
                  <small>{new Date(m.created_at).toLocaleString("it-IT")}</small>
                </header>
                <Markdown content={m.text} />
              </article>
            ))}
            {conversation && conversation.messages.length === 0 && (
              <p className="cw-hint">Conversazione vuota.</p>
            )}
          </div>
        </div>
        <HomunErrorNotice error={error} />
      </section>
    );
  }

  return (
    <section className="cw-workspace" aria-label="Spazi remoti">
      <h3><Globe size={15} /> Spazi remoti</h3>
      {loading ? (
        <p className="cw-hint">Caricamento…</p>
      ) : projections.length === 0 ? (
        <p className="cw-hint">
          Nessuno spazio remoto sincronizzato. Entra con un invito dalle
          Impostazioni → Spazi remoti; poi l'host condivide un progetto e premi
          «Sincronizza ora».
        </p>
      ) : (
        <div className="cw-remote-space__list">
          {projections.map((p) => (
            <button key={`${p.host}:${p.project_id}`} type="button"
                    className="cw-remote-space__card"
                    onClick={() => void openProject(p.host, p.project_id)}>
              <Globe size={14} />
              <div>
                <strong>{p.project?.name ?? p.project_id}</strong>
                <small> · {p.host} · Fonte: motore remoto</small>
              </div>
            </button>
          ))}
        </div>
      )}
      <HomunErrorNotice error={error} />
    </section>
  );
}
