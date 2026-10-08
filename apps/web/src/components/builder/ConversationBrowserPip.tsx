/** PiP del browser dell'agente: vedi se sta navigando e dove, in diretta. */
import { useEffect, useState } from "react";
import { ExternalLink, Globe, X } from "lucide-react";
import { ENGINE_DEFAULT_BASE_URL } from "@/lib/engine-client.ts";
import { DEFAULT_WORKSPACE_ID, defaultLocalActor } from "@/lib/engine-domain-client.ts";

type PipState = {
  active: boolean;
  url?: string;
  screenshot?: string;
  web?: { tool: string; url: string; titles: string[] };
};

/**
 * Pannello flottante: polling leggero mentre il run lavora; quando l'agente
 * apre il browser compaiono URL corrente e screenshot della pagina.
 */
export function ConversationBrowserPip({
  conversationId, runActive,
}: { conversationId?: string | undefined; runActive: boolean }) {
  const [state, setState] = useState<PipState>({ active: false });
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    if (!conversationId || !runActive || closed) {
      setState({ active: false });
      return;
    }
    let live = true;
    const poll = async () => {
      try {
        const response = await fetch(
          `${ENGINE_DEFAULT_BASE_URL}/v1/workspaces/${DEFAULT_WORKSPACE_ID}` +
            `/chat-agent/${encodeURIComponent(conversationId)}/browser-pip?actor=` +
            encodeURIComponent(defaultLocalActor().id),
        );
        if (!response.ok) return;
        const data = (await response.json()) as PipState;
        if (live) setState(data);
      } catch {
        /* il PiP è best-effort: l'attività si vede dal blocco live */
      }
    };
    void poll();
    const timer = setInterval(poll, 2500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [conversationId, runActive, closed]);

  if (!conversationId || !runActive || closed || !state.active) return null;

  return (
    <aside
      aria-label="Browser dell'agente in diretta"
      className="fixed right-4 bottom-4 z-50 w-80 overflow-hidden rounded-xl border border-[#dce4d5] bg-white shadow-lg"
    >
      <div className="flex items-center gap-1.5 border-b border-[#dce4d5] bg-[#f6f8f3] px-2.5 py-1.5">
        <Globe size={12} className="shrink-0 text-[#235940]" aria-hidden />
        <span className="truncate text-[11px] text-[#263832]" title={state.url}>
          {state.web?.url ?? state.url ?? "in navigazione…"}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {state.url && (
            <a
              href={state.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#647a6d] hover:text-[#1c2d22]"
              title="Apri la pagina"
            >
              <ExternalLink size={12} aria-hidden />
            </a>
          )}
          <button
            type="button"
            className="text-[#647a6d] hover:text-[#1c2d22]"
            onClick={() => setClosed(true)}
            title="Chiudi il riquadro"
          >
            <X size={12} aria-hidden />
          </button>
        </span>
      </div>
      {state.web && !state.screenshot ? (
        <div className="space-y-1.5 px-2.5 py-2">
          <p className="text-[11px] text-[#647a6d]">
            {state.web.tool === "web_search" ? "sta cercando" : "sta leggendo"}:
          </p>
          <p className="truncate font-mono text-[11px] text-[#1c2d22]" title={state.web.url}>
            {state.web.url}
          </p>
          {state.web.titles.length > 0 && (
            <ul className="space-y-0.5">
              {state.web.titles.map((title) => (
                <li key={title} className="truncate text-[11px] text-[#263832]">· {title}</li>
              ))}
            </ul>
          )}
        </div>
      ) : state.screenshot ? (
        <img
          src={state.screenshot}
          alt="Pagina corrente vista dall'agente"
          className="block w-full bg-white"
        />
      ) : (
        <div className="grid h-24 place-items-center text-[11px] text-[#9db3ad]">
          caricamento della pagina…
        </div>
      )}
    </aside>
  );
}
