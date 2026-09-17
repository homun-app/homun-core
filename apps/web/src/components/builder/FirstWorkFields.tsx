import type { ReactNode } from "react";
import { Input } from "@homun/ui/components/input";
import { Textarea } from "@homun/ui/components/textarea";
import { Label } from "@homun/ui/components/label";
import { DEMO_TOOLS, type FirstWorkDraft } from "@/lib/first-work";

export function JourneyField({
  id,
  label,
  value,
  onChange,
  multiline = false,
  hint,
  placeholder,
  type = "text",
  required = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  hint?: string;
  placeholder?: string;
  type?: string;
  required?: boolean;
}) {
  const props = {
    id,
    value,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange(event.target.value),
    required,
    "aria-describedby": hint ? `${id}-hint` : undefined,
    placeholder,
  };
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-sm font-medium">
        {label}
      </Label>
      {multiline ? (
        <Textarea
          {...props}
          rows={4}
          className="min-h-28 resize-y bg-background/50 leading-relaxed"
        />
      ) : (
        <Input {...props} type={type} className="h-11 bg-background/50" />
      )}
      {hint && (
        <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

export function Choice({
  checked,
  onChange,
  title,
  children,
  name,
  value,
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  children: ReactNode;
  name: string;
  value: string;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors ${checked ? "border-accent/40 bg-secondary/50" : "border-border hover:bg-secondary/30"}`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="mt-1 accent-primary"
      />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{children}</span>
      </span>
    </label>
  );
}

export function CollaboratorFields({
  draft,
  update,
}: {
  draft: FirstWorkDraft;
  update: <K extends keyof FirstWorkDraft>(key: K, value: FirstWorkDraft[K]) => void;
}) {
  return (
    <div className="space-y-7">
      <JourneyField
        id="bot-name"
        label="Come si chiama?"
        value={draft.name}
        onChange={(v) => update("name", v)}
        placeholder="Scegli un nome"
        required
      />
      <JourneyField
        id="bot-responsibility"
        label="Di cosa è responsabile?"
        value={draft.responsibility}
        onChange={(v) => update("responsibility", v)}
        multiline
        required
        hint="Puoi affidargli qualsiasi ruolo. Descrivi il risultato di cui deve occuparsi."
      />
      <JourneyField
        id="bot-knowledge"
        label="Cosa deve conoscere?"
        value={draft.knowledge}
        onChange={(v) => update("knowledge", v)}
        multiline
        placeholder="Documenti di riferimento, regole aziendali, preferenze…"
        hint="Per questa prova descrivi i materiali. Il collegamento al vault arriverà nel prossimo percorso."
      />
      <details className="rounded-xl border border-border p-4">
        <summary className="cursor-pointer text-sm font-medium">
          Strumenti a disposizione{" "}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {draft.tools.length} selezionati · demo
          </span>
        </summary>
        <p className="mt-3 text-xs text-muted-foreground">
          La selezione è dimostrativa: nessun servizio viene collegato.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {DEMO_TOOLS.map((tool) => (
            <label
              key={tool.id}
              className="flex cursor-pointer gap-3 rounded-lg bg-background/40 p-3"
            >
              <input
                type="checkbox"
                className="mt-1 accent-primary"
                checked={draft.tools.includes(tool.id)}
                onChange={(event) =>
                  update(
                    "tools",
                    event.target.checked
                      ? [...draft.tools, tool.id]
                      : draft.tools.filter((id) => id !== tool.id),
                  )
                }
              />
              <span>
                <span className="block text-sm">{tool.label}</span>
                <span className="block text-xs text-muted-foreground">{tool.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </details>
      <fieldset className="space-y-3">
        <legend className="mb-3 text-sm font-medium">Quando deve coinvolgerti?</legend>
        <Choice
          name="autonomy"
          value="review"
          checked={draft.autonomy === "review"}
          onChange={() => update("autonomy", "review")}
          title="Prima di agire all’esterno"
        >
          Prepara il lavoro; chiede il tuo consenso prima di inviare o pubblicare.
        </Choice>
        <Choice
          name="autonomy"
          value="draft"
          checked={draft.autonomy === "draft"}
          onChange={() => update("autonomy", "draft")}
          title="Produce solo bozze"
        >
          Ti consegna il risultato. Invii e pubblicazioni restano a te.
        </Choice>
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="mb-3 text-sm font-medium">Come utilizza l’AI</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Choice
            name="policy"
            value="local"
            checked={draft.aiPolicy === "local"}
            onChange={() => update("aiPolicy", "local")}
            title="Solo sul computer"
          >
            Modelli locali. Se una capacità non basta, il collaboratore si ferma e te lo segnala.
          </Choice>
          <Choice
            name="policy"
            value="mixed"
            checked={draft.aiPolicy === "mixed"}
            onChange={() => update("aiPolicy", "mixed")}
            title="Locale e remota"
          >
            Può cambiare modello entro i limiti che assegni e con i servizi consentiti.
          </Choice>
        </div>
        {draft.aiPolicy === "mixed" && (
          <div className="space-y-3 rounded-xl bg-background/50 p-4">
            <JourneyField
              id="bot-budget"
              label="Limite remoto per il primo lavoro (€)"
              value={draft.budget}
              onChange={(v) => update("budget", v)}
              placeholder="Es. 2,50"
              required
              hint="Include tentativi e contributi di altri bot. Nessuna spesa viene effettuata nella demo."
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Prima dell’uso reale servirà scegliere i servizi remoti consentiti e quali
              informazioni possono ricevere.
            </p>
          </div>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          Configurazione dimostrativa. Nessun modello viene avviato. Il lavoro locale non ha costi
          API, ma utilizza le risorse del computer.
        </p>
      </fieldset>
    </div>
  );
}

export function WorkFields({
  draft,
  update,
}: {
  draft: FirstWorkDraft;
  update: <K extends keyof FirstWorkDraft>(key: K, value: FirstWorkDraft[K]) => void;
}) {
  return (
    <div className="space-y-6">
      <JourneyField
        id="work-title"
        label="Qual è il primo lavoro?"
        value={draft.title}
        onChange={(v) => update("title", v)}
        placeholder="Un incarico concreto, con un risultato riconoscibile"
        required
      />
      <JourneyField
        id="work-outcome"
        label="Cosa vuoi ricevere?"
        value={draft.outcome}
        onChange={(v) => update("outcome", v)}
        multiline
        placeholder="Descrivi il risultato e come capire se è corretto"
        required
      />
      <JourneyField
        id="work-context"
        label="Informazioni per questo incarico"
        value={draft.context}
        onChange={(v) => update("context", v)}
        multiline
        placeholder="Incolla una richiesta o aggiungi i dettagli da cui partire"
        hint="Queste informazioni appartengono al lavoro, non diventano automaticamente memoria del collaboratore."
      />
      <JourneyField
        id="work-deadline"
        label="Entro quando? (facoltativo)"
        type="date"
        value={draft.deadline}
        onChange={(v) => update("deadline", v)}
      />
      <div className="rounded-xl border border-border bg-background/30 p-4 sm:p-5">
        <JourneyField
          id="work-method"
          label="Il metodo da seguire"
          value={draft.method}
          onChange={(v) => update("method", v)}
          multiline
          required
          hint="Un passaggio per riga. È una traccia generica modificabile, non un piano generato dall’AI."
        />
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Il lavoro sarà pronto quando il risultato sarà verificato. Potremo definire i criteri di
          ogni passaggio nel dettaglio dell’incarico.
        </p>
      </div>
    </div>
  );
}
