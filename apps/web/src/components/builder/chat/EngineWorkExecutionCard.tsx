/**
 * Lo stato dell'esecuzione di un lavoro confermato, DENTRO la chat, sotto
 * l'accordo: pronto / in attesa del via libera / in corso / risultato da
 * rivedere / approvato / non riuscito. Ogni stato viene dal motore
 * (`useWorkExecution`): niente stati inventati, gli errori restano qui.
 */
import { useState } from "react";
import { Streamdown } from "streamdown";

import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import type { WorkExecutionState } from "@/hooks/useWorkExecution";

import "./EngineWorkExecutionCard.css";

const PREVIEW_CHARACTERS = 1200;

function ResultReview({ state, actionable }: { state: WorkExecutionState; actionable: boolean }) {
  const artifact = state.execution?.artifact;
  const [expanded, setExpanded] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [comment, setComment] = useState("");
  if (!artifact) return null;
  const long = artifact.content.length > PREVIEW_CHARACTERS;
  const shown =
    expanded || !long ? artifact.content : `${artifact.content.slice(0, PREVIEW_CHARACTERS)}…`;
  return (
    <>
      <div className="cw-work-execution__result" data-testid="work-execution-result">
        <Streamdown>{shown}</Streamdown>
      </div>
      {long && (
        <button
          type="button"
          className="cw-work-execution__link"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Mostra meno" : "Mostra tutto"}
        </button>
      )}
      {!actionable ? null : correcting ? (
        <form
          className="cw-work-execution__correction"
          onSubmit={(event) => {
            event.preventDefault();
            if (!comment.trim()) return;
            void state.review("request_changes", comment.trim());
            setCorrecting(false);
            setComment("");
          }}
        >
          <textarea
            aria-label="Cosa correggere"
            placeholder="Cosa va corretto?"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            rows={3}
          />
          <div className="cw-work-execution__actions">
            <button type="submit" className="cw-work-execution__primary" disabled={state.busy}>
              Invia la correzione
            </button>
            <button type="button" onClick={() => setCorrecting(false)}>
              Annulla
            </button>
          </div>
        </form>
      ) : (
        <div className="cw-work-execution__actions">
          <button
            type="button"
            className="cw-work-execution__primary"
            disabled={state.busy}
            onClick={() => void state.review("approve")}
          >
            Approva
          </button>
          <button type="button" disabled={state.busy} onClick={() => setCorrecting(true)}>
            Chiedi correzione
          </button>
        </div>
      )}
    </>
  );
}

export function EngineWorkExecutionCard({ state }: { state: WorkExecutionState }) {
  const execution = state.execution;
  if (!execution || execution.agreement_status !== "confirmed") return null;
  const status = execution.status;
  const done = execution.work_status === "completed";
  const inReview = status === "completed" && execution.work_status === "review";
  const failed = status === "failed" || status === "blocked";
  let badge = "Pronto per partire";
  if (status === "pending_approval") badge = "In attesa del tuo via libera";
  else if (status === "queued") badge = "In coda";
  else if (status === "running") badge = "In corso";
  else if (status === "waiting_input") badge = "In attesa di una tua risposta";
  else if (inReview) badge = `Risultato da rivedere · v${execution.artifact?.version ?? 1}`;
  else if (done) badge = "Approvato · in Documenti";
  else if (failed) badge = "Non riuscito";
  else if (status === "completed") badge = "Completato";

  return (
    <section
      className="cw-work-execution"
      data-testid="work-execution-card"
      data-status={status}
      aria-live="polite"
    >
      <p className="cw-work-execution__badge">{badge}</p>
      {(status === "queued" || status === "running") && (
        <p className="cw-work-execution__note">Homun sta lavorando: il risultato comparirà qui.</p>
      )}
      {status === "not_started" && (
        <div className="cw-work-execution__actions">
          <button
            type="button"
            className="cw-work-execution__primary"
            disabled={state.busy}
            onClick={() => void state.start()}
          >
            Avvia il lavoro
          </button>
        </div>
      )}
      {status === "pending_approval" && (
        <div className="cw-work-execution__actions">
          <button
            type="button"
            className="cw-work-execution__primary"
            disabled={state.busy}
            onClick={() => void state.approve()}
          >
            Avvia
          </button>
        </div>
      )}
      {failed && (
        <>
          <p className="cw-work-execution__note">
            L'esecuzione si è fermata
            {execution.error_code ? ` (${execution.error_code})` : ""}. Puoi riprovare.
          </p>
          <div className="cw-work-execution__actions">
            <button
              type="button"
              className="cw-work-execution__primary"
              disabled={state.busy}
              onClick={() => void state.start()}
            >
              Riprova
            </button>
          </div>
        </>
      )}
      {(inReview || done) && <ResultReview state={state} actionable={inReview} />}
      <HomunErrorNotice error={state.error} />
    </section>
  );
}
