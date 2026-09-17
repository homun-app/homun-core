import { useEffect, useRef, useState } from "react";
import { ArrowRight, MessageSquare, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { prepareDemoWork } from "@/lib/first-work";
import {
  createProposal,
  sampleMaterials,
  sampleResult,
  WORK_EXAMPLES,
  type AssistedDraft,
} from "@/lib/assisted-work";
import { WorkProposal, type UpdateProposal } from "./WorkProposal";
import { FirstWorkSpace, type TrialStage } from "./FirstWorkSpace";

type Phase = "need" | "proposal" | "workspace";
type Session = {
  need: string;
  draft: AssistedDraft | null;
  phase: Phase;
  trial: TrialStage;
  editing: boolean;
};
const emptySession = (): Session => ({
  need: "",
  draft: null,
  phase: "need",
  trial: "waiting",
  editing: false,
});

function readSession(key: string): Session | null {
  const raw = sessionStorage.getItem(key);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (
      value?.version !== 2 ||
      typeof value.need !== "string" ||
      !["need", "proposal", "workspace"].includes(value.phase) ||
      !["waiting", "review", "done"].includes(value.trial)
    )
      return null;
    if (value.draft) {
      const fields = createProposal("", null);
      for (const key of Object.keys(fields) as (keyof AssistedDraft)[]) {
        if (key === "exampleId") {
          if (
            value.draft[key] !== null &&
            !WORK_EXAMPLES.some((example) => example.id === value.draft[key])
          )
            return null;
        } else if (key === "tools") {
          if (
            !Array.isArray(value.draft.tools) ||
            !value.draft.tools.every((tool: unknown) => typeof tool === "string")
          )
            return null;
        } else if (typeof value.draft[key] !== "string") return null;
      }
      if (
        !["local", "mixed"].includes(value.draft.aiPolicy) ||
        !["review", "draft"].includes(value.draft.autonomy)
      )
        return null;
      if (value.phase === "workspace" && !prepareDemoWork(value.draft).ok) return null;
      if (value.trial !== "waiting" && !sampleResult(value.draft)) value.trial = "waiting";
    } else if (value.phase !== "need") return null;
    return {
      need: value.need,
      draft: value.draft,
      phase: value.phase,
      trial: value.trial,
      editing: value.editing === true,
    };
  } catch {
    return null;
  }
}

export function FirstWorkJourney({
  projectName,
  storageKey,
}: {
  projectName: string;
  storageKey: string;
}) {
  const [state, setState] = useState<Session>(emptySession);
  const [ready, setReady] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const [error, setError] = useState("");
  const content = useRef<HTMLDivElement>(null);
  const key = `${storageKey}:assisted-v2`;
  useEffect(() => {
    try {
      const saved = readSession(key);
      if (saved) setState(saved);
    } catch {
      setStorageOk(false);
    }
    setReady(true);
  }, [key]);
  useEffect(() => {
    if (!ready) return;
    try {
      sessionStorage.setItem(key, JSON.stringify({ ...state, version: 2 }));
    } catch {
      setStorageOk(false);
    }
  }, [state, ready, key]);

  function focusHeading() {
    requestAnimationFrame(() => {
      content.current?.focus();
      content.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  const update: UpdateProposal = (field, value) => {
    setState((current) =>
      current.draft
        ? { ...current, draft: { ...current.draft, [field]: value }, trial: "waiting" }
        : current,
    );
    setError("");
  };
  function propose(exampleId: string | null) {
    const example = WORK_EXAMPLES.find((item) => item.id === exampleId);
    const need = example?.need ?? state.need.trim();
    if (!need) {
      setError("Descrivi il bisogno oppure scegli un esempio da esplorare.");
      return;
    }
    setState((current) => ({
      ...current,
      need,
      draft: createProposal(need, exampleId),
      phase: "proposal",
      trial: "waiting",
      editing: false,
    }));
    setError("");
    focusHeading();
  }
  function accept() {
    if (!state.draft) return;
    const draft = {
      ...state.draft,
      name: state.draft.name.trim() || "Collaboratore",
      frequency: state.draft.frequency.trim() || "Su richiesta",
    };
    const validation = prepareDemoWork(draft);
    if (!validation.ok) {
      setError(
        state.draft.method.trim()
          ? validation.error
          : "Aggiungi il metodo da seguire, con un passaggio per riga.",
      );
      return;
    }
    setState((current) => ({
      ...current,
      draft,
      phase: "workspace",
      editing: false,
    }));
    setError("");
    focusHeading();
  }
  if (!ready) return <p className="py-8 text-sm text-muted-foreground">Preparo lo spazio…</p>;
  return (
    <section aria-label="Percorso assistito" className="mx-auto max-w-5xl">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span className="rounded-full border border-border px-3 py-1.5">
          Prototipo UX · esempi simulati, nessun servizio attivo
        </span>
        <span className="break-words">{projectName}</span>
      </div>
      <div ref={content} tabIndex={-1} className="scroll-mt-6 outline-none">
        {state.phase === "need" && (
          <div className="mx-auto max-w-3xl py-5 sm:py-10">
            <div className="mb-6 flex size-11 items-center justify-center rounded-2xl bg-secondary text-accent">
              <MessageSquare className="size-5" />
            </div>
            <h1 className="max-w-xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
              Quale lavoro vorresti
              <br className="hidden sm:block" /> toglierti dalle spalle?
            </h1>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
              Partiamo da un bisogno. Definiamo chi se ne occupa, come lavora e cosa deve chiederti.
            </p>
            <form
              className="mt-7"
              onSubmit={(event) => {
                event.preventDefault();
                propose(null);
              }}
            >
              <Label htmlFor="assisted-need" className="text-xs text-muted-foreground">
                Il tuo bisogno
              </Label>
              <Textarea
                id="assisted-need"
                value={state.need}
                onChange={(event) => {
                  setState((current) => ({ ...current, need: event.target.value }));
                  setError("");
                }}
                placeholder="Per esempio: seguire le richieste dei clienti ogni mattina…"
                className="mt-2 min-h-28 resize-y bg-card/40 p-4 text-sm leading-relaxed"
              />
              <div className="mt-3 flex flex-wrap items-center gap-4">
                <Button type="submit">
                  Imposta la tua proposta
                  <ArrowRight />
                </Button>
                <span className="text-xs text-muted-foreground">
                  Percorso libero, configurabile a mano.
                </span>
              </div>
              {error && (
                <p role="alert" className="mt-3 text-sm text-destructive">
                  {error}
                </p>
              )}
            </form>
            <div className="mt-10 border-t border-border pt-6">
              <h2 className="text-sm font-medium">Oppure esplora una proposta già pronta</h2>
              <p className="mt-2 text-xs text-muted-foreground">
                Tre esempi per provare il percorso. Lo stesso bot può avere qualsiasi
                responsabilità.
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                {WORK_EXAMPLES.map((example) => (
                  <button
                    type="button"
                    key={example.id}
                    onClick={() => propose(example.id)}
                    className="group rounded-xl border border-border bg-card/40 p-4 text-left transition-colors hover:border-accent/40 hover:bg-card"
                  >
                    <span className="block text-sm font-medium">{example.label}</span>
                    <span className="mt-2 block text-xs text-muted-foreground">
                      {example.frequency}
                    </span>
                    <span className="mt-4 flex items-center gap-2 text-xs text-accent">
                      Esplora esempio
                      <ArrowRight className="size-3 transition-transform group-hover:translate-x-1" />
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        {state.phase === "proposal" && state.draft && (
          <WorkProposal
            draft={state.draft}
            update={update}
            error={error}
            editing={state.editing}
            onAccept={accept}
            onBack={() => {
              if (state.editing) {
                accept();
                return;
              }
              setState((current) => ({
                ...current,
                phase: "need",
                editing: false,
              }));
              setError("");
              focusHeading();
            }}
          />
        )}
        {state.phase === "workspace" && state.draft && (
          <FirstWorkSpace
            draft={state.draft}
            trial={state.trial}
            update={update}
            onSamples={() =>
              setState((current) =>
                current.draft
                  ? { ...current, draft: sampleMaterials(current.draft), trial: "waiting" }
                  : current,
              )
            }
            onTrial={() => {
              if (state.draft && sampleResult(state.draft)) {
                setState((current) => ({ ...current, trial: "review" }));
                focusHeading();
              }
            }}
            onReview={() => {
              setState((current) => ({ ...current, trial: "done" }));
              focusHeading();
            }}
            onEdit={() => {
              setState((current) => ({ ...current, phase: "proposal", editing: true }));
              focusHeading();
            }}
            onRestart={() => {
              setState((current) => ({ ...current, trial: "waiting" }));
              focusHeading();
            }}
          />
        )}
      </div>
      <footer className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-[11px] text-muted-foreground">
        <p role="status">
          {storageOk
            ? "Bozza conservata nella sessione del browser, separata dai dati del progetto."
            : "Salvataggio non disponibile: mantieni aperta questa pagina."}
        </p>
        {state.phase !== "need" && (
          <details>
            <summary className="cursor-pointer">Ricomincia</summary>
            <p className="mt-2 max-w-64">La bozza di questo percorso verrà sostituita.</p>
            <Button
              size="sm"
              variant="ghost"
              className="mt-2"
              onClick={() => {
                setState(emptySession());
                setError("");
                focusHeading();
              }}
            >
              <RotateCcw />
              Azzera e ricomincia
            </Button>
          </details>
        )}
      </footer>
    </section>
  );
}
