import { useState } from "react";
import {
  Bolt,
  Clock3,
  MessageSquare,
  Plus,
  Power,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import type {
  AutomationCreateInput,
  AutomationTriggerJson,
  ManagedAutomation,
} from "../lib/coreBridge";

interface AutomationsViewProps {
  automations: ManagedAutomation[];
  onCreate: (input: AutomationCreateInput) => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}

function formatWhen(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString("it-IT", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AutomationsView({
  automations,
  onCreate,
  onToggle,
  onDelete,
}: AutomationsViewProps) {
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [triggerKind, setTriggerKind] = useState<"schedule" | "event">("schedule");
  const [recurrence, setRecurrence] = useState("daily@09:00");
  const [eventChannel, setEventChannel] = useState("");
  const [eventFrom, setEventFrom] = useState("");
  const [autonomous, setAutonomous] = useState(false);

  const active = automations.filter((a) => a.enabled).length;
  const canSave = title.trim().length > 0 && prompt.trim().length > 0;

  const reset = () => {
    setTitle("");
    setPrompt("");
    setTriggerKind("schedule");
    setRecurrence("daily@09:00");
    setEventChannel("");
    setEventFrom("");
    setAutonomous(false);
    setComposing(false);
  };

  const save = () => {
    if (!canSave) return;
    const trigger: AutomationTriggerJson =
      triggerKind === "schedule"
        ? { type: "schedule", recurrence: recurrence.trim() }
        : {
            type: "event",
            event: {
              kind: "channel_message",
              channel: eventChannel.trim() || null,
              from: eventFrom.trim() || null,
            },
          };
    onCreate({
      title: title.trim(),
      trigger,
      prompt: prompt.trim(),
      approval: autonomous ? "autonomous" : "confirm",
      source: "manual",
    });
    reset();
  };

  return (
    <section className="automations-view" aria-labelledby="automations-title">
      <header className="learning-header">
        <div>
          <p className="eyebrow">Trigger → azione</p>
          <h2 id="automations-title">Automazioni</h2>
          <p className="lead-copy">
            Una regola: quando succede qualcosa — a un orario o a un evento — Homun
            esegue un'azione con tutti i suoi strumenti (skill, connettori, browser, memoria).
          </p>
        </div>
        <div className="learning-summary" aria-label="Sintesi automazioni">
          <span>
            <strong>{automations.length}</strong>
            totali
          </span>
          <span>
            <strong>{active}</strong>
            attive
          </span>
        </div>
      </header>

      {!composing && (
        <button className="auto-new-btn" onClick={() => setComposing(true)}>
          <Plus size={16} aria-hidden /> Nuova automazione
        </button>
      )}

      {composing && (
        <div className="auto-editor">
          <input
            className="auto-title-input"
            placeholder="Titolo (es. Riassunto del venerdì)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />

          <div className="auto-section-label">
            <Bolt size={13} aria-hidden /> Quando
          </div>
          <div className="auto-seg" role="tablist">
            <button
              className={triggerKind === "schedule" ? "active" : ""}
              onClick={() => setTriggerKind("schedule")}
            >
              <Clock3 size={14} aria-hidden /> A orario
            </button>
            <button
              className={triggerKind === "event" ? "active" : ""}
              onClick={() => setTriggerKind("event")}
            >
              <MessageSquare size={14} aria-hidden /> A un evento
            </button>
          </div>

          {triggerKind === "schedule" ? (
            <div className="auto-field">
              <label>Ricorrenza</label>
              <input
                value={recurrence}
                onChange={(e) => setRecurrence(e.target.value)}
                placeholder="daily@09:00"
              />
              <small className="auto-hint">
                daily@HH:MM · weekly@&lt;lun..dom&gt;@HH:MM · every Nh / every Nd
              </small>
            </div>
          ) : (
            <div className="auto-row">
              <div className="auto-field">
                <label>Canale</label>
                <select value={eventChannel} onChange={(e) => setEventChannel(e.target.value)}>
                  <option value="">Qualsiasi</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="telegram">Telegram</option>
                </select>
              </div>
              <div className="auto-field">
                <label>Da (nome o numero, opzionale)</label>
                <input
                  value={eventFrom}
                  onChange={(e) => setEventFrom(e.target.value)}
                  placeholder="es. Mario Rossi"
                />
              </div>
            </div>
          )}

          <div className="auto-section-label">
            <Sparkles size={13} aria-hidden /> Allora
          </div>
          <textarea
            className="auto-prompt"
            rows={3}
            placeholder="Cosa deve fare Homun quando scatta… (sceglie skill, connettori, browser e memoria automaticamente)"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <label className="auto-approval">
            <input
              type="checkbox"
              checked={!autonomous}
              onChange={(e) => setAutonomous(!e.target.checked)}
            />
            <ShieldCheck size={14} aria-hidden /> Chiedi conferma prima di inviare o pubblicare
          </label>

          <div className="auto-editor-actions">
            <button className="auto-btn" onClick={reset}>
              Annulla
            </button>
            <button className="auto-btn-accent" onClick={save} disabled={!canSave}>
              Crea automazione
            </button>
          </div>
        </div>
      )}

      <div className="auto-list">
        {automations.length === 0 && !composing && (
          <p className="auto-empty">
            Nessuna automazione. Creane una qui sopra, o chiedimelo in chat — es. «ogni
            venerdì alle 18 mandami il riassunto della settimana».
          </p>
        )}
        {automations.map((a) => (
          <article className={`auto-card${a.enabled ? "" : " disabled"}`} key={a.id}>
            <div className="auto-card-main">
              <div className="auto-card-head">
                <span className="auto-trigger-chip">
                  {a.trigger.type === "schedule" ? (
                    <Clock3 size={13} aria-hidden />
                  ) : (
                    <MessageSquare size={13} aria-hidden />
                  )}
                  {a.trigger_summary}
                </span>
                {a.source !== "manual" && (
                  <span className="auto-source">{a.source === "chat" ? "da chat" : "suggerita"}</span>
                )}
              </div>
              <p className="auto-card-title">{a.title}</p>
              <p className="auto-card-prompt">{a.prompt}</p>
              <div className="auto-card-meta">
                {a.trigger.type === "schedule" && a.next_run && (
                  <span>
                    <Clock3 size={12} aria-hidden /> prossima: {formatWhen(a.next_run)}
                  </span>
                )}
                {a.last_fired_at && <span>ultima: {formatWhen(a.last_fired_at)}</span>}
                <span>
                  {a.approval === "confirm" ? (
                    <>
                      <ShieldCheck size={12} aria-hidden /> con conferma
                    </>
                  ) : (
                    "autonoma"
                  )}
                </span>
              </div>
            </div>
            <div className="auto-card-actions">
              <button
                className="auto-icon"
                title={a.enabled ? "Disattiva" : "Attiva"}
                aria-label={a.enabled ? "Disattiva" : "Attiva"}
                onClick={() => onToggle(a.id)}
              >
                <Power size={15} aria-hidden />
              </button>
              <button
                className="auto-icon danger"
                title="Elimina"
                aria-label="Elimina"
                onClick={() => onDelete(a.id)}
              >
                <Trash2 size={15} aria-hidden />
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
