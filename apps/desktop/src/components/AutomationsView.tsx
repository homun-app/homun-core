import { useEffect, useMemo, useState } from "react";
import {
  Bolt,
  Check,
  ChevronDown,
  Clock3,
  MessageSquare,
  Pencil,
  Plug,
  Plus,
  Power,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { coreBridge } from "../lib/coreBridge";
import type {
  AutomationCreateteInput,
  AutomationTriggerJson,
  CoreTaskItem,
  EventSources,
  ManagedAutomation,
} from "../lib/coreBridge";

type SelectedSource =
  | { kind: "channel"; id: string; label: string }
  | { kind: "connector"; tool: string; label: string; keyField: string };

interface AutomationsViewProps {
  automations: ManagedAutomation[];
  onCreatete: (input: AutomationCreateteInput) => void;
  onUpdate: (id: string, input: { title?: string; prompt?: string }) => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}

function formatWhen(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AutomationsView({
  automations,
  onCreatete,
  onUpdate,
  onToggle,
  onDelete,
}: AutomationsViewProps) {
  const { t } = useTranslation();
  const [composing, setComposing] = useState(false);
  // Inline edit of an existing automation (title + action). Schedule/trigger edits
  // go through the agent (update_automation) since rebuilding the picker state from a
  // recurrence string is error-prone.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editPrompt, setEditPrompt] = useState("");
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

  // Live queue of scheduled runs (proactive_prompt): includes chat-created
  // reminders ("ricordami…") that have no Automazione rule behind them and would
  // otherwise be invisible/undeletable. Listed here so there's one place to cancel any.
  const [scheduled, setScheduled] = useState<CoreTaskItem[]>([]);
  const reloadScheduled = () => {
    void coreBridge.taskQueue().then((q) => {
      setScheduled(
        [...(q.queued ?? []), ...(q.active ?? [])].filter(
          (t) => t.kind === "proactive_prompt",
        ),
      );
    });
  };
  useEffect(() => {
    reloadScheduled();
  }, []);
  const cancelScheduled = (taskId: string) => {
    void coreBridge.cancelTask(taskId).then(() => reloadScheduled());
  };

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
    onCreatete({
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
    ["mon", t("days.mon")],
    ["tue", t("days.tue")],
    ["wed", t("days.wed")],
    ["thu", t("days.thu")],
    ["fri", t("days.fri")],
    ["sat", t("days.sat")],
    ["sun", t("days.sun")],
  ];

  return (
    <section className="automations-view" aria-labelledby="automations-title">
      <header className="learning-header">
        <div>
          <p className="eyebrow">{t("automations.eyebrow")}</p>
          <h2 id="automations-title">{t("nav.automations")}</h2>
          <p className="lead-copy">{t("automations.lead")}</p>
        </div>
        <div className="learning-summary" aria-label={t("automations.summaryAria")}>
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
          <Plus size={16} aria-hidden /> {t("automations.newAutomation")}
        </button>
      )}

      {composing && (
        <div className="auto-editor">
          <input
            className="auto-title-input"
            placeholder={t("automations.titlePlaceholder")}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />

          <div className="auto-section-label">
            <Bolt size={13} aria-hidden /> {t("automations.when")}
          </div>
          <div className="auto-seg" role="tablist">
            <button
              className={triggerKind === "schedule" ? "active" : ""}
              onClick={() => setTriggerKind("schedule")}
            >
              <Clock3 size={14} aria-hidden /> {t("automations.schedule")}
            </button>
            <button
              className={triggerKind === "event" ? "active" : ""}
              onClick={() => setTriggerKind("event")}
            >
              <MessageSquare size={14} aria-hidden /> {t("automations.event")}
            </button>
          </div>

          {triggerKind === "schedule" ? (
            <div className="auto-schedule">
              <div className="auto-seg">
                <button
                  className={scheduleMode === "daily" ? "active" : ""}
                  onClick={() => setScheduleMode("daily")}
                >
                  {t("automations.everyDay")}
                </button>
                <button
                  className={scheduleMode === "days" ? "active" : ""}
                  onClick={() => setScheduleMode("days")}
                >
                  {t("automations.selectedDays")}
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
                  <span>{t("automations.every")}</span>
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
                    <option value="h">{t("automations.hours")}</option>
                    <option value="d">{t("automations.days")}</option>
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
                    {times.map((timeVal, i) => (
                      <span className="auto-time" key={i}>
                        <input
                          type="time"
                          value={timeVal}
                          onChange={(e) => setTimeAt(i, e.target.value)}
                        />
                        {times.length > 1 && (
                          <button
                            className="auto-time-x"
                            aria-label={t("automations.removeTime")}
                            onClick={() => removeTime(i)}
                          >
                            <X size={13} aria-hidden />
                          </button>
                        )}
                      </span>
                    ))}
                    <button className="auto-time-add" onClick={addTime} type="button">
                      <Plus size={13} aria-hidden /> {t("automations.addTime")}
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="auto-evt">
              <div className="auto-field">
                <label>{t("automations.source")}</label>
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
                        t("automations.pickSource")
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
                          placeholder={t("automations.searchSources")}
                          value={srcQuery}
                          onChange={(e) => setSrcQuery(e.target.value)}
                        />
                      </div>
                      <div className="auto-src-list">
                        {sourceGroups.length === 0 && (
                          <p className="auto-src-empty">{t("automations.noSources")}</p>
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
                  <label>{t("automations.fromLabel")}</label>
                  <input
                    value={eventFrom}
                    onChange={(e) => setEventFrom(e.target.value)}
                    placeholder={t("automations.fromPlaceholder")}
                  />
                </div>
              )}
              {source?.kind === "connector" && (
                <div className="auto-field">
                  <label>{t("automations.whenTriggerLabel")}</label>
                  <input
                    value={connectorArgs}
                    onChange={(e) => setConnectorArgs(e.target.value)}
                    placeholder={t("automations.whenTriggerPlaceholder")}
                  />
                  <p className="auto-hint">{t("automations.whenTriggerHint", { connectorKey })}</p>
                </div>
              )}
            </div>
          )}

          <div className="auto-section-label">
            <Sparkles size={13} aria-hidden /> {t("automations.then")}
          </div>
          <textarea
            className="auto-prompt"
            rows={3}
            placeholder={t("automations.actionPlaceholder")}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <label className="auto-approval">
            <input
              type="checkbox"
              checked={!autonomous}
              onChange={(e) => setAutonomous(!e.target.checked)}
            />
            <ShieldCheck size={14} aria-hidden /> {t("automations.askConfirmation")}
          </label>

          <div className="auto-editor-actions">
            <button className="auto-btn" onClick={reset}>
              Cancel
            </button>
            <button className="auto-btn-accent" onClick={save} disabled={!canSave}>
              {t("automations.createAutomation")}
            </button>
          </div>
        </div>
      )}

      <div className="auto-list">
        {automations.length === 0 && !composing && (
          <p className="auto-empty">{t("automations.emptyHint")}</p>
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
                  <span className="auto-source">{a.source === "chat" ? t("automations.fromChat") : t("automations.suggested")}</span>
                )}
              </div>
              {editingId === a.id ? (
                <div className="auto-card-edit" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <input
                    className="set-input"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    aria-label={t("automations.title")}
                  />
                  <textarea
                    className="set-input"
                    value={editPrompt}
                    onChange={(e) => setEditPrompt(e.target.value)}
                    rows={3}
                    aria-label={t("automations.action")}
                  />
                </div>
              ) : (
                <>
                  <p className="auto-card-title">{a.title}</p>
                  <p className="auto-card-prompt">{a.prompt}</p>
                </>
              )}
              <div className="auto-card-meta">
                {a.trigger.type === "schedule" && a.next_run && (
                  <span>
                    <Clock3 size={12} aria-hidden /> {t("automations.next")}: {formatWhen(a.next_run)}
                  </span>
                )}
                {a.last_fired_at && <span>{t("automations.last")}: {formatWhen(a.last_fired_at)}</span>}
                <span>
                  {a.approval === "confirm" ? (
                    <>
                      <ShieldCheck size={12} aria-hidden /> {t("automations.withConfirmation")}
                    </>
                  ) : (
                    t("automations.autonomous")
                  )}
                </span>
              </div>
            </div>
            <div className="auto-card-actions">
              {editingId === a.id ? (
                <>
                  <button
                    className="auto-icon"
                    title={t("common.save")}
                    aria-label={t("common.save")}
                    onClick={() => {
                      const title = editTitle.trim();
                      const prompt = editPrompt.trim();
                      const changes: { title?: string; prompt?: string } = {};
                      if (title && title !== a.title) changes.title = title;
                      if (prompt && prompt !== a.prompt) changes.prompt = prompt;
                      if (changes.title || changes.prompt) onUpdate(a.id, changes);
                      setEditingId(null);
                    }}
                  >
                    <Check size={15} aria-hidden />
                  </button>
                  <button
                    className="auto-icon"
                    title={t("common.cancel")}
                    aria-label={t("common.cancel")}
                    onClick={() => setEditingId(null)}
                  >
                    <X size={15} aria-hidden />
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="auto-icon"
                    title={t("common.edit")}
                    aria-label={t("common.edit")}
                    onClick={() => {
                      setEditingId(a.id);
                      setEditTitle(a.title);
                      setEditPrompt(a.prompt);
                    }}
                  >
                    <Pencil size={15} aria-hidden />
                  </button>
                  <button
                    className="auto-icon"
                    title={a.enabled ? t("automations.disable") : t("automations.enable")}
                    aria-label={a.enabled ? t("automations.disable") : t("automations.enable")}
                    onClick={() => onToggle(a.id)}
                  >
                    <Power size={15} aria-hidden />
                  </button>
                  <button
                    className="auto-icon danger"
                    title={t("common.delete")}
                    aria-label={t("common.delete")}
                    onClick={() => onDelete(a.id)}
                  >
                    <Trash2 size={15} aria-hidden />
                  </button>
                </>
              )}
            </div>
          </article>
        ))}
      </div>

      {scheduled.length > 0 && (
        <div className="auto-list" aria-label={t("automations.scheduledTasks")}>
          <div className="auto-section-label" style={{ marginTop: 4 }}>
            Task pianificati ({scheduled.length})
          </div>
          <p className="auto-empty" style={{ marginTop: 0 }}>{t("automations.scheduledHint")}</p>
          {scheduled.map((task) => (
            <article className="auto-card" key={task.task_id}>
              <div className="auto-card-main">
                <div className="auto-card-head">
                  <span className="auto-trigger-chip">
                    <Clock3 size={13} aria-hidden />
                    {task.status === "active" ? t("automations.inProgress") : t("automations.inQueue")}
                  </span>
                </div>
                <p className="auto-card-prompt">{task.goal}</p>
              </div>
              <div className="auto-card-actions">
                <button
                  className="auto-icon danger"
                  title="Delete"
                  aria-label={t("automations.deleteScheduled")}
                  onClick={() => cancelScheduled(task.task_id)}
                >
                  <Trash2 size={15} aria-hidden />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
