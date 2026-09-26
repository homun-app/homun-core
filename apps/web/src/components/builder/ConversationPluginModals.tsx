import React from "react";
import { X, ShieldCheck, Cpu, Layers, Lock, Sparkles, Server } from "lucide-react";
import { type Skill } from "@/lib/engine-mcp-client";

export function AddMcpServerModal({
  form,
  setForm,
  onSubmit,
  onClose,
}: {
  form: {
    name: string;
    transport: "stdio" | "http";
    command: string;
    args: string;
    url: string;
  };
  setForm: React.Dispatch<
    React.SetStateAction<{
      name: string;
      transport: "stdio" | "http";
      command: string;
      args: string;
      url: string;
    }>
  >;
  onSubmit: (e: React.FormEvent) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="cv-unified-modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cv-unified-modal" role="dialog" aria-modal="true">
        <header className="cv-unified-modal__head">
          <div className="flex items-center gap-2">
            <Server size={18} className="text-[#8fe3d0]" />
            <h3>Aggiungi server MCP</h3>
          </div>
          <button type="button" className="cv-unified-icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <form className="cv-unified-modal__body" onSubmit={onSubmit}>
          {/* Box didattico: Cosa accade */}
          <div className="p-3 rounded-lg bg-[rgba(21,122,110,0.12)] border border-[rgba(143,227,208,0.25)] text-xs text-[#9db3ad] space-y-2">
            <div className="flex items-center gap-1.5 font-semibold text-[#f4f1ee]">
              <ShieldCheck size={14} className="text-[#8fe3d0]" />
              <span>Cosa accade quando colleghi un server MCP:</span>
            </div>
            <ul className="list-disc pl-4 space-y-1">
              <li>
                <strong className="text-[#f4f1ee]">Rilevamento automatico:</strong> Homun interroga il server per catalogare gli strumenti disponibili (es. query database, lettura file).
              </li>
              <li>
                <strong className="text-[#f4f1ee]">Controllo umano (HITL):</strong> Nessuna azione esterna o scrittura avviene a tua insaputa. Gli agenti devono richiedere approvazione esplicita prima di invocare i tool.
              </li>
              <li>
                <strong className="text-[#f4f1ee]">Disponibilità:</strong> Puoi attivare o disattivare il server per la squadra in qualsiasi momento con un toggle.
              </li>
            </ul>
          </div>

          {/* Preset rapidi per MCP comuni */}
          <div>
            <span className="text-xs text-[#9db3ad] block mb-1.5 font-medium">
              Configurazioni MCP rapide pronte all'uso:
            </span>
            <div className="flex flex-wrap gap-1.5">
              {[
                {
                  name: "SQLite Database",
                  command: "npx",
                  args: "-y @modelcontextprotocol/server-sqlite --db ./data.sqlite",
                },
                {
                  name: "Filesystem Locale",
                  command: "npx",
                  args: "-y @modelcontextprotocol/server-filesystem ./workspace",
                },
                {
                  name: "GitHub Repositories",
                  command: "npx",
                  args: "-y @modelcontextprotocol/server-github",
                },
                {
                  name: "Fetch Web & HTTP",
                  command: "npx",
                  args: "-y @modelcontextprotocol/server-fetch",
                },
              ].map((tmpl) => (
                <button
                  key={tmpl.name}
                  type="button"
                  onClick={() =>
                    setForm({
                      ...form,
                      name: tmpl.name,
                      transport: "stdio",
                      command: tmpl.command,
                      args: tmpl.args,
                    })
                  }
                  className="text-xs px-2.5 py-1 rounded-md bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] text-[#9db3ad] hover:text-[#8fe3d0] hover:border-[rgba(143,227,208,0.3)] transition"
                >
                  + {tmpl.name}
                </button>
              ))}
            </div>
          </div>

          <div className="cv-unified-form-field">
            <label>Nome identificativo del server</label>
            <input
              type="text"
              placeholder="Es. SQLite Database, Filesystem Progetto..."
              value={form.name}
              required
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>

          <div className="cv-unified-form-field">
            <label>Tipo di trasporto</label>
            <select
              value={form.transport}
              onChange={(e) =>
                setForm({
                  ...form,
                  transport: e.target.value as "stdio" | "http",
                })
              }
            >
              <option value="stdio">stdio (Processo locale sulla macchina)</option>
              <option value="http">http (Server remoto SSE / HTTPS)</option>
            </select>
          </div>

          {form.transport === "stdio" ? (
            <>
              <div className="cv-unified-form-field">
                <label>Comando di avvio</label>
                <input
                  type="text"
                  placeholder="npx, node, python3, uvx..."
                  value={form.command}
                  required
                  onChange={(e) => setForm({ ...form, command: e.target.value })}
                />
              </div>
              <div className="cv-unified-form-field">
                <label>Argomenti del comando (separati da spazio)</label>
                <input
                  type="text"
                  placeholder="-y @modelcontextprotocol/server-sqlite --db ./db.sqlite"
                  value={form.args}
                  onChange={(e) => setForm({ ...form, args: e.target.value })}
                />
              </div>
            </>
          ) : (
            <div className="cv-unified-form-field">
              <label>URL Endpoint HTTP / SSE</label>
              <input
                type="url"
                placeholder="https://mcp.example.com/sse"
                value={form.url}
                required
                onChange={(e) => setForm({ ...form, url: e.target.value })}
              />
            </div>
          )}

          <div className="cv-unified-modal__actions">
            <button type="button" className="cv-unified-btn is-subtle" onClick={onClose}>
              Annulla
            </button>
            <button type="submit" className="cv-unified-btn is-primary">
              Crea e Connetti Server
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function AddSkillModal({
  form,
  setForm,
  onSubmit,
  onClose,
}: {
  form: {
    name: string;
    description: string;
    body: string;
  };
  setForm: React.Dispatch<
    React.SetStateAction<{
      name: string;
      description: string;
      body: string;
    }>
  >;
  onSubmit: (e: React.FormEvent) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="cv-unified-modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cv-unified-modal" role="dialog" aria-modal="true">
        <header className="cv-unified-modal__head">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-[#8fe3d0]" />
            <h3>Registra nuova Skill (Procedura Operativa)</h3>
          </div>
          <button type="button" className="cv-unified-icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <form className="cv-unified-modal__body" onSubmit={onSubmit}>
          <div className="p-3 rounded-lg bg-[rgba(21,122,110,0.12)] border border-[rgba(143,227,208,0.25)] text-xs text-[#9db3ad]">
            <strong className="text-[#f4f1ee] block mb-1">Cosa accade con una Skill:</strong>
            Una skill insegna agli agenti della squadra una sequenza di passaggi standardizzati (SOP) da seguire per compiti ricorrenti, garantendo coerenza di esecuzione tra tutti i collaboratori.
          </div>

          <div className="cv-unified-form-field">
            <label>Nome procedura</label>
            <input
              type="text"
              placeholder="Es. Generazione report trimestrale, Verifica PR"
              value={form.name}
              required
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>

          <div className="cv-unified-form-field">
            <label>Descrizione breve</label>
            <input
              type="text"
              placeholder="Cosa risolve questa procedura e quando gli agenti dovrebbero applicarla"
              value={form.description}
              required
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>

          <div className="cv-unified-form-field">
            <label>Istruzioni e passaggi procedurali (Markdown)</label>
            <textarea
              rows={6}
              placeholder="1. Analizza i dati di input...&#10;2. Esegui la convalida incrociata...&#10;3. Produci il documento in bozza..."
              value={form.body}
              required
              onChange={(e) => setForm({ ...form, body: e.target.value })}
            />
          </div>

          <div className="cv-unified-modal__actions">
            <button type="button" className="cv-unified-btn is-subtle" onClick={onClose}>
              Annulla
            </button>
            <button type="submit" className="cv-unified-btn is-primary">
              Registra procedura
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ViewSkillModal({
  skill,
  onClose,
  onToggle,
}: {
  skill: Skill;
  onClose: () => void;
  onToggle: (skill: Skill, turnOn: boolean) => Promise<void>;
}) {
  return (
    <div
      className="cv-unified-modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cv-unified-modal" role="dialog" aria-modal="true">
        <header className="cv-unified-modal__head">
          <h3>{skill.name}</h3>
          <button type="button" className="cv-unified-icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className="cv-unified-modal__body">
          <p className="cv-unified-row__desc">{skill.description}</p>
          <div className="cv-unified-code-preview">
            <pre>{skill.body || "Nessun contenuto nel corpo della skill."}</pre>
          </div>
          <div className="cv-unified-modal__actions">
            {skill.status === "staged" && (
              <button
                type="button"
                className="cv-unified-btn is-primary"
                onClick={async () => {
                  await onToggle(skill, true);
                  onClose();
                }}
              >
                Approva procedura
              </button>
            )}
            {skill.status === "approved" && (
              <button
                type="button"
                className="cv-unified-btn is-subtle"
                onClick={async () => {
                  await onToggle(skill, false);
                  onClose();
                }}
              >
                Archivia
              </button>
            )}
            <button type="button" className="cv-unified-btn is-subtle" onClick={onClose}>
              Chiudi
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
