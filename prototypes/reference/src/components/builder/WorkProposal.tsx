import { ArrowLeft, ArrowRight, Bot, Check, Clock3, Pencil, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DEMO_TOOLS } from "@/lib/first-work";
import { exampleFor, type AssistedDraft } from "@/lib/assisted-work";
import { Choice, JourneyField } from "./FirstWorkFields";

export type UpdateProposal = <K extends keyof AssistedDraft>(
  key: K,
  value: AssistedDraft[K],
) => void;

export function WorkProposal({
  draft,
  update,
  onAccept,
  onBack,
  error,
  editing,
}: {
  draft: AssistedDraft;
  update: UpdateProposal;
  onAccept: () => void;
  onBack: () => void;
  error: string;
  editing: boolean;
}) {
  const example = exampleFor(draft);
  return (
    <div className="mx-auto max-w-4xl">
      <button
        type="button"
        onClick={onBack}
        className="mb-6 flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3" />
        {editing ? "Torna al lavoro" : "Cambia il bisogno"}
      </button>
      <p className="text-xs text-muted-foreground">
        {example
          ? `Esempio guidato · ${example.label}`
          : "Richiesta libera · configurazione manuale"}
      </p>
      <h1 className="mt-3 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
        {example ? "Ecco chi può occuparsene." : "Diamo un metodo alla tua idea."}
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        {example
          ? "Una proposta da rivedere insieme. Il primo passo sarà una prova, prima di rendere il lavoro ricorrente."
          : "Il motore AI arriverà dopo. Qui puoi impostare il metodo a mano oppure tornare indietro e provare un esempio guidato."}
      </p>

      <div className="mt-7 grid gap-6 md:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 rounded-2xl border border-border bg-card/60 p-5 sm:p-6">
          <div className="flex items-start gap-4">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-secondary text-accent">
              <Bot className="size-5" />
            </div>
            <div className="min-w-0">
              <h2 className="break-words text-xl font-semibold">{draft.name || "Collaboratore"}</h2>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
                {draft.responsibility}
              </p>
            </div>
          </div>
          <div className="mt-6 space-y-3">
            <p className="text-xs font-semibold text-accent">Come lavorerà</p>
            {draft.method.trim() ? (
              <ol className="space-y-3">
                {draft.method
                  .split("\n")
                  .filter((line) => line.trim())
                  .map((step, index) => (
                    <li key={index} className="flex gap-3 text-sm leading-relaxed">
                      <span className="mt-0.5 text-xs text-muted-foreground">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="min-w-0 break-words">{step}</span>
                    </li>
                  ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">
                Aggiungi i passaggi da seguire qui sotto.
              </p>
            )}
          </div>
          <details className="mt-5 border-t border-border pt-4" open={!example}>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              <Pencil className="mr-2 inline size-3" />
              Modifica responsabilità e metodo
            </summary>
            <div className="mt-4 space-y-4">
              <JourneyField
                id="proposal-role"
                label="Responsabilità"
                value={draft.responsibility}
                onChange={(v) => update("responsibility", v)}
                multiline
              />
              <JourneyField
                id="proposal-method"
                label="Passaggi del metodo"
                value={draft.method}
                onChange={(v) => update("method", v)}
                multiline
                hint="Un passaggio per riga. Indica anche come verificare il risultato."
              />
              <JourneyField
                id="proposal-result"
                label="Risultato da ottenere"
                value={draft.outcome}
                onChange={(v) => update("outcome", v)}
                multiline
              />
            </div>
          </details>
        </div>
        <div className="min-w-0 space-y-5 py-2">
          <div>
            <p className="text-xs font-semibold">Ti consegnerà</p>
            <p className="mt-2 break-words text-sm leading-relaxed text-muted-foreground">
              {draft.outcome}
            </p>
          </div>
          <div className="flex gap-3">
            <Clock3 className="mt-0.5 size-4 shrink-0 text-accent" />
            <div>
              <p className="text-sm font-medium">{draft.frequency}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Frequenza prevista, da attivare dopo la prova.
              </p>
            </div>
          </div>
          <div className="flex gap-3">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              {draft.autonomy === "draft"
                ? "Produce bozze. Invii e pubblicazioni restano a te."
                : "Ti chiede conferma prima di inviare o pubblicare."}
            </p>
          </div>
          <div className="border-t border-border pt-4">
            <p className="text-xs font-semibold">Modelli e budget</p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {draft.aiPolicy === "local"
                ? "Solo locali · nessun costo API remoto"
                : `Locali e remoti · limite ${draft.budget || "da definire"} € per lavoro`}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Nessun consumo in questa demo.</p>
          </div>
          <details className="border-t border-border pt-4">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Nome, strumenti e altre impostazioni
            </summary>
            <div className="mt-4 space-y-4">
              <JourneyField
                id="proposal-name"
                label="Nome"
                value={draft.name}
                onChange={(v) => update("name", v)}
              />
              <JourneyField
                id="proposal-frequency"
                label="Quando lavora"
                value={draft.frequency}
                onChange={(v) => update("frequency", v)}
              />
              <fieldset>
                <legend className="mb-2 text-xs font-medium">Strumenti previsti</legend>
                {DEMO_TOOLS.map((tool) => (
                  <label key={tool.id} className="flex gap-2 py-1 text-xs">
                    <input
                      type="checkbox"
                      checked={draft.tools.includes(tool.id)}
                      onChange={(e) =>
                        update(
                          "tools",
                          e.target.checked
                            ? [...draft.tools, tool.id]
                            : draft.tools.filter((id) => id !== tool.id),
                        )
                      }
                    />
                    {tool.label}
                  </label>
                ))}
              </fieldset>
              <fieldset className="space-y-2">
                <legend className="mb-2 text-xs font-medium">Autonomia</legend>
                <Choice
                  name="autonomy-v2"
                  value="review"
                  checked={draft.autonomy === "review"}
                  onChange={() => update("autonomy", "review")}
                  title="Chiede prima di inviare"
                >
                  Rivedi le azioni esterne.
                </Choice>
                <Choice
                  name="autonomy-v2"
                  value="draft"
                  checked={draft.autonomy === "draft"}
                  onChange={() => update("autonomy", "draft")}
                  title="Solo bozze"
                >
                  Agisci tu all’esterno.
                </Choice>
              </fieldset>
              <fieldset className="space-y-2">
                <legend className="mb-2 text-xs font-medium">Modelli</legend>
                <Choice
                  name="policy-v2"
                  value="local"
                  checked={draft.aiPolicy === "local"}
                  onChange={() => update("aiPolicy", "local")}
                  title="Solo locali"
                >
                  Elaborazione sul computer.
                </Choice>
                <Choice
                  name="policy-v2"
                  value="mixed"
                  checked={draft.aiPolicy === "mixed"}
                  onChange={() => update("aiPolicy", "mixed")}
                  title="Locali e remoti"
                >
                  Tra i servizi consentiti.
                </Choice>
              </fieldset>
              {draft.aiPolicy === "mixed" && (
                <JourneyField
                  id="proposal-budget"
                  label="Limite remoto per lavoro (€)"
                  value={draft.budget}
                  onChange={(v) => update("budget", v)}
                  hint="Comprende tentativi e deleghe. I servizi saranno configurati con il motore."
                />
              )}
            </div>
          </details>
        </div>
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-4">
        <Button className="h-auto min-h-11 whitespace-normal px-5 py-3" onClick={onAccept}>
          {editing ? <Check /> : <ArrowRight />}
          {editing ? "Salva le modifiche" : "Va bene, aggiungilo alla squadra"}
        </Button>
        <p className="text-xs text-muted-foreground">
          {editing
            ? "La prova torna da preparare."
            : "Poi gli daremo i materiali per il primo lavoro."}
        </p>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
