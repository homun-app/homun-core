/** Engine routines: the automation space — supervised recurring works. */
import { useEffect, useState } from "react";
import type { EngineRoutine } from "@/lib/engine-routines-client";
import { listEngineRoutines, previewEngineCron, routineEngineAction } from "@/lib/engine-routines-client";
import { cadenceToCron } from "@/lib/cadence-language";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { ConversationSelectField } from "./ConversationSelect";
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
  onChanged,
  onUpdate,
  onSkipNext,
}: {
  routines: EngineRoutine[];
  onChanged?: (() => Promise<void>) | undefined;
  onUpdate?: ((routine: EngineRoutine, changes: { name: string; cron: string }) => Promise<void>) | undefined;
  onSkipNext?: ((routine: EngineRoutine) => Promise<void>) | undefined;
}) {
  const refresh = onChanged ?? (async () => {});
  const [actionError, setActionError] = useState<unknown>(null);

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
    <section className="cw-workspace cw-routines" aria-label="Automazioni">
      <div className="cw-panel-top">
        <h2>Automazioni</h2>
        <span className="cw-hint">
          {routines.filter((r) => r.status === "active").length} attive
        </span>
      </div>
      <p className="cw-hint">
        Ogni routine ripete l'affidamento, mai l'approvazione: a ogni ricorrenza nasce un
        lavoro vero che aspetta il tuo via, con revisione finale.
      </p>
      {routines.length === 0 && (
        <p className="cw-routines__empty">
          Nessuna routine. Apri un lavoro riuscito e scegli «Rendi ripetibile» dal suo riepilogo.
        </p>
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
      <HomunErrorNotice error={actionError} />
    </section>
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