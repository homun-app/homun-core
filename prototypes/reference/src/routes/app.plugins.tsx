import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import * as Icons from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useWorkspace } from "@/hooks/useWorkspace";
import { PLUGINS, type Plugin } from "@/lib/plugins";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/app/plugins")({
  head: () => ({
    meta: [
      { title: "Plugin — Homun" },
      { name: "description", content: "Aggiungi solo le funzioni che servono alla tua azienda." },
      { property: "og:title", content: "Plugin — Homun" },
      { property: "og:description", content: "Email, calendario, fatture, monitoraggio e concorrenti." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: PluginsPage,
});

function LucideIcon({ name, className }: { name: string; className?: string }) {
  const Cmp = (Icons as unknown as Record<string, Icons.LucideIcon>)[name] ?? Icons.Puzzle;
  return <Cmp className={className} />;
}

function PluginsPage() {
  const { activeProject, canManage } = useWorkspace();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const projectId = activeProject?.id;
  const [configuring, setConfiguring] = useState<Plugin | null>(null);

  const { data: installs } = useQuery({
    queryKey: ["plugin-installations", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("plugin_installations")
        .select("id,plugin_id,connected,settings")
        .eq("project_id", projectId!);
      if (error) throw error;
      return data;
    },
  });

  const install = useMutation({
    mutationFn: async (plugin: Plugin) => {
      if (!projectId || !user) throw new Error("Progetto non disponibile");
      const existing = installs?.find((i) => i.plugin_id === plugin.id);
      if (existing) {
        const { error } = await supabase.from("plugin_installations").delete().eq("id", existing.id);
        if (error) throw error;
        return "rimosso" as const;
      }
      const { error } = await supabase.from("plugin_installations").insert({
        project_id: projectId,
        plugin_id: plugin.id,
        installed_by: user.id,
        connected: !plugin.needsConnection,
      });
      if (error) throw error;
      return "installato" as const;
    },
    onSuccess: (result) => {
      toast.success(result === "installato" ? "Plugin installato" : "Plugin rimosso");
      void queryClient.invalidateQueries({ queryKey: ["plugin-installations", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard", projectId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Non riuscito"),
  });

  const installedPlugins = PLUGINS.filter((p) => installs?.some((i) => i.plugin_id === p.id));
  const catalogue = PLUGINS.filter((p) => !installs?.some((i) => i.plugin_id === p.id));
  const catalogueCategories = Array.from(new Set(catalogue.map((p) => p.category)));

  return (
    <div className="min-h-full">
      <div className="mx-auto max-w-6xl space-y-12 px-8 py-12">
        <header className="max-w-2xl">
          <p className="eyebrow text-accent">La cassetta degli attrezzi</p>
          <h1 className="mt-3 text-4xl font-bold leading-[1.05] tracking-tight text-foreground md:text-5xl">
            Aggiungi solo
            <br />
            <span className="text-primary">ciò che ti serve.</span>
          </h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
            Homun parte con la chat e le automazioni. Ogni altra funzione è un attrezzo che dai in
            mano ai tuoi collaboratori digitali: lo installi qui, loro imparano a usarlo.
          </p>
        </header>

        {/* Strumenti installati */}
        <section className="space-y-6">
          <div className="flex items-baseline justify-between border-b border-border pb-4">
            <h2 className="text-2xl font-semibold text-foreground">I tuoi strumenti</h2>
            <span className="text-sm text-accent">
              {installedPlugins.length}{" "}
              {installedPlugins.length === 1 ? "attrezzo" : "attrezzi"}
            </span>
          </div>

          {installedPlugins.length ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {installedPlugins.map((plugin) => {
                const installed = installs?.find((i) => i.plugin_id === plugin.id);
                return (
                  <article
                    key={plugin.id}
                    className="group rounded-xl border border-transparent bg-card p-6 transition-all hover:border-primary hover:-translate-y-0.5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="inline-flex size-10 items-center justify-center rounded-xl bg-primary/15 text-accent">
                        <LucideIcon name={plugin.icon} className="size-5" />
                      </span>
                      <span
                        className={`flex items-center gap-1.5 text-xs ${installed?.connected ? "text-accent" : "text-muted-foreground"}`}
                      >
                        <span
                          className={`size-1.5 rounded-full ${installed?.connected ? "bg-accent" : "bg-muted-foreground/60"}`}
                        />
                        {installed?.connected ? "Pronto" : "Da collegare"}
                      </span>
                    </div>
                    <h3 className="mt-4 text-lg font-bold text-foreground">{plugin.name}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                      {plugin.tagline}
                    </p>
                    <div className="mt-5 flex gap-2">
                      {(plugin.connectionFields?.length ?? 0) > 0 && (
                        <Button
                          variant="default"
                          className="flex-1"
                          onClick={() => setConfiguring(plugin)}
                        >
                          <Icons.Settings2 />
                          {installed?.connected ? "Impostazioni" : "Collega"}
                        </Button>
                      )}
                      <Button
                        variant={plugin.connectionFields?.length ? "ghost" : "outline"}
                        className={plugin.connectionFields?.length ? "" : "flex-1"}
                        disabled={!canManage || install.isPending}
                        onClick={() => install.mutate(plugin)}
                      >
                        Rimuovi
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
              <p className="text-sm font-semibold text-foreground">Nessuno strumento ancora</p>
              <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                Scegli dal catalogo qui sotto: ogni installazione rende i tuoi assistenti più capaci.
              </p>
            </div>
          )}
        </section>

        {/* Catalogo */}
        {catalogue.length > 0 && (
          <section className="space-y-10">
            <h2 className="border-b border-border pb-4 text-2xl font-semibold text-foreground">
              Catalogo
            </h2>
            {catalogueCategories.map((category) => (
              <div key={category}>
                <h3 className="eyebrow text-muted-foreground">{category}</h3>
                <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {catalogue
                    .filter((p) => p.category === category)
                    .map((plugin) => (
                      <article
                        key={plugin.id}
                        className="flex flex-col rounded-xl border border-dashed border-border p-6 transition-colors hover:border-primary"
                      >
                        <span className="inline-flex size-10 items-center justify-center rounded-xl bg-card text-muted-foreground">
                          <LucideIcon name={plugin.icon} className="size-5" />
                        </span>
                        <h4 className="mt-4 text-base font-semibold text-foreground">
                          {plugin.name}
                        </h4>
                        <p className="mt-1 text-sm text-muted-foreground">{plugin.tagline}</p>
                        <p className="mt-3 text-xs leading-relaxed text-muted-foreground/90">
                          {plugin.description}
                        </p>
                        <div className="mt-4 flex flex-wrap gap-1.5">
                          {plugin.triggers.slice(0, 2).map((t) => (
                            <span
                              key={t.key}
                              className="rounded-full bg-card px-2.5 py-1 text-xs text-muted-foreground"
                            >
                              {t.label}
                            </span>
                          ))}
                        </div>
                        <Button
                          className="mt-5"
                          disabled={!canManage || install.isPending}
                          onClick={() => install.mutate(plugin)}
                        >
                          <Icons.Plus /> Installa
                        </Button>
                      </article>
                    ))}
                </div>
              </div>
            ))}
          </section>
        )}
      </div>

      <PluginSettingsDialog
        plugin={configuring}
        onClose={() => setConfiguring(null)}
        installation={installs?.find((i) => i.plugin_id === configuring?.id) ?? null}
        onSaved={() => {
          void queryClient.invalidateQueries({ queryKey: ["plugin-installations", projectId] });
        }}
      />
    </div>
  );
}

function PluginSettingsDialog({
  plugin,
  installation,
  onClose,
  onSaved,
}: {
  plugin: Plugin | null;
  installation: { id: string; connected: boolean; settings: unknown } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial = (installation?.settings ?? {}) as Record<string, string>;
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [connected, setConnected] = useState(installation?.connected ?? false);

  const save = useMutation({
    mutationFn: async () => {
      if (!installation) return;
      const { error } = await supabase
        .from("plugin_installations")
        .update({ settings: values, connected })
        .eq("id", installation.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Impostazioni salvate");
      onSaved();
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Non riuscito"),
  });

  return (
    <Dialog
      open={!!plugin}
      onOpenChange={(open) => {
        if (!open) onClose();
        else {
          setValues((installation?.settings ?? {}) as Record<string, string>);
          setConnected(installation?.connected ?? false);
        }
      }}
    >
      <DialogContent>
        {plugin && (
          <>
            <DialogHeader>
              <DialogTitle>{plugin.name}</DialogTitle>
              <DialogDescription>{plugin.tagline}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              {(plugin.connectionFields ?? []).map((field) => (
                <div key={field.key} className="space-y-2">
                  <Label htmlFor={field.key}>{field.label}</Label>
                  <Input
                    id={field.key}
                    type={field.type === "email" ? "email" : field.type === "number" ? "number" : field.type === "url" ? "url" : "text"}
                    value={values[field.key] ?? ""}
                    placeholder={field.placeholder ?? ""}
                    onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                  />
                </div>
              ))}
              {plugin.needsConnection && (
                <div className="flex items-center justify-between rounded-xl border border-border p-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">Collegamento attivo</p>
                    <p className="text-xs text-muted-foreground">
                      Finché è spento, il bot avvisa che questa funzione non è pronta.
                    </p>
                  </div>
                  <Switch checked={connected} onCheckedChange={setConnected} />
                </div>
              )}
            </div>
            <DialogFooter>
              <Button onClick={() => save.mutate()} disabled={save.isPending}>
                Salva
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
