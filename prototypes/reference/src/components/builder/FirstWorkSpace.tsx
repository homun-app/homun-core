import { ArrowRight, Bot, Check, Clock3, FileText, Pencil, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  exampleFor,
  missingMaterials,
  sampleResult,
  type AssistedDraft,
} from "@/lib/assisted-work";
import { JourneyField } from "./FirstWorkFields";
import type { UpdateProposal } from "./WorkProposal";

export type TrialStage = "waiting" | "review" | "done";

export function FirstWorkSpace({
  draft,
  trial,
  update,
  onSamples,
  onTrial,
  onReview,
  onEdit,
  onRestart,
}: {
  draft: AssistedDraft;
  trial: TrialStage;
  update: UpdateProposal;
  onSamples: () => void;
  onTrial: () => void;
  onReview: () => void;
  onEdit: () => void;
  onRestart: () => void;
}) {
  const example = exampleFor(draft);
  const missing = missingMaterials(draft);
  const sample = sampleResult(draft);
  const review = sample && (trial === "review" || trial === "done");
  return (
    <div>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs text-accent">La tua squadra</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            {trial === "done" && sample
              ? "La prima prova è rivista."
              : "Il lavoro ha un responsabile."}
          </h1>
        </div>
        <button
          onClick={onEdit}
          className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <Pencil className="size-3" />
          Rivedi il metodo
        </button>
      </div>
      <div className="grid items-start gap-7 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="min-w-0 rounded-2xl bg-card/70 p-5">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-secondary p-3 text-accent">
              <Bot className="size-5" />
            </div>
            <div>
              <h2 className="break-words font-semibold">{draft.name}</h2>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {trial === "done"
                  ? "Prova rivista"
                  : review
                    ? "Aspetta la tua revisione"
                    : missing.length
                      ? "Aspetta i materiali"
                      : "Materiali raccolti"}
              </p>
            </div>
          </div>
          <p className="mt-4 break-words text-xs leading-relaxed text-muted-foreground">
            {draft.responsibility}
          </p>
          <div className="mt-5 border-t border-border pt-4">
            <p className="flex items-center gap-2 text-xs font-medium">
              <Clock3 className="size-3" />
              {draft.frequency}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Routine prevista · non attiva. Prima verifichiamo il metodo.
            </p>
          </div>
          <div className="mt-5 border-t border-border pt-4">
            <p className="text-xs font-medium">Costo della prova</p>
            <p className="mt-2 text-xs text-muted-foreground">Nessun consumo reale</p>
            <p className="mt-2 text-xs text-muted-foreground">
              {draft.aiPolicy === "local"
                ? "Modelli locali previsti"
                : `Limite remoto: ${draft.budget} €`}
            </p>
          </div>
        </aside>
        <div className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center gap-3 text-xs">
            <span className="font-semibold">Il primo lavoro</span>
            <span className="rounded-full bg-secondary px-3 py-1 text-accent">
              {review
                ? trial === "done"
                  ? "Rivisto · demo"
                  : "Da rivedere · demo"
                : missing.length
                  ? "In attesa di materiali"
                  : "Materiali pronti"}
            </span>
          </div>
          <h2 className="break-words text-xl font-semibold">{draft.title}</h2>
          {review ? (
            <div className="mt-5 space-y-5">
              <div className="rounded-2xl border border-accent/20 bg-card/60 p-5 sm:p-6">
                <p className="text-[11px] font-medium uppercase tracking-wider text-accent">
                  Esito illustrativo · {example?.label}
                </p>
                <h3 className="mt-3 text-xl font-semibold">{sample.resultTitle}</h3>
                <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed">{sample.result}</p>
              </div>
              <div>
                <h3 className="text-xs font-semibold">Cosa controllare in questo esempio</h3>
                <ul className="mt-3 space-y-2">
                  {sample.checks.map((check) => (
                    <li
                      key={check}
                      className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"
                    >
                      <Check className="mt-0.5 size-3 shrink-0 text-accent" />
                      {check}
                    </li>
                  ))}
                </ul>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Risultato precompilato dei materiali di esempio. Nessun modello, verifica esterna o
                invio è stato eseguito.
              </p>
              {trial === "review" ? (
                <div className="flex flex-wrap gap-3">
                  <Button onClick={onReview} className="h-auto min-h-10 whitespace-normal py-3">
                    <Check />
                    Segna la prova come rivista
                  </Button>
                  <Button variant="ghost" onClick={onRestart}>
                    Modifica i materiali
                  </Button>
                </div>
              ) : (
                <div className="rounded-xl bg-secondary/40 p-5">
                  <h3 className="text-sm font-medium">
                    Ora sai cosa aspettarti dal collaboratore.
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    Nel prodotto completo potrai collegare gli strumenti e attivare la routine «
                    {draft.frequency}». In questa demo puoi rivedere il metodo o riprovare.
                  </p>
                  <Button variant="outline" className="mt-4" onClick={onRestart}>
                    <RotateCcw />
                    Riprova
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="mt-5 space-y-5">
              <div className="rounded-xl bg-secondary/40 p-4">
                <p className="text-sm font-medium">
                  {missing.length
                    ? `${draft.name} ha bisogno di un punto di partenza.`
                    : "Il materiale è pronto per la prima prova."}
                </p>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {missing.length
                    ? `Aggiungi: ${missing.join(" e ").toLowerCase()}.`
                    : sample
                      ? "Puoi esplorare il risultato previsto per questo esempio."
                      : "Hai preparato un caso personalizzato. L’elaborazione di questi contenuti richiede il futuro motore; qui restano disponibili da rivedere."}
                </p>
              </div>
              {example && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
                  <div>
                    <p className="text-sm font-medium">Vuoi vedere subito come funziona?</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Usa una richiesta e materiali fittizi già pronti.
                    </p>
                  </div>
                  <Button variant="outline" onClick={onSamples}>
                    <FileText />
                    {draft.context || draft.knowledge
                      ? "Sostituisci con l’esempio"
                      : "Usa i materiali di esempio"}
                  </Button>
                </div>
              )}
              <JourneyField
                id="trial-request"
                label={example?.requestLabel ?? "Un caso da cui partire"}
                value={draft.context}
                onChange={(v) => update("context", v)}
                multiline
                placeholder="Incolla il testo da usare per la prova"
              />
              <JourneyField
                id="trial-reference"
                label={example?.referenceLabel ?? "Materiali di riferimento"}
                value={draft.knowledge}
                onChange={(v) => update("knowledge", v)}
                multiline
                placeholder="Aggiungi le informazioni necessarie al lavoro"
              />
              {sample && (
                <Button onClick={onTrial} className="h-auto min-h-11 whitespace-normal py-3">
                  Esplora il risultato della prova
                  <ArrowRight />
                </Button>
              )}
              {!sample && !missing.length && example && (
                <p className="text-xs text-muted-foreground">
                  L’esito guidato è disponibile solo con contenuti e metodo originali dello
                  scenario. Puoi rivedere il metodo o conservare il tuo caso personalizzato.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
