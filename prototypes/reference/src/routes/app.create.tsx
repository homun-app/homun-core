import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ArrowRight, Bot, Check, MessageSquare, Network, Workflow } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useWorkspace } from "@/hooks/useWorkspace";
import { getPlugin, PLUGINS, type FieldDef } from "@/lib/plugins";
import {
  ROLE_PRESETS,
  TONES,
  actionOptions,
  actionOf,
  composeInstructions,
  describeDraft,
  emptyDraft,
  suggestName,
  triggerOf,
  triggerOptions,
  type AutomationDraft,
  type BotAnswers,
} from "@/lib/builder";
import { FlowMap } from "@/components/builder/FlowMap";
import { ConversationWork as FirstWorkJourney } from "@/components/builder/ConversationWork";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/app/create")({
  head: () => ({
    meta: [
      { title: "Crea — Homun" },
      {
        name: "description",
        content: "Crea un collaboratore o un'automazione parlando, oppure disegnando la mappa.",
      },
      { property: "og:title", content: "Crea — Homun" },
      {
        property: "og:description",
        content: "Homun ti fa qualche domanda e prepara il lavoro al posto tuo.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: CreatePage,
});

type What = null | "automazione" | "collaboratore";

function CreatePage() {
  const { activeProject, canWrite, canManage } = useWorkspace();
  const { user } = useAuth();
  const projectId = activeProject?.id;
  const [what, setWhat] = useState<What>(null);

  const { data: installs } = useQuery({
    queryKey: ["plugin-installations", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("plugin_installations")
        .select("plugin_id,connected")
        .eq("project_id", projectId!);
      return data ?? [];
    },
  });
  const installedIds = (installs ?? []).map((i) => i.plugin_id);

  return (
    <div className="min-h-full">
      <div className="mx-auto max-w-5xl space-y-10 px-4 py-8 sm:px-8 sm:py-12">
        {what !== null && <header>
          <p className="eyebrow text-accent">Officina</p>
          <h1 className="mt-3 text-4xl font-bold leading-[1.05] tracking-tight text-foreground md:text-5xl">
            Cosa mettiamo
            <br />
            <span className="text-primary">al lavoro oggi?</span>
          </h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
            Ti faccio qualche domanda e preparo tutto io. Se preferisci vedere subito lo schema,
            puoi passare alla mappa in qualsiasi momento.
          </p>
        </header>}

        {what === null && <>
          {!canManage && <p className="text-sm text-muted-foreground">Puoi esplorare questa pagina. Per preparare un collaboratore serve il ruolo di gestore o titolare.</p>}
          <fieldset disabled={!canManage} className="min-w-0">
            <FirstWorkJourney
              key={`${user?.id}:${projectId}`}
              storageKey={`homun.first-work.v1:${user?.id}:${projectId}`}
              projectName={activeProject?.name ?? "Progetto"}
            />
          </fieldset>
        </>}

        {!canWrite && (
          <p className="rounded-r-xl border-l-4 border-accent bg-card p-6 text-sm text-muted-foreground">
            Con il tuo ruolo puoi guardare ma non creare. Chiedi al titolare del progetto.
          </p>
        )}

        {what === null && (
          <details className="border-t border-border pt-6">
            <summary className="cursor-pointer text-sm text-muted-foreground">Altri percorsi di creazione esistenti</summary>
            <div className="mt-5 grid gap-4 md:grid-cols-2">
            <ChoiceCard
              icon={Bot}
              eyebrow="Un collaboratore"
              title="Assumi qualcuno nella squadra"
              text="Gli dai un nome, un ruolo e gli spieghi di cosa si occupa. Poi puoi parlarci in chat."
              onClick={() => setWhat("collaboratore")}
              disabled={!canWrite}
            />
            <ChoiceCard
              icon={Workflow}
              eyebrow="Un'automazione"
              title="Una regola che lavora da sola"
              text="«Quando succede questo → fai quello». La costruiamo parlando o sulla mappa."
              onClick={() => setWhat("automazione")}
              disabled={!canWrite}
            />
            </div>
          </details>
        )}

        {what === "collaboratore" && (
          <BotBuilder installedIds={installedIds} onBack={() => setWhat(null)} />
        )}
        {what === "automazione" && (
          <AutomationBuilder installedIds={installedIds} onBack={() => setWhat(null)} />
        )}
      </div>
    </div>
  );
}

function ChoiceCard({
  icon: Icon,
  eyebrow,
  title,
  text,
  onClick,
  disabled,
}: {
  icon: typeof Bot;
  eyebrow: string;
  title: string;
  text: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group rounded-2xl border border-border bg-card p-7 text-left transition-colors hover:border-primary disabled:opacity-50"
    >
      <Icon className="size-5 text-accent" />
      <p className="eyebrow mt-5 text-muted-foreground">{eyebrow}</p>
      <h2 className="mt-2 text-xl font-semibold text-foreground">{title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{text}</p>
      <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-primary">
        Comincia <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
  );
}

/* ------------------------------- Conversazione ------------------------------ */

function Turn({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-accent">
        <MessageSquare className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1 space-y-3 pb-1">{children}</div>
    </div>
  );
}

function Said({ text }: { text: string }) {
  return (
    <div className="flex justify-end pl-10">
      <span className="rounded-2xl rounded-br-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
        {text}
      </span>
    </div>
  );
}

function Options({
  options,
  onPick,
}: {
  options: { key: string; label: string; hint?: string }[];
  onPick: (key: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onPick(o.key)}
          className="rounded-xl border border-border bg-card px-4 py-2.5 text-left text-sm text-foreground transition-colors hover:border-primary hover:bg-secondary/60"
        >
          {o.label}
          {o.hint && <span className="block text-xs text-muted-foreground">{o.hint}</span>}
        </button>
      ))}
    </div>
  );
}

function FieldsForm({
  fields,
  values,
  onChange,
  onDone,
}: {
  fields: FieldDef[];
  values: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  onDone: () => void;
}) {
  const missing = fields.some((f) => f.required && !(values[f.key] ?? "").trim());
  return (
    <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
      {fields.map((f) => (
        <div key={f.key} className="space-y-1.5">
          <Label htmlFor={`f-${f.key}`} className="text-xs">
            {f.label}
          </Label>
          {f.type === "textarea" ? (
            <Textarea
              id={`f-${f.key}`}
              placeholder={f.placeholder ?? ""}
              value={values[f.key] ?? ""}
              onChange={(e) => onChange({ ...values, [f.key]: e.target.value })}
            />
          ) : (
            <Input
              id={`f-${f.key}`}
              type={f.type === "number" ? "number" : f.type === "email" ? "email" : "text"}
              placeholder={f.placeholder ?? ""}
              value={values[f.key] ?? ""}
              onChange={(e) => onChange({ ...values, [f.key]: e.target.value })}
            />
          )}
        </div>
      ))}
      <Button onClick={onDone} disabled={missing} size="sm">
        Va bene così
      </Button>
    </div>
  );
}

/* -------------------------------- Automazione ------------------------------- */

type Stage = "trigger" | "triggerFields" | "action" | "actionFields" | "more" | "name" | "done";

function AutomationBuilder({
  installedIds,
  onBack,
}: {
  installedIds: string[];
  onBack: () => void;
}) {
  const { activeProject } = useWorkspace();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<"parlando" | "mappa">("parlando");
  const [draft, setDraft] = useState<AutomationDraft>(emptyDraft);
  const [stage, setStage] = useState<Stage>("trigger");
  const [pendingConfig, setPendingConfig] = useState<Record<string, string>>({});

  const triggers = useMemo(() => triggerOptions(installedIds), [installedIds]);
  const actions = useMemo(() => actionOptions(installedIds), [installedIds]);
  const trigger = triggerOf(draft);
  const lastStep = draft.steps[draft.steps.length - 1];
  const lastAction = lastStep ? actionOf(lastStep) : undefined;

  const save = useMutation({
    mutationFn: async (activate: boolean) => {
      if (!activeProject || !user) throw new Error("Progetto non disponibile");
      const { data, error } = await supabase
        .from("pipelines")
        .insert({
          project_id: activeProject.id,
          created_by: user.id,
          name: draft.name.trim() || suggestName(draft),
          description: describeDraft(draft),
          trigger_plugin: draft.triggerPluginId,
          trigger_key: draft.triggerKey,
          trigger_config: draft.triggerConfig,
          active: activate,
        })
        .select("id")
        .single();
      if (error) throw error;
      if (draft.steps.length) {
        const { error: stepError } = await supabase.from("pipeline_steps").insert(
          draft.steps.map((s, i) => ({
            pipeline_id: data.id,
            plugin_id: s.pluginId,
            action_key: s.actionKey,
            config: s.config,
            position: i,
            label: actionOf(s)?.label ?? null,
          }))
        );
        if (stepError) throw stepError;
      }
    },
    onSuccess: () => {
      toast.success("Automazione pronta");
      void queryClient.invalidateQueries({ queryKey: ["pipelines", activeProject?.id] });
      void navigate({ to: "/app/pipelines" });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Non riuscito"),
  });

  if (!triggers.length) {
    return (
      <div className="rounded-r-xl border-l-4 border-accent bg-card p-6">
        <p className="text-sm font-semibold text-foreground">Prima serve uno strumento</p>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          Un'automazione parte da qualcosa che accade: una email, una fattura scaduta, una pagina
          che cambia. Installa uno strumento nella pagina Plugin e torna qui.
        </p>
        <div className="mt-4 flex gap-2">
          <Button onClick={() => navigate({ to: "/app/plugins" })} size="sm">
            Vai agli strumenti
          </Button>
          <Button variant="ghost" size="sm" onClick={onBack}>
            Indietro
          </Button>
        </div>
      </div>
    );
  }

  const ready = draft.triggerKey && draft.steps.length > 0 && draft.steps.every((s) => s.actionKey);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-xl border border-border bg-card p-1">
          {(
            [
              { id: "parlando", label: "Parlando", icon: MessageSquare },
              { id: "mappa", label: "Sulla mappa", icon: Network },
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
                mode === m.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <m.icon className="size-4" /> {m.label}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          Cambia idea
        </Button>
      </div>

      {mode === "parlando" ? (
        <div className="space-y-4 rounded-2xl border border-border bg-secondary/20 p-6">
          <Turn>
            <p className="text-sm leading-relaxed text-foreground">
              Cominciamo dall'inizio: <strong>cosa deve far partire il lavoro?</strong>
            </p>
            {stage === "trigger" && (
              <Options
                options={triggers.map((t) => ({
                  key: `${t.pluginId}:${t.key}`,
                  label: t.label,
                  hint: t.pluginName,
                }))}
                onPick={(key) => {
                  const [pluginId, triggerKey] = key.split(":");
                  const t = getPlugin(pluginId!)?.triggers.find((x) => x.key === triggerKey);
                  setDraft({
                    ...draft,
                    triggerPluginId: pluginId!,
                    triggerKey: triggerKey!,
                    triggerConfig: {},
                  });
                  setPendingConfig({});
                  setStage(t?.fields?.length ? "triggerFields" : "action");
                }}
              />
            )}
          </Turn>

          {draft.triggerKey && <Said text={trigger?.label ?? ""} />}

          {stage === "triggerFields" && (
            <Turn>
              <p className="text-sm leading-relaxed text-foreground">
                Perfetto. Mi servono due dettagli.
              </p>
              <FieldsForm
                fields={trigger?.fields ?? []}
                values={pendingConfig}
                onChange={setPendingConfig}
                onDone={() => {
                  setDraft({ ...draft, triggerConfig: pendingConfig });
                  setPendingConfig({});
                  setStage("action");
                }}
              />
            </Turn>
          )}

          {draft.steps.map((s, i) => (
            <Said key={i} text={actionOf(s)?.label ?? ""} />
          ))}

          {stage === "action" && (
            <Turn>
              <p className="text-sm leading-relaxed text-foreground">
                {draft.steps.length ? "E poi cosa deve fare?" : "E allora cosa deve fare?"}
              </p>
              <Options
                options={actions.map((a) => ({
                  key: `${a.pluginId}:${a.key}`,
                  label: a.label,
                  hint: a.pluginName,
                }))}
                onPick={(key) => {
                  const [pluginId, actionKey] = key.split(":");
                  const a = getPlugin(pluginId!)?.actions.find((x) => x.key === actionKey);
                  setDraft({
                    ...draft,
                    steps: [
                      ...draft.steps,
                      { pluginId: pluginId!, actionKey: actionKey!, config: {} },
                    ],
                  });
                  setPendingConfig({});
                  setStage(a?.fields?.length ? "actionFields" : "more");
                }}
              />
            </Turn>
          )}

          {stage === "actionFields" && (
            <Turn>
              <p className="text-sm leading-relaxed text-foreground">Com'è fatto questo passaggio?</p>
              <FieldsForm
                fields={lastAction?.fields ?? []}
                values={pendingConfig}
                onChange={setPendingConfig}
                onDone={() => {
                  setDraft({
                    ...draft,
                    steps: draft.steps.map((s, i) =>
                      i === draft.steps.length - 1 ? { ...s, config: pendingConfig } : s
                    ),
                  });
                  setPendingConfig({});
                  setStage("more");
                }}
              />
            </Turn>
          )}

          {stage === "more" && (
            <Turn>
              <p className="text-sm leading-relaxed text-foreground">
                Deve fare altro dopo, o ci fermiamo qui?
              </p>
              <Options
                options={[
                  { key: "altro", label: "Aggiungi un altro passaggio" },
                  { key: "fine", label: "Ci fermiamo qui" },
                ]}
                onPick={(k) => setStage(k === "altro" ? "action" : "name")}
              />
            </Turn>
          )}

          {stage === "name" && (
            <Turn>
              <p className="text-sm leading-relaxed text-foreground">
                Ultima cosa: come la chiamiamo?
              </p>
              <div className="flex flex-wrap gap-2">
                <Input
                  className="max-w-xs"
                  placeholder={suggestName(draft)}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
                <Button size="sm" onClick={() => setStage("done")}>
                  Fatto
                </Button>
              </div>
            </Turn>
          )}

          {stage === "done" && (
            <Turn>
              <p className="text-sm leading-relaxed text-foreground">
                Ecco come l'ho capita. Se ti convince, la attivo.
              </p>
            </Turn>
          )}
        </div>
      ) : (
        <MapEditor draft={draft} setDraft={setDraft} installedIds={installedIds} />
      )}

      {(mode === "mappa" || draft.triggerKey) && (
        <div className="space-y-4">
          <p className="eyebrow text-muted-foreground">La mappa di questa automazione</p>
          {mode === "parlando" && <FlowMap draft={draft} />}
          <p className="rounded-r-xl border-l-4 border-primary bg-card px-5 py-4 text-sm text-foreground">
            {describeDraft(draft)}
          </p>
        </div>
      )}

      {ready && (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="lg" onClick={() => save.mutate(true)} disabled={save.isPending}>
            <Check /> Attiva adesso
          </Button>
          <Button
            size="lg"
            variant="secondary"
            onClick={() => save.mutate(false)}
            disabled={save.isPending}
          >
            Salva in pausa
          </Button>
        </div>
      )}
    </div>
  );
}

function MapEditor({
  draft,
  setDraft,
  installedIds,
}: {
  draft: AutomationDraft;
  setDraft: (d: AutomationDraft) => void;
  installedIds: string[];
}) {
  const [selected, setSelected] = useState<{ kind: "trigger" } | { kind: "step"; index: number }>({
    kind: "trigger",
  });
  const triggers = useMemo(() => triggerOptions(installedIds), [installedIds]);
  const actions = useMemo(() => actionOptions(installedIds), [installedIds]);

  const step = selected.kind === "step" ? draft.steps[selected.index] : undefined;
  const stepAction = step ? actionOf(step) : undefined;
  const trigger = triggerOf(draft);

  return (
    <div className="space-y-5">
      <FlowMap
        draft={draft}
        selected={selected}
        onSelectTrigger={() => setSelected({ kind: "trigger" })}
        onSelectStep={(index) => setSelected({ kind: "step", index })}
        onRemoveStep={(index) => {
          setDraft({ ...draft, steps: draft.steps.filter((_, i) => i !== index) });
          setSelected({ kind: "trigger" });
        }}
        onAddStep={() => {
          setDraft({ ...draft, steps: [...draft.steps, { pluginId: "", actionKey: "", config: {} }] });
          setSelected({ kind: "step", index: draft.steps.length });
        }}
      />

      <div className="rounded-2xl border border-border bg-card p-6">
        {selected.kind === "trigger" ? (
          <>
            <p className="eyebrow text-accent">Il punto di partenza</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Scegli l'evento che accende l'automazione.
            </p>
            <div className="mt-4">
              <Options
                options={triggers.map((t) => ({
                  key: `${t.pluginId}:${t.key}`,
                  label: t.label,
                  hint: t.pluginName,
                }))}
                onPick={(key) => {
                  const [pluginId, triggerKey] = key.split(":");
                  setDraft({
                    ...draft,
                    triggerPluginId: pluginId!,
                    triggerKey: triggerKey!,
                    triggerConfig: {},
                  });
                }}
              />
            </div>
            {trigger?.fields?.length ? (
              <div className="mt-4">
                <FieldsForm
                  fields={trigger.fields}
                  values={draft.triggerConfig}
                  onChange={(triggerConfig) => setDraft({ ...draft, triggerConfig })}
                  onDone={() => undefined}
                />
              </div>
            ) : null}
          </>
        ) : (
          <>
            <p className="eyebrow text-muted-foreground">Passo {selected.index + 1}</p>
            <p className="mt-2 text-sm text-muted-foreground">Cosa deve fare in questo passaggio.</p>
            <div className="mt-4">
              <Options
                options={actions.map((a) => ({
                  key: `${a.pluginId}:${a.key}`,
                  label: a.label,
                  hint: a.pluginName,
                }))}
                onPick={(key) => {
                  const [pluginId, actionKey] = key.split(":");
                  setDraft({
                    ...draft,
                    steps: draft.steps.map((s, i) =>
                      i === selected.index
                        ? { pluginId: pluginId!, actionKey: actionKey!, config: {} }
                        : s
                    ),
                  });
                }}
              />
            </div>
            {stepAction?.fields?.length ? (
              <div className="mt-4">
                <FieldsForm
                  fields={stepAction.fields}
                  values={step?.config ?? {}}
                  onChange={(config) =>
                    setDraft({
                      ...draft,
                      steps: draft.steps.map((s, i) => (i === selected.index ? { ...s, config } : s)),
                    })
                  }
                  onDone={() => undefined}
                />
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="max-w-xs space-y-1.5">
        <Label htmlFor="map-name" className="text-xs">
          Come si chiama
        </Label>
        <Input
          id="map-name"
          placeholder={suggestName(draft)}
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </div>
    </div>
  );
}

/* ------------------------------- Collaboratore ------------------------------ */

type BotStage = "modo" | "ruolo" | "nome" | "compito" | "tono" | "limiti" | "strumenti" | "done";

function BotBuilder({ installedIds, onBack }: { installedIds: string[]; onBack: () => void }) {
  const { activeProject } = useWorkspace();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [stage, setStage] = useState<BotStage>("modo");
  const [deep, setDeep] = useState(false);
  const [answers, setAnswers] = useState<BotAnswers>({
    name: "",
    role: "",
    focus: "",
    tone: "cordiale",
    limits: "",
    plugins: [],
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!activeProject || !user) throw new Error("Progetto non disponibile");
      const { error } = await supabase.from("bots").insert({
        project_id: activeProject.id,
        created_by: user.id,
        name: answers.name.trim() || "Assistente",
        subtitle: answers.role || null,
        instructions: composeInstructions(answers),
        status: "in_attesa",
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`${answers.name || "Il collaboratore"} è nella squadra`);
      void queryClient.invalidateQueries({ queryKey: ["dashboard", activeProject?.id] });
      void navigate({ to: "/app" });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Non riuscito"),
  });

  const usable = PLUGINS.filter((p) => installedIds.includes(p.id));

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={onBack}>
          Cambia idea
        </Button>
      </div>

      <div className="space-y-4 rounded-2xl border border-border bg-secondary/20 p-6">
        <Turn>
          <p className="text-sm leading-relaxed text-foreground">
            Facciamo con calma o veloce? <strong>Posso proporti un profilo già pronto</strong>{" "}
            oppure farti qualche domanda per costruirlo su misura.
          </p>
          {stage === "modo" && (
            <Options
              options={[
                { key: "rapido", label: "Veloce", hint: "scelgo un profilo pronto e correggo dopo" },
                { key: "profondo", label: "Su misura", hint: "quattro domande, più preciso" },
              ]}
              onPick={(k) => {
                setDeep(k === "profondo");
                setStage("ruolo");
              }}
            />
          )}
        </Turn>

        {stage !== "modo" && <Said text={deep ? "Su misura" : "Veloce"} />}

        {stage !== "modo" && (
          <Turn>
            <p className="text-sm leading-relaxed text-foreground">Di cosa si occupa?</p>
            {stage === "ruolo" && (
              <Options
                options={ROLE_PRESETS.map((r) => ({
                  key: r.id,
                  label: `${r.role} · ${r.name}`,
                  hint: r.summary,
                }))}
                onPick={(id) => {
                  const preset = ROLE_PRESETS.find((r) => r.id === id)!;
                  setAnswers({
                    ...answers,
                    name: preset.name,
                    role: preset.role,
                    focus: preset.focus,
                    plugins: preset.plugins.filter((p) => installedIds.includes(p)),
                  });
                  setStage(deep ? "nome" : "done");
                }}
              />
            )}
          </Turn>
        )}

        {answers.role && stage !== "ruolo" && <Said text={answers.role} />}

        {stage === "nome" && (
          <Turn>
            <p className="text-sm leading-relaxed text-foreground">
              Come lo chiamiamo? Un nome proprio aiuta: lo tratterai come una persona del team.
            </p>
            <div className="flex flex-wrap gap-2">
              <Input
                className="max-w-xs"
                value={answers.name}
                onChange={(e) => setAnswers({ ...answers, name: e.target.value })}
              />
              <Button size="sm" onClick={() => setStage("compito")}>
                Avanti
              </Button>
            </div>
          </Turn>
        )}

        {stage === "compito" && (
          <Turn>
            <p className="text-sm leading-relaxed text-foreground">
              In una frase: qual è il suo compito principale?
            </p>
            <div className="space-y-2">
              <Textarea
                value={answers.focus}
                onChange={(e) => setAnswers({ ...answers, focus: e.target.value })}
                placeholder="rispondere alle richieste di preventivo entro la giornata"
              />
              <Button size="sm" onClick={() => setStage("tono")}>
                Avanti
              </Button>
            </div>
          </Turn>
        )}

        {stage === "tono" && (
          <Turn>
            <p className="text-sm leading-relaxed text-foreground">Con che tono deve scrivere?</p>
            <Options
              options={TONES.map((t) => ({ key: t.id, label: t.label, hint: t.hint }))}
              onPick={(tone) => {
                setAnswers({ ...answers, tone });
                setStage("limiti");
              }}
            />
          </Turn>
        )}

        {stage === "limiti" && (
          <Turn>
            <p className="text-sm leading-relaxed text-foreground">
              C'è qualcosa che non deve fare mai? Prezzi da non promettere, argomenti da girare a te…
            </p>
            <div className="space-y-2">
              <Textarea
                value={answers.limits}
                onChange={(e) => setAnswers({ ...answers, limits: e.target.value })}
                placeholder="non fare sconti e non prendere impegni sulle consegne"
              />
              <Button size="sm" onClick={() => setStage(usable.length ? "strumenti" : "done")}>
                Avanti
              </Button>
            </div>
          </Turn>
        )}

        {stage === "strumenti" && (
          <Turn>
            <p className="text-sm leading-relaxed text-foreground">
              Su quali strumenti può contare?
            </p>
            <div className="flex flex-wrap gap-2">
              {usable.map((p) => {
                const on = answers.plugins.includes(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() =>
                      setAnswers({
                        ...answers,
                        plugins: on
                          ? answers.plugins.filter((x) => x !== p.id)
                          : [...answers.plugins, p.id],
                      })
                    }
                    className={`rounded-xl border px-4 py-2.5 text-sm transition-colors ${
                      on
                        ? "border-primary bg-primary/15 text-foreground"
                        : "border-border bg-card text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {p.name}
                  </button>
                );
              })}
            </div>
            <Button size="sm" onClick={() => setStage("done")}>
              Ci siamo
            </Button>
          </Turn>
        )}

        {stage === "done" && (
          <Turn>
            <p className="text-sm leading-relaxed text-foreground">
              Ecco chi stai assumendo. Puoi ancora ritoccare tutto dopo, anche parlandoci.
            </p>
          </Turn>
        )}
      </div>

      {stage === "done" && (
        <>
          <article className="rounded-2xl border border-border bg-card p-6">
            <div className="flex items-center gap-4">
              <span className="flex size-12 items-center justify-center rounded-full bg-primary/15 text-base font-semibold text-accent">
                {(answers.name || "?").slice(0, 2).toUpperCase()}
              </span>
              <div>
                <h2 className="text-xl font-semibold text-foreground">
                  {answers.name || "Assistente"}
                </h2>
                <p className="text-sm text-muted-foreground">{answers.role}</p>
              </div>
            </div>
            <p className="mt-5 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
              {composeInstructions(answers)}
            </p>
            {answers.plugins.length > 0 && (
              <div className="mt-5 flex flex-wrap gap-2">
                {answers.plugins.map((id) => (
                  <span
                    key={id}
                    className="rounded-lg bg-secondary px-3 py-1.5 text-xs text-foreground"
                  >
                    {getPlugin(id)?.name}
                  </span>
                ))}
              </div>
            )}
          </article>
          <div className="flex flex-wrap gap-3">
            <Button size="lg" onClick={() => create.mutate()} disabled={create.isPending}>
              <Check /> Aggiungi alla squadra
            </Button>
            {!deep && (
              <Button
                size="lg"
                variant="secondary"
                onClick={() => {
                  setDeep(true);
                  setStage("nome");
                }}
              >
                Specializzalo meglio
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
