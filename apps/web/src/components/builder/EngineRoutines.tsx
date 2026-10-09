/** Engine routines: the automation space — supervised recurring works. */
import { useEffect, useState } from "react";
import type { EngineRoutine } from "@/lib/engine-routines-client";
import {
  listEngineRoutines,
  previewEngineCron,
  routineEngineAction,
  workSupportsRoutineTemplate,
} from "@/lib/engine-routines-client";
import { cadenceToCron } from "@/lib/cadence-language";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { ConversationSelectField } from "./ConversationSelect";
import { EngineGoalDashboard } from "./EngineGoalDashboard";
import { Clock, Target } from "lucide-react";
import { t } from "@/lib/i18n";
import "./engine-routines.css";

function describeCron(cron: string): string {
  const [m = "0", h = "0", , , dow] = cron.split(" ");
  if (dow === "*") return `ogni giorno alle ${h}:${m.padStart(2, "0")}`;
  if (dow === "1-5") return `nei giorni feriali alle ${h}:${m.padStart(2, "0")}`;
  const days = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
  const day = days[Number(dow)];
  return day ? `ogni ${day} alle ${h}:${m.padStart(2, "0")}` : cron;
}

export function EngineRoutines({
  routines,
  works = [],
  onCreateFromWork,
  onChanged,
  onUpdate,
  onSkipNext,
}: {
  routines: EngineRoutine[];
  /** Lavori che possono diventare il modello di una nuova routine. */
  works?: Array<{
    id: string;
    title: string;
    status?: string | undefined;
    engineStatus?: string | undefined;
    enginePlan?: Array<{ title: string; assignee_id?: string }> | undefined;
  }> | undefined;
  onCreateFromWork?: ((workId: string, input: { name: string; cron: string }) => Promise<void>) | undefined;
  onChanged?: (() => Promise<void>) | undefined;
  onUpdate?: ((routine: EngineRoutine, changes: { name: string; cron: string }) => Promise<void>) | undefined;
  onSkipNext?: ((routine: EngineRoutine) => Promise<void>) | undefined;
}) {
  const refresh = onChanged ?? (async () => {});
  const [actionError, setActionError] = useState<unknown>(null);
  const [tab, setTab] = useState<"routines" | "goals">("routines");

  async function act(routine: EngineRoutine, action: "pause" | "resume" | "stop") {
    try {
      setActionError(null);
      await routineEngineAction({ routineId: routine.id, action, expectedVersion: routine.revision });
      await refresh();
    } catch (cause) {
      setActionError(cause);
    }
  }

  return (
    <section className="cw-workspace cw-routines" aria-label={t("routines.title")}>
      <div className="ph-inline-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "routines"}
          className={`ph-inline-tab ${tab === "routines" ? "is-active" : ""}`}
          onClick={() => setTab("routines")}
        >
          <Clock size={14} />
          <span>Routine ricorrenti</span>
          <span className="ph-inline-tab-count">
            {routines.filter((r) => r.status === "active").length}
          </span>
        </button>
        <button
          role="tab"
          aria-selected={tab === "goals"}
          className={`ph-inline-tab ${tab === "goals" ? "is-active" : ""}`}
          onClick={() => setTab("goals")}
        >
          <Target size={14} />
          <span>Obiettivi multi-turno</span>
        </button>
      </div>

      {tab === "goals" ? (
        <EngineGoalDashboard />
      ) : (
        <>
          {onCreateFromWork && <EngineRoutineFreeCreator works={works} onCreate={onCreateFromWork} />}
          {routines.length === 0 && (
            <div className="homun-empty-state">
              <div className="homun-empty-state__icon">
                <Clock size={20} />
              </div>
              <h3 className="homun-empty-state__title">Nessuna routine programmata</h3>
              <p className="homun-empty-state__description">
                Le routine eseguono automaticamente i tuoi lavori su base ricorrente. Puoi trasformare qualsiasi lavoro riuscito in una routine dal suo riepilogo con l’opzione «Rendi ripetibile».
              </p>
            </div>
          )}
          <div className="cw-routines__list">
        {routines.map((routine) => (
          <article key={routine.id} className="cw-routine" data-status={routine.status}>
            <header>
              <strong>{routine.name}</strong>
              <small>{describeCron(routine.cron)} · {routine.template.title}</small>
            </header>
            <p className="cw-hint">
              {routine.status === "active" && "Attiva: ogni ricorrenza crea il lavoro e ti avvisa in chat."}
              {routine.status === "paused" && "In pausa: niente nuove ricorrenze finché non riprendi."}
              {routine.status === "stopped" && "Terminata: la chat resta, il lavoro no."}
            </p>
            <div className="cs-actions">
              {routine.status === "active" && (
                <>
                  {onSkipNext && (
                    <button type="button" className="cs-link" onClick={() => void onSkipNext(routine).catch(setActionError)}>
                      Salta la prossima
                    </button>
                  )}
                  <button type="button" className="cw-secondary" onClick={() => void act(routine, "pause")}>
                    Ferma per ora
                  </button>
                </>
              )}
              {routine.status === "paused" && (
                <button type="button" className="cw-secondary" onClick={() => void act(routine, "resume")}>
                  Riprendi
                </button>
              )}
              {routine.status !== "stopped" && (
                <button type="button" className="cs-link" onClick={() => void act(routine, "stop")}>
                  Termina routine
                </button>
              )}
              {onUpdate && routine.status !== "stopped" && (
                <RoutineInlineEditor routine={routine} onSave={(changes) => onUpdate(routine, changes)} />
              )}
            </div>
          </article>
        ))}
      </div>
    </>
  )}
  <HomunErrorNotice error={actionError} />
</section>
  );
}

/** Creazione libera dalla vista Automazioni: il modello è un lavoro esistente. */
function EngineRoutineFreeCreator({
  works,
  onCreate,
}: {
  works: Array<{
    id: string; title: string; status?: string | undefined; engineStatus?: string | undefined;
    engineObjective?: string | undefined;
    enginePlan?: Array<{ title: string; assignee_id?: string; capability?: string; output_expected?: string }> | undefined;
  }>;
  onCreate: (workId: string, input: { name: string; cron: string }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  // Only works whose plan matches routine.create: titled steps on roster agents.
  const candidates = works.filter((w) =>
    (w.engineStatus === "completed" || w.engineStatus === "ready") &&
    workSupportsRoutineTemplate(w));
  const [workId, setWorkId] = useState(candidates[0]?.id ?? "");
  const selected = candidates.find((w) => w.id === workId) ?? candidates[0];
  const [name, setName] = useState("");
  const [phrase, setPhrase] = useState("ogni lunedì alle 9");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const cron = cadenceToCron(phrase);
  const effectiveName = name.trim() || selected?.title || "";

  if (!open)
    return (
      <section className="cw-routine-creator cw-routine-creator--free" aria-label="Nuova routine">
        <button type="button" className="cw-primary" onClick={() => setOpen(true)}>
          Nuova routine
        </button>
        <p className="cw-hint">
          Scegli un lavoro riuscito come modello e la cadenza: ogni ricorrenza crea un lavoro nuovo che aspetta il tuo via.
        </p>
      </section>
    );

  return (
    <form className="cw-routine-creator" aria-label="Nuova routine"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!cron || !selected || saving) return;
        setSaving(true);
        setError(null);
        try {
          await onCreate(selected.id, { name: effectiveName, cron });
          setOpen(false);
          setName("");
        } catch (cause) {
          setError(cause);
        } finally {
          setSaving(false);
        }
      }}>
      <h4>Nuova routine</h4>
      <label>
        Lavoro modello
        <select value={selected?.id ?? ""} disabled={saving || candidates.length === 0}
          onChange={(e) => setWorkId(e.target.value)}>
          {candidates.map((w) => (
            <option key={w.id} value={w.id}>{w.title}</option>
          ))}
        </select>
      </label>
      {candidates.length === 0 && (
        <p className="cw-hint" role="alert">
          Servono lavori completati da usare come modello: chiudi un lavoro e torna qui.
        </p>
      )}
      <label>
        Nome della routine
        <input value={name} maxLength={80} disabled={saving}
          placeholder={selected?.title ?? "Nome"} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Quando
        <input value={phrase} maxLength={120} disabled={saving}
          onChange={(e) => setPhrase(e.target.value)}
          placeholder="Es. ogni lunedì alle 9 · il primo del mese alle 8:30" />
      </label>
      {cron ? (
        <p className="cw-hint" role="status">Cron <code>{cron}</code></p>
      ) : (
        <p className="cw-hint" role="alert">
          Non ho capito la cadenza: prova «ogni lunedì alle 9», «ogni giorno alle 8:30», «il primo del mese alle 9» oppure scrivi un cron a 5 campi.
        </p>
      )}
      <div className="cs-actions">
        <button className="cw-primary" disabled={saving || !cron || !selected}>
          {saving ? "Creo la routine…" : "Crea la routine"}
        </button>
        <button type="button" className="cs-link" disabled={saving} onClick={() => setOpen(false)}>
          Annulla
        </button>
      </div>
      <HomunErrorNotice error={error} />
    </form>
  );
}

/** The «Rendi ripetibile» card on a completed work panel. */
export function EngineRoutineCreator({
  defaultName,
  onCreateRoutine,
}: {
  defaultName: string;
  onCreateRoutine: (input: { name: string; cron: string }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultName);
  const [phrase, setPhrase] = useState("ogni lunedì alle 9");
  const [preview, setPreview] = useState<string[] | null>(null);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const cron = cadenceToCron(phrase);

  useEffect(() => {
    if (!open || !cron) { setPreview(null); return; }
    let active = true;
    previewEngineCron(cron)
      .then((next) => { if (active) { setPreview(next); setPreviewError(null); } })
      .catch((cause) => { if (active) { setPreview(null); setPreviewError(cause); } });
    return () => { active = false; };
  }, [open, cron]);

  if (!open)
    return (
      <section className="cw-engine-summary__routine-create" aria-label="Rendi ripetibile">
        <button type="button" className="cw-secondary" onClick={() => setOpen(true)}>
          Rendi ripetibile
        </button>
        <p className="cw-engine-summary__hint">
          Ogni ricorrenza crea un lavoro nuovo che aspetta il tuo via: l'approvazione non si automatizza.
        </p>
      </section>
    );

  return (
    <form className="cw-routine-creator" aria-label="Nuova routine"
      onSubmit={(event) => {
        event.preventDefault();
        if (!cron || saving) return;
        setSaving(true);
        setError(null);
        onCreateRoutine({ name: name.trim(), cron })
          .then(() => setOpen(false))
          .catch(setError)
          .finally(() => setSaving(false));
      }}>
      <h4>Rendi ripetibile</h4>
      <label>
        Nome della routine
        <input value={name} maxLength={80} disabled={saving} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Quando
        <input value={phrase} maxLength={120} disabled={saving}
          onChange={(e) => setPhrase(e.target.value)}
          placeholder="Es. ogni lunedì alle 9 · il primo del mese alle 8:30" />
      </label>
      {cron ? (
        <p className="cw-hint" role="status">
          Cron <code>{cron}</code>
          {preview && preview.length > 0 && (
            <> · prossime: {preview.map((iso) => new Date(iso).toLocaleString("it-IT", { dateStyle: "medium", timeStyle: "short" })).join(" · ")}</>
          )}
        </p>
      ) : (
        <p className="cw-hint" role="alert">
          Non ho capito la cadenza: prova «ogni lunedì alle 9», «ogni giorno alle 8:30», «il primo del mese alle 9» oppure scrivi un cron a 5 campi.
        </p>
      )}
      <div className="cs-actions">
        <button className="cw-primary" disabled={saving || !cron || !name.trim()}>
          {saving ? "Creo la routine…" : "Crea la routine"}
        </button>
        <button type="button" className="cs-link" disabled={saving} onClick={() => setOpen(false)}>
          Annulla
        </button>
      </div>
      {saving && <p role="status">Salvataggio in corso…</p>}
      <HomunErrorNotice error={error ?? previewError} />
    </form>
  );
}


/** Inline edit of name and cadence; the model revision is versioned. */
function RoutineInlineEditor({
  routine,
  onSave,
}: {
  routine: EngineRoutine;
  onSave: (changes: { name: string; cron: string }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(routine.name);
  const [phrase, setPhrase] = useState(describeCron(routine.cron));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const cron = cadenceToCron(phrase) ?? (/^[\d*,/-]+( [\d*,/-]+){4}$/.test(phrase) ? phrase : null);
  if (!open)
    return (
      <button type="button" className="cs-link" onClick={() => setOpen(true)}>
        Modifica
      </button>
    );
  return (
    <form className="cw-routine-edit" aria-label={`Modifica ${routine.name}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!cron || saving) return;
        setSaving(true);
        setError(null);
        onSave({ name: name.trim(), cron })
          .then(() => setOpen(false))
          .catch(setError)
          .finally(() => setSaving(false));
      }}>
      <label>
        Nome
        <input value={name} maxLength={80} disabled={saving} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Quando
        <input value={phrase} maxLength={120} disabled={saving} onChange={(e) => setPhrase(e.target.value)} />
      </label>
      {!cron && (
        <p className="cw-hint" role="alert">
          Cadence non riconosciuta: «ogni martedì alle 8» oppure un cron a 5 campi.
        </p>
      )}
      <div className="cs-actions">
        <button className="cw-secondary" disabled={saving || !cron || !name.trim()}>
          {saving ? "Salvo…" : "Salva revisione"}
        </button>
        <button type="button" className="cs-link" disabled={saving} onClick={() => setOpen(false)}>
          Annulla
        </button>
      </div>
      <HomunErrorNotice error={error} />
    </form>
  );
}