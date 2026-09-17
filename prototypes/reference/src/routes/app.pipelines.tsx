import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ArrowRight, Pause, Play, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useWorkspace } from "@/hooks/useWorkspace";
import { PLUGINS, getPlugin, type FieldDef } from "@/lib/plugins";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/app/pipelines")({
  head: () => ({
    meta: [
      { title: "Automazioni — Homun" },
      { name: "description", content: "Quando succede questo, fai quello. Senza codice." },
      { property: "og:title", content: "Automazioni — Homun" },
      { property: "og:description", content: "Crea automazioni in due passaggi, come IFTTT." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: PipelinesPage,
});

type StepDraft = { pluginId: string; actionKey: string; config: Record<string, string> };

function relative(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "adesso";
  if (m < 60) return `${m} min fa`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${h === 1 ? "ora" : "ore"} fa`;
  return new Date(iso).toLocaleDateString("it-IT", { day: "numeric", month: "long" });
}

function PipelinesPage() {
  const { activeProject, canWrite } = useWorkspace();
  const projectId = activeProject?.id;
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

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

  const { data: pipelines } = useQuery({
    queryKey: ["pipelines", projectId],
    enabled: !!projectId,
    refetchInterval: 30000,
    queryFn: async () => {
      const { data: rows } = await supabase
        .from("pipelines")
        .select("id,name,description,active,trigger_plugin,trigger_key,last_run_at")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false });
      const ids = (rows ?? []).map((r) => r.id);
      const { data: steps } = ids.length
        ? await supabase
            .from("pipeline_steps")
            .select("id,pipeline_id,plugin_id,action_key,position,label")
            .in("pipeline_id", ids)
            .order("position")
        : { data: [] };
      return (rows ?? []).map((r) => ({
        ...r,
        steps: (steps ?? []).filter((s) => s.pipeline_id === r.id),
      }));
    },
  });

  const toggleActive = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const { error } = await supabase.from("pipelines").update({ active }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["pipelines", projectId] }),
    onError: () => toast.error("Non è stato possibile cambiare lo stato"),
  });

  const removePipeline = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("pipelines").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Automazione eliminata");
      void queryClient.invalidateQueries({ queryKey: ["pipelines", projectId] });
    },
    onError: () => toast.error("Eliminazione non riuscita"),
  });

  const installedIds = (installs ?? []).map((i) => i.plugin_id);
  const activeCount = (pipelines ?? []).filter((p) => p.active).length;

  return (
    <div className="min-h-full">
      <div className="mx-auto max-w-5xl space-y-10 px-8 py-12">
        <header className="grid items-end gap-6 md:grid-cols-12">
          <div className="md:col-span-8">
            <p className="eyebrow text-accent">Le regole della casa</p>
            <h1 className="mt-3 text-4xl font-bold leading-[1.05] tracking-tight text-foreground md:text-5xl">
              Quando succede questo,
              <br />
              <span className="text-primary">fai quello.</span>
            </h1>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
              {pipelines?.length
                ? `${activeCount} ${activeCount === 1 ? "automazione in ascolto" : "automazioni in ascolto"} su ${pipelines.length}. Ognuna si legge come una frase, senza codice.`
                : "Scrivi una regola in italiano semplice: Homun la fa rispettare, sempre."}
            </p>
          </div>
          <div className="flex md:col-span-4 md:justify-end">
            <Button asChild disabled={!canWrite} size="lg">
              <Link to="/app/create">
                <Plus /> Nuova automazione
              </Link>
            </Button>
          </div>
        </header>

        {!installedIds.length && (
          <div className="rounded-r-xl border-l-4 border-accent bg-card p-6">
            <p className="text-sm font-semibold text-foreground">
              Non c'è ancora niente da automatizzare
            </p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Le automazioni partono dagli strumenti che colleghi: email, fatture, monitoraggio
              siti. Installane almeno uno dalla pagina Plugin, poi torna qui.
            </p>
          </div>
        )}

        <div className="space-y-4">
          {(pipelines ?? []).map((p) => {
            const triggerPlugin = p.trigger_plugin ? getPlugin(p.trigger_plugin) : undefined;
            const trigger = triggerPlugin?.triggers.find((t) => t.key === p.trigger_key);
            return (
              <article
                key={p.id}
                className={`group rounded-xl bg-card p-6 transition-colors hover:bg-secondary/60 ${p.active ? "" : "opacity-70"}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h2 className="flex items-center gap-2.5 text-lg font-semibold text-foreground">
                      <span
                        className={`size-2 shrink-0 rounded-full ${p.active ? "animate-pulse bg-accent" : "bg-muted-foreground/50"}`}
                      />
                      {p.name}
                    </h2>
                    {p.description && (
                      <p className="mt-1 text-sm text-muted-foreground">{p.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={`eyebrow ${p.active ? "text-accent" : "text-muted-foreground"}`}
                    >
                      {p.active ? "In ascolto" : "In pausa"}
                    </span>
                    <Switch
                      checked={p.active}
                      disabled={!canWrite}
                      onCheckedChange={(active) => toggleActive.mutate({ id: p.id, active })}
                      aria-label="Attiva o metti in pausa"
                    />
                    <button
                      type="button"
                      aria-label="Elimina automazione"
                      onClick={() => removePipeline.mutate(p.id)}
                      disabled={!canWrite}
                      className="rounded-md p-1.5 opacity-0 transition-opacity hover:bg-background group-hover:opacity-100"
                    >
                      <Trash2 className="size-4 text-muted-foreground hover:text-destructive" />
                    </button>
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
                  <span className="inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-3 py-1.5 font-medium text-accent">
                    <Play className="size-3" />
                    {trigger?.label ?? "Quando indicato"}
                  </span>
                  {p.steps.map((s) => {
                    const plugin = getPlugin(s.plugin_id);
                    const action = plugin?.actions.find((a) => a.key === s.action_key);
                    return (
                      <span key={s.id} className="flex items-center gap-2">
                        <ArrowRight className="size-4 text-muted-foreground/60" />
                        <span className="rounded-lg bg-background px-3 py-1.5 text-foreground/90">
                          {action?.label ?? s.label ?? s.action_key}
                        </span>
                      </span>
                    );
                  })}
                </div>

                <p className="mt-4 text-xs text-muted-foreground">
                  {p.active ? (
                    p.last_run_at ? (
                      <>Ultima esecuzione {relative(p.last_run_at)}</>
                    ) : (
                      "In ascolto: partirà appena succede qualcosa"
                    )
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      <Pause className="size-3" /> Ferma finché non la riattivi
                    </span>
                  )}
                </p>
              </article>
            );
          })}

          {pipelines && pipelines.length === 0 && installedIds.length > 0 && (
            <button
              type="button"
              onClick={() => canWrite && navigate({ to: "/app/create" })}
              className="w-full rounded-xl border border-dashed border-border p-10 text-center transition-colors hover:border-primary"
            >
              <Play className="mx-auto size-5 text-accent" />
              <p className="mt-3 text-sm font-semibold text-foreground">
                Crea la tua prima automazione
              </p>
              <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                Per esempio: «quando una fattura è scaduta da 7 giorni → invia un sollecito».
              </p>
            </button>
          )}
        </div>
      </div>

      <PipelineDialog
        open={creating}
        onOpenChange={setCreating}
        installedIds={installedIds}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ["pipelines", projectId] })}
      />
    </div>
  );
}

function FieldInputs({
  fields,
  values,
  onChange,
}: {
  fields: FieldDef[];
  values: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  if (!fields.length) return null;
  return (
    <div className="space-y-3 rounded-xl border border-border bg-background p-3">
      {fields.map((f) => (
        <div key={f.key} className="space-y-1.5">
          <Label htmlFor={f.key} className="text-xs">
            {f.label}
          </Label>
          <Input
            id={f.key}
            placeholder={f.placeholder ?? ""}
            value={values[f.key] ?? ""}
            onChange={(e) => onChange({ ...values, [f.key]: e.target.value })}
          />
        </div>
      ))}
    </div>
  );
}

function PipelineDialog({
  open,
  onOpenChange,
  installedIds,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  installedIds: string[];
  onCreated: () => void;
}) {
  const { activeProject } = useWorkspace();
  const { user } = useAuth();
  const available = useMemo(() => PLUGINS.filter((p) => installedIds.includes(p.id)), [installedIds]);

  const [name, setName] = useState("");
  const [triggerPluginId, setTriggerPluginId] = useState("");
  const [triggerKey, setTriggerKey] = useState("");
  const [triggerConfig, setTriggerConfig] = useState<Record<string, string>>({});
  const [steps, setSteps] = useState<StepDraft[]>([]);

  const triggerPlugin = getPlugin(triggerPluginId);
  const trigger = triggerPlugin?.triggers.find((t) => t.key === triggerKey);

  const create = useMutation({
    mutationFn: async () => {
      if (!activeProject || !user) throw new Error("Progetto non disponibile");
      const { data, error } = await supabase
        .from("pipelines")
        .insert({
          project_id: activeProject.id,
          created_by: user.id,
          name,
          trigger_plugin: triggerPluginId,
          trigger_key: triggerKey,
          trigger_config: triggerConfig,
          active: false,
        })
        .select("id")
        .single();
      if (error) throw error;
      if (steps.length) {
        const { error: stepError } = await supabase.from("pipeline_steps").insert(
          steps.map((s, i) => ({
            pipeline_id: data.id,
            plugin_id: s.pluginId,
            action_key: s.actionKey,
            config: s.config,
            position: i,
            label: getPlugin(s.pluginId)?.actions.find((a) => a.key === s.actionKey)?.label ?? null,
          }))
        );
        if (stepError) throw stepError;
      }
    },
    onSuccess: () => {
      toast.success("Automazione creata", {
        description: "È in pausa: attivala quando vuoi farla partire.",
      });
      setName("");
      setTriggerPluginId("");
      setTriggerKey("");
      setTriggerConfig({});
      setSteps([]);
      onOpenChange(false);
      onCreated();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Non riuscito"),
  });

  const ready = name.trim() && triggerPluginId && triggerKey && steps.every((s) => s.actionKey);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Nuova automazione</DialogTitle>
          <DialogDescription>
            Scegli quando deve partire e cosa deve fare. Puoi aggiungere più azioni in fila.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="pipeline-name">Come la chiami</Label>
            <Input
              id="pipeline-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Solleciti automatici"
            />
          </div>

          <div className="space-y-2">
            <Label>Quando succede questo</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              <Select
                value={triggerPluginId}
                onValueChange={(v) => {
                  setTriggerPluginId(v);
                  setTriggerKey("");
                  setTriggerConfig({});
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Funzione" />
                </SelectTrigger>
                <SelectContent>
                  {available.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={triggerKey} onValueChange={setTriggerKey} disabled={!triggerPlugin}>
                <SelectTrigger>
                  <SelectValue placeholder="Evento" />
                </SelectTrigger>
                <SelectContent>
                  {(triggerPlugin?.triggers ?? []).map((t) => (
                    <SelectItem key={t.key} value={t.key}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <FieldInputs
              fields={trigger?.fields ?? []}
              values={triggerConfig}
              onChange={setTriggerConfig}
            />
          </div>

          <div className="space-y-3">
            <Label>Allora fai questo</Label>
            {steps.map((step, index) => {
              const plugin = getPlugin(step.pluginId);
              const action = plugin?.actions.find((a) => a.key === step.actionKey);
              return (
                <div key={index} className="space-y-2 rounded-xl border border-border p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">
                      Passo {index + 1}
                    </span>
                    <button
                      type="button"
                      aria-label="Rimuovi passo"
                      onClick={() => setSteps(steps.filter((_, i) => i !== index))}
                    >
                      <Trash2 className="size-4 text-muted-foreground hover:text-destructive" />
                    </button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Select
                      value={step.pluginId}
                      onValueChange={(v) =>
                        setSteps(
                          steps.map((s, i) =>
                            i === index ? { pluginId: v, actionKey: "", config: {} } : s
                          )
                        )
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Funzione" />
                      </SelectTrigger>
                      <SelectContent>
                        {available.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={step.actionKey}
                      onValueChange={(v) =>
                        setSteps(steps.map((s, i) => (i === index ? { ...s, actionKey: v } : s)))
                      }
                      disabled={!plugin}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Azione" />
                      </SelectTrigger>
                      <SelectContent>
                        {(plugin?.actions ?? []).map((a) => (
                          <SelectItem key={a.key} value={a.key}>
                            {a.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <FieldInputs
                    fields={action?.fields ?? []}
                    values={step.config}
                    onChange={(config) =>
                      setSteps(steps.map((s, i) => (i === index ? { ...s, config } : s)))
                    }
                  />
                </div>
              );
            })}
            <Button
              variant="outline"
              className="w-full"
              disabled={!available.length}
              onClick={() => setSteps([...steps, { pluginId: "", actionKey: "", config: {} }])}
            >
              <Plus /> Aggiungi azione
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => create.mutate()} disabled={!ready || create.isPending}>
            Crea automazione
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
