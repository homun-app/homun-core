import { useEffect, useMemo, useState } from "react";
import {
  Bolt,
  ChevronDown,
  Clock3,
  MessageSquare,
  Plug,
  Plus,
  Power,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { coreBridge } from "../lib/coreBridge";
import type {
  AutomationCreateInput,
  AutomationTriggerJson,
  EventSources,
  ManagedAutomation,
} from "../lib/coreBridge";

type SelectedSource =
  | { kind: "channel"; id: string; label: string }
  | { kind: "connector"; tool: string; label: string; keyField: string };

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
  // Schedule builder: a mode + (days × times) or an interval.
  const [scheduleMode, setScheduleMode] = useState<"daily" | "days" | "interval">("daily");
  const [days, setDays] = useState<string[]>(["mon", "tue", "wed", "thu", "fri"]);
  const [times, setTimes] = useState<string[]>(["09:00"]);
  const [intervalN, setIntervalN] = useState(6);
  const [intervalUnit, setIntervalUnit] = useState<"h" | "d">("h");
  const [eventFrom, setEventFrom] = useState("");
  const [autonomous, setAutonomous] = useState(false);
  // Event source picker (searchable + grouped, like the model selector).
  const [eventSources, setEventSources] = useState<EventSources>({ channels: [], connectors: [] });
  const [srcOpen, setSrcOpen] = useState(false);
  const [srcQuery, setSrcQuery] = useState("");
  const [source, setSource] = useState<SelectedSource | null>(null);
  const [connectorArgs, setConnectorArgs] = useState("");
  const [connectorKey, setConnectorKey] = useState("id");

  // Load the event sources when the editor opens (channels + connected Composio/MCP tools).
  useEffect(() => {
    if (composing && eventSources.channels.length === 0 && eventSources.connectors.length === 0) {
      void coreBridge.automationEventSources().then(setEventSources);
    }
  }, [composing, eventSources.channels.length, eventSources.connectors.length]);

  const active = automations.filter((a) => a.enabled).length;

  const toggleDay = (d: string) =>
    setDays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d],
    );
  const setTimeAt = (i: number, v: string) =>
    setTimes((prev) => prev.map((t, idx) => (idx === i ? v : t)));
  const addTime = () => setTimes((prev) => [...prev, "12:00"]);
  const removeTime = (i: number) =>
    setTimes((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));

  // Compose the recurrence string the runtime understands from the builder state.
  const composeRecurrence = (): string => {
    if (scheduleMode === "interval") {
      return `every ${Math.max(1, intervalN)}${intervalUnit}`;
    }
    const order = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    const t = times.join(",");
    if (scheduleMode === "daily") return `dow@*@${t}`;
    const sorted = order.filter((d) => days.includes(d)).join(",");
    return `dow@${sorted}@${t}`;
  };

  const scheduleValid =
    scheduleMode === "interval"
      ? intervalN >= 1
      : times.length > 0 && (scheduleMode === "daily" || days.length > 0);
  const eventValid =
    source !== null && (source.kind !== "connector" || connectorKey.trim().length > 0);
  // Title is optional — derived from the prompt when empty. What matters is the action.
  const canSave =
    prompt.trim().length > 0 &&
    (triggerKind === "schedule" ? scheduleValid : eventValid);

  const reset = () => {
    setTitle("");
    setPrompt("");
    setTriggerKind("schedule");
    setScheduleMode("daily");
    setDays(["mon", "tue", "wed", "thu", "fri"]);
    setTimes(["09:00"]);
    setIntervalN(6);
    setIntervalUnit("h");
    setEventFrom("");
    setSource(null);
    setConnectorArgs("");
    setConnectorKey("id");
    setSrcOpen(false);
    setSrcQuery("");
    setAutonomous(false);
    setComposing(false);
  };

  // Parse the connector filter: a "key: value" or "key=value" → {key:value}; bare text →
  // {query: text}; valid JSON → as-is; empty → {}.
  const parseConnectorArgs = (raw: string): unknown => {
    const t = raw.trim();
    if (!t) return {};
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* not JSON */
    }
    const m = t.match(/^([\w.]+)\s*[:=]\s*(.+)$/);
    if (m) return { [m[1]]: m[2].trim() };
    return { query: t };
  };

  const save = () => {
    if (!canSave) return;
    let trigger: AutomationTriggerJson;
    if (triggerKind === "schedule") {
      trigger = { type: "schedule", recurrence: composeRecurrence() };
    } else if (source?.kind === "connector") {
      trigger = {
        type: "event",
        event: {
          kind: "connector_poll",
          tool: source.tool,
          args: parseConnectorArgs(connectorArgs),
          key_field: connectorKey.trim() || "id",
          label: source.label,
        },
      };
    } else {
      trigger = {
        type: "event",
        event: {
          kind: "channel_message",
          channel: source?.kind === "channel" ? source.id || null : null,
          from: eventFrom.trim() || null,
        },
      };
    }
    const finalTitle = title.trim() || prompt.trim().slice(0, 48);
    onCreate({
      title: finalTitle,
      trigger,
      prompt: prompt.trim(),
      approval: autonomous ? "autonomous" : "confirm",
      source: "manual",
    });
    reset();
  };

  // Event sources, filtered by query + grouped (Canali / Composio / MCP) — like the model menu.
  const sourceGroups = useMemo(() => {
    const q = srcQuery.trim().toLowerCase();
    const groups: Array<{
      group: string;
      items: Array<{ key: string; label: string; sel: SelectedSource }>;
    }> = [];
    const channels = eventSources.channels
      .filter((c) => !q || c.label.toLowerCase().includes(q))
      .map((c) => ({
        key: `ch:${c.id}`,
        label: c.label,
        sel: { kind: "channel" as const, id: c.id, label: c.label },
      }));
    if (channels.length) groups.push({ group: "Canali", items: channels });
    const byGroup = new Map<
      string,
      Array<{ key: string; label: string; sel: SelectedSource }>
    >();
    for (const c of eventSources.connectors) {
      if (q && ![c.label, c.tool, c.group].some((s) => s.toLowerCase().includes(q))) {
        continue;
      }
      const arr = byGroup.get(c.group) ?? [];
      arr.push({
        key: `co:${c.tool}`,
        label: c.label,
        sel: { kind: "connector", tool: c.tool, label: c.label, keyField: c.key_field },
      });
      byGroup.set(c.group, arr);
    }
    for (const [g, items] of byGroup) groups.push({ group: g, items });
    return groups;
  }, [eventSources, srcQuery]);

  const pickSource = (sel: SelectedSource) => {
    setSource(sel);
    if (sel.kind === "connector") setConnectorKey(sel.keyField || "id");
    setSrcOpen(false);
    setSrcQuery("");
  };

  const DAYS: Array<[string, string]> = [
    ["mon", "Lun"],
    ["tue", "Mar"],
    ["wed", "Mer"],
    ["thu", "Gio"],
    ["fri", "Ven"],
    ["sat", "Sab"],
    ["sun", "Dom"],
  ];

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
            placeholder="Titolo (opzionale)"
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
            <div className="auto-schedule">
              <div className="auto-seg">
                <button
                  className={scheduleMode === "daily" ? "active" : ""}
                  onClick={() => setScheduleMode("daily")}
                >
                  Ogni giorno
                </button>
                <button
                  className={scheduleMode === "days" ? "active" : ""}
                  onClick={() => setScheduleMode("days")}
                >
                  Giorni scelti
                </button>
                <button
                  className={scheduleMode === "interval" ? "active" : ""}
                  onClick={() => setScheduleMode("interval")}
                >
                  Intervallo
                </button>
              </div>

              {scheduleMode === "interval" ? (
                <div className="auto-interval">
                  <span>Ogni</span>
                  <input
                    type="number"
                    min={1}
                    value={intervalN}
                    onChange={(e) => setIntervalN(Math.max(1, Number(e.target.value) || 1))}
                  />
                  <select
                    value={intervalUnit}
                    onChange={(e) => setIntervalUnit(e.target.value as "h" | "d")}
                  >
                    <option value="h">ore</option>
                    <option value="d">giorni</option>
                  </select>
                </div>
              ) : (
                <>
                  {scheduleMode === "days" && (
                    <div className="auto-days">
                      {DAYS.map(([id, label]) => (
                        <button
                          key={id}
                          className={`auto-day${days.includes(id) ? " on" : ""}`}
                          onClick={() => toggleDay(id)}
                          type="button"
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="auto-times">
                    {times.map((t, i) => (
                      <span className="auto-time" key={i}>
                        <input
                          type="time"
                          value={t}
                          onChange={(e) => setTimeAt(i, e.target.value)}
                        />
                        {times.length > 1 && (
                          <button
                            className="auto-time-x"
                            aria-label="Rimuovi orario"
                            onClick={() => removeTime(i)}
                          >
                            <X size={13} aria-hidden />
                          </button>
                        )}
                      </span>
                    ))}
                    <button className="auto-time-add" onClick={addTime} type="button">
                      <Plus size={13} aria-hidden /> orario
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="auto-evt">
              <div className="auto-field">
                <label>Sorgente</label>
                <div className="auto-src">
                  <button
                    type="button"
                    className="auto-src-btn"
                    onClick={() => setSrcOpen((o) => !o)}
                  >
                    <span>
                      {source ? (
                        <>
                          {source.kind === "channel" ? (
                            <MessageSquare size={14} aria-hidden />
                          ) : (
                            <Plug size={14} aria-hidden />
                          )}{" "}
                          {source.label}
                        </>
                      ) : (
                        "Scegli una sorgente…"
                      )}
                    </span>
                    <ChevronDown size={14} aria-hidden />
                  </button>
                  {srcOpen && (
                    <div className="auto-src-pop" role="menu">
                      <div className="auto-src-search">
                        <Search size={14} aria-hidden />
                        <input
                          autoFocus
                          placeholder="Cerca canali, Composio, MCP…"
                          value={srcQuery}
                          onChange={(e) => setSrcQuery(e.target.value)}
                        />
                      </div>
                      <div className="auto-src-list">
                        {sourceGroups.length === 0 && (
                          <p className="auto-src-empty">Nessuna sorgente</p>
                        )}
                        {sourceGroups.map((g) => (
                          <div key={g.group} className="auto-src-group">
                            <div className="auto-src-group-label">{g.group}</div>
                            {g.items.map((it) => (
                              <button
                                key={it.key}
                                type="button"
                                className="auto-src-item"
                                onClick={() => pickSource(it.sel)}
                              >
                                {it.sel.kind === "channel" ? (
                                  <MessageSquare size={14} aria-hidden />
                                ) : (
                                  <Plug size={14} aria-hidden />
                                )}
                                <span>{it.label}</span>
                              </button>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {source?.kind === "channel" && (
                <div className="auto-field">
                  <label>Da (nome o numero, opzionale)</label>
                  <input
                    value={eventFrom}
                    onChange={(e) => setEventFrom(e.target.value)}
                    placeholder="es. Mario Rossi"
                  />
                </div>
              )}
              {source?.kind === "connector" && (
                <div className="auto-field">
                  <label>Quando deve scattare? (descrivi, opzionale)</label>
                  <input
                    value={connectorArgs}
                    onChange={(e) => setConnectorArgs(e.target.value)}
                    placeholder="es. nuove email da Mario non lette"
                  />
                  <p className="auto-hint">
                    Descrivilo a parole: ci penso io a tradurlo. Il campo tecnico per evitare
                    doppioni è impostato in automatico ({connectorKey}). Per setup precisi,
                    chiedimelo in chat.
                  </p>
                </div>
              )}
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
