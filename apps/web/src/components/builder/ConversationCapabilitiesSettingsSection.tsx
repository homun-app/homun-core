/** Engine capability catalog: what really runs today, honestly labeled. */
import { useEffect, useState } from "react";
import { ENGINE_DEFAULT_BASE_URL } from "@/lib/engine-client";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { ConversationMcpSettingsSection } from "./EngineMcpSettings";

type CapabilityItem = {
  id: string;
  kind: string;
  summary: string;
  ready: boolean;
  limits: Record<string, number>;
};

const KIND_LABELS: Record<string, string> = {
  executable: "Esegue nel motore",
  preparation: "Solo preparazione",
};

export function ConversationCapabilitiesSettingsSection() {
  const [items, setItems] = useState<CapabilityItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let active = true;
    fetch(`${ENGINE_DEFAULT_BASE_URL}/v1/workspaces/ws_local/capabilities`, {
      headers: { Accept: "application/json", "X-Homun-Actor-Id": "person_fabio" },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Catalogo capacità: HTTP ${response.status}`);
        return (await response.json()) as { items: CapabilityItem[] };
      })
      .then((body) => { if (active) setItems(body.items); })
      .catch((cause) => { if (active) setError(cause); });
    return () => { active = false; };
  }, []);

  return (
    <>
      <ConversationMcpSettingsSection />
      <h3>Capacità del motore</h3>
      <p>
        Ciò che la tua squadra sa fare davvero, dal registro del motore: le capacità elencate
        qui sono le uniche che i collaboratori possono eseguire. Nessuno può prometterti
        altro.
      </p>
      {items === null && !error && <p role="status">Leggo il catalogo del motore…</p>}
      {items?.map((item) => (
        <div className="cv-settings-card" key={item.id}>
          <strong>{item.summary}</strong>
          <p>
            {KIND_LABELS[item.kind] ?? item.kind} ·{" "}
            {item.kind === "executable"
              ? item.ready
                ? "pronta con i materiali attuali"
                : "in attesa dei materiali previsti"
              : "pronta"}
          </p>
        </div>
      ))}
      <div className="cv-settings-card">
        <strong>Plugin esterni e MCP</strong>
        <p>
          Non ancora disponibili. Quando arriveranno, compariranno qui con permessi espliciti
          per collaboratore: mai attivati in silenzio.
        </p>
      </div>
      <HomunErrorNotice error={error} />
    </>
  );
}
