import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, MessageSquare, Plus, Settings2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useWorkspace } from "@/hooks/useWorkspace";
import { availableWidgets, getPlugin, CORE_WIDGETS, PLUGINS } from "@/lib/plugins";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

export const Route = createFileRoute("/app/")({
  head: () => ({
    meta: [
      { title: "Panoramica — Homun" },
      {
        name: "description",
        content: "La tua squadra di assistenti, cosa sta accadendo adesso e cosa richiede attenzione.",
      },
      { property: "og:title", content: "Panoramica — Homun" },
      { property: "og:description", content: "La tua squadra al lavoro, in tempo reale." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
});

function greeting() {
  const h = new Date().getHours();
  if (h < 6) return "Buonanotte";
  if (h < 13) return "Buongiorno";
  if (h < 19) return "Buon pomeriggio";
  return "Buonasera";
}

function initials(name: string) {
  return name
    .replace(/^Assistente (di )?/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function relative(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "adesso";
  if (m < 60) return `${m} min fa`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${h === 1 ? "ora" : "ore"} fa`;
  return new Date(iso).toLocaleDateString("it-IT", { day: "numeric", month: "long" });
}

type Bot = { id: string; name: string; subtitle: string | null; status: string | null };

function Dashboard() {
  const { activeProject, activeOrg } = useWorkspace();
  const { user } = useAuth();
  const projectId = activeProject?.id;
  const queryClient = useQueryClient();
  const [openBot, setOpenBot] = useState<Bot | null>(null);

  const { data } = useQuery({
    queryKey: ["dashboard", projectId],
    enabled: !!projectId && !!user,
    refetchInterval: 30000,
    queryFn: async () => {
      const [bots, pipelines, runs, installs, widgets, findings, conversations] = await Promise.all([
        supabase.from("bots").select("id,name,subtitle,status").eq("project_id", projectId!),
        supabase
          .from("pipelines")
          .select("id,name,active,last_run_at,trigger_plugin,trigger_key")
          .eq("project_id", projectId!),
        supabase
          .from("pipeline_runs")
          .select("id,status,started_at,trigger_summary,pipeline_id")
          .order("started_at", { ascending: false })
          .limit(12),
        supabase.from("plugin_installations").select("plugin_id,connected").eq("project_id", projectId!),
        supabase
          .from("dashboard_widgets")
          .select("widget_key,position")
          .eq("project_id", projectId!)
          .eq("user_id", user!.id)
          .order("position"),
        supabase
          .from("monitor_findings")
          .select("id,title,summary,detected_at")
          .eq("project_id", projectId!)
          .order("detected_at", { ascending: false })
          .limit(6),
        supabase
          .from("conversations")
          .select("id,title,bot_id,updated_at")
          .eq("project_id", projectId!)
          .order("updated_at", { ascending: false })
          .limit(20),
      ]);
      return {
        bots: (bots.data ?? []) as Bot[],
        pipelines: pipelines.data ?? [],
        runs: runs.data ?? [],
        installs: installs.data ?? [],
        widgets: (widgets.data ?? []).map((w) => w.widget_key),
        findings: findings.data ?? [],
        conversations: conversations.data ?? [],
      };
    },
  });

  const installedIds = (data?.installs ?? []).map((i) => i.plugin_id);
  const widgetOptions = availableWidgets(installedIds);
  const visible = data?.widgets ?? CORE_WIDGETS.map((w) => w.key);

  const toggleWidget = useMutation({
    mutationFn: async (key: string) => {
      if (!projectId || !user) return;
      if (visible.includes(key)) {
        await supabase
          .from("dashboard_widgets")
          .delete()
          .eq("project_id", projectId)
          .eq("user_id", user.id)
          .eq("widget_key", key);
      } else {
        await supabase.from("dashboard_widgets").insert({
          project_id: projectId,
          user_id: user.id,
          widget_key: key,
          position: visible.length,
        });
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dashboard", projectId] }),
  });

  const running = (data?.runs ?? []).filter((r) => r.status === "in_corso");
  const failed = (data?.runs ?? []).filter((r) => r.status === "errore");
  const paused = (data?.pipelines ?? []).filter((p) => !p.active);

  const attention = [
    ...failed.map((r) => ({
      id: `run-${r.id}`,
      title: r.trigger_summary ?? "Un'automazione si è fermata",
      detail: `Si è interrotta ${relative(r.started_at)}. Serve un tuo controllo.`,
      to: "/app/pipelines" as const,
      cta: "Vedi l'automazione",
    })),
    ...paused.slice(0, 3).map((p) => ({
      id: `paused-${p.id}`,
      title: `"${p.name}" è in pausa`,
      detail: "Non farà nulla finché non la attivi tu.",
      to: "/app/pipelines" as const,
      cta: "Attiva",
    })),
    ...(installedIds.length === 0
      ? [
          {
            id: "no-plugins",
            title: "I tuoi assistenti non hanno ancora strumenti",
            detail: "Collega email, calendario o monitoraggio siti per farli lavorare davvero.",
            to: "/app/plugins" as const,
            cta: "Collega uno strumento",
          },
        ]
      : []),
  ];

  const diary = useMemo(() => {
    const items = [
      ...(data?.runs ?? []).map((r) => ({
        id: `r-${r.id}`,
        at: r.started_at,
        text: r.trigger_summary ?? "Automazione eseguita",
        kind: r.status === "errore" ? ("bad" as const) : r.status === "in_corso" ? ("live" as const) : ("ok" as const),
        meta: r.status === "in_corso" ? "in corso" : r.status,
      })),
      ...(data?.findings ?? []).map((f) => ({
        id: `f-${f.id}`,
        at: f.detected_at,
        text: f.title,
        kind: "ok" as const,
        meta: "cambiamento rilevato",
      })),
      ...(data?.conversations ?? []).slice(0, 5).map((c) => ({
        id: `c-${c.id}`,
        at: c.updated_at,
        text: c.title ?? "Conversazione con un assistente",
        kind: "chat" as const,
        meta: "chat",
      })),
    ];
    return items
      .filter((i) => i.at)
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 10);
  }, [data]);

  const firstName = (user?.user_metadata?.["full_name"] as string | undefined)?.split(" ")[0];
  const busyBotIds = new Set(running.map(() => "").filter(Boolean));

  const extraWidgets = visible.filter((key) => !CORE_WIDGETS.some((c) => c.key === key));

  const calm = attention.length === 0;

  return (
    <div className="min-h-full">
      <div className="mx-auto max-w-6xl space-y-12 px-8 py-12">
        {/* Header: titolo grande + cosa richiede attenzione */}
        <header className="grid items-end gap-8 lg:grid-cols-12">
          <div className="min-w-0 lg:col-span-7">
            <p className="eyebrow flex items-center gap-2 text-accent">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-2 animate-ping rounded-full bg-accent/60" />
                <span className="relative inline-flex size-2 rounded-full bg-accent" />
              </span>
              {activeProject?.name ?? "Progetto"} · {activeOrg?.name ?? ""}
            </p>
            <h1 className="mt-4 text-5xl font-bold leading-[1.05] tracking-tight text-foreground md:text-6xl">
              {greeting()}
              {firstName ? "," : ""}
              <br />
              <span className="text-primary">{firstName ?? "la squadra è pronta"}</span>
            </h1>
            <p className="mt-5 max-w-lg text-sm leading-relaxed text-muted-foreground">
              {running.length
                ? `${running.length} ${running.length === 1 ? "automazione sta lavorando" : "automazioni stanno lavorando"} in questo momento.`
                : "Nessun lavoro in corso adesso: la tua squadra è in ascolto."}
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              <Button asChild>
                <Link to="/app/chat">
                  <MessageSquare /> Chiedi qualcosa
                </Link>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">
                    <Settings2 /> Cosa vedere
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64">
                  <DropdownMenuLabel>Cosa vedere in panoramica</DropdownMenuLabel>
                  {widgetOptions.map((w) => (
                    <DropdownMenuCheckboxItem
                      key={w.key}
                      checked={visible.includes(w.key)}
                      onCheckedChange={() => toggleWidget.mutate(w.key)}
                    >
                      {w.title}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <div className="flex flex-col gap-3 lg:col-span-5">
            {calm ? (
              <div className="rounded-r-xl border-l-4 border-primary bg-card p-6">
                <p className="eyebrow flex items-center gap-2 text-muted-foreground">
                  <span className="size-2 rounded-full bg-primary" /> Tutto sotto controllo
                </p>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  Niente richiede la tua attenzione. Appena qualcosa si ferma o serve una tua
                  decisione, comparirà qui.
                </p>
              </div>
            ) : (
              attention.slice(0, 2).map((a) => (
                <Link
                  key={a.id}
                  to={a.to}
                  className="group rounded-r-xl border-l-4 border-accent bg-card p-6 transition-colors hover:bg-secondary"
                >
                  <p className="eyebrow flex items-center gap-2 text-foreground">
                    <span className="size-2 animate-pulse rounded-full bg-accent" /> Richiede
                    attenzione
                  </p>
                  <p className="mt-3 text-sm font-semibold text-foreground">{a.title}</p>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{a.detail}</p>
                  <span className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-accent">
                    {a.cta}
                    <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </Link>
              ))
            )}
          </div>
        </header>

        {/* La tua squadra */}
        <section className="space-y-6">
          <div className="flex items-baseline justify-between border-b border-border pb-4">
            <h2 className="text-2xl font-semibold text-foreground">La tua squadra</h2>
            <span className="text-sm text-accent">
              {(data?.bots ?? []).length}{" "}
              {(data?.bots ?? []).length === 1 ? "collaboratore" : "collaboratori"}
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {(data?.bots ?? []).map((b) => {
              const busy = busyBotIds.has(b.id);
              const lastChat = (data?.conversations ?? []).find((c) => c.bot_id === b.id);
              return (
                <button
                  key={b.id}
                  onClick={() => setOpenBot(b)}
                  className="group rounded-xl border border-transparent bg-card p-6 text-left transition-all hover:border-primary hover:-translate-y-0.5"
                >
                  <span className="mb-4 flex size-10 items-center justify-center rounded-full bg-primary font-display text-sm font-bold text-accent">
                    {initials(b.name) || "AI"}
                  </span>
                  <h3 className="truncate text-lg font-bold text-foreground">{b.name}</h3>
                  <p className="mb-3 truncate text-xs uppercase tracking-tight text-accent">
                    {b.subtitle ?? "Assistente operativo"}
                  </p>
                  <span className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span
                      className={`size-1.5 rounded-full ${busy ? "animate-pulse bg-accent" : "bg-muted-foreground/50"}`}
                    />
                    {busy
                      ? "Sta lavorando"
                      : lastChat
                        ? `Con te ${relative(lastChat.updated_at)}`
                        : "Disponibile"}
                  </span>
                </button>
              );
            })}

            <Link
              to="/app/chat"
              className="flex flex-col justify-center rounded-xl border border-dashed border-border p-6 text-left transition-colors hover:border-primary"
            >
              <Plus className="mb-3 size-5 text-accent" />
              <span className="text-sm font-semibold text-foreground">Nuovo collaboratore</span>
              <span className="mt-1 text-xs text-muted-foreground">
                Dagli un nome e un ruolo, poi parlagli.
              </span>
            </Link>
          </div>
        </section>

        {/* Diario di bordo + automazioni */}
        <div className="grid gap-12 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <h2 className="border-b border-border pb-4 text-xl font-semibold text-foreground">
              Diario di bordo
            </h2>
            {diary.length ? (
              <ol className="relative space-y-8">
                <span className="absolute bottom-2 left-[7px] top-2 w-px bg-border" />
                {diary.map((d) => (
                  <li key={d.id} className="relative pl-8">
                    <span
                      className={`absolute left-0 top-1.5 size-[15px] rounded-full border-2 bg-background ${
                        d.kind === "bad"
                          ? "border-destructive"
                          : d.kind === "live"
                            ? "animate-pulse border-accent"
                            : d.kind === "chat"
                              ? "border-border"
                              : "border-primary"
                      }`}
                    />
                    <span className="eyebrow text-accent">{relative(d.at)}</span>
                    <p className="mt-1 text-sm leading-relaxed text-foreground/90">{d.text}</p>
                    <p className="text-xs text-muted-foreground">{d.meta}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
                <p className="text-sm font-semibold text-foreground">Il diario è ancora bianco</p>
                <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
                  Appena la tua squadra inizia a lavorare, qui vedrai ogni cosa fatta, in ordine di
                  tempo.
                </p>
              </div>
            )}
          </div>

          <div className="space-y-6">
            <h2 className="flex items-center justify-between border-b border-border pb-4 text-xl font-semibold text-foreground">
              Automazioni
              <Button asChild size="icon" variant="ghost" aria-label="Nuova automazione">
                <Link to="/app/pipelines">
                  <Plus />
                </Link>
              </Button>
            </h2>
            <div className="space-y-3">
              {(data?.pipelines ?? []).slice(0, 5).map((p) => (
                <Link
                  key={p.id}
                  to="/app/pipelines"
                  className={`flex items-center justify-between rounded-lg bg-card p-4 transition-colors hover:bg-secondary ${p.active ? "" : "opacity-60"}`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {p.name}
                    </span>
                    <span
                      className={`block text-[10px] ${p.active ? "text-accent" : "text-muted-foreground"}`}
                    >
                      {p.last_run_at
                        ? `Ultima volta ${relative(p.last_run_at)}`
                        : p.active
                          ? "In ascolto"
                          : "In pausa"}
                    </span>
                  </span>
                  <span
                    className={`relative h-4 w-8 shrink-0 rounded-full ${p.active ? "bg-primary" : "bg-muted"}`}
                  >
                    <span
                      className={`absolute top-1 size-2 rounded-full ${p.active ? "right-1 bg-accent" : "left-1 bg-muted-foreground/60"}`}
                    />
                  </span>
                </Link>
              ))}
              {!data?.pipelines.length && (
                <div className="rounded-lg border border-dashed border-border p-5">
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Nessuna automazione: dì cosa deve accadere e chi la esegue.
                  </p>
                  <Button asChild variant="outline" size="sm" className="mt-4 w-full">
                    <Link to="/app/pipelines">Crea la prima automazione</Link>
                  </Button>
                </div>
              )}
            </div>

            {extraWidgets.map((key) => {
              const owner = widgetOptions.find((w) => w.key === key);
              if (!owner) return null;
              const plugin = owner.pluginId ? getPlugin(owner.pluginId) : undefined;
              return (
                <div key={key} className="rounded-lg bg-card p-5">
                  <h3 className="text-sm font-semibold text-foreground">{owner.title}</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">{plugin?.name}</p>
                  {key === "cambiamenti_recenti" ? (
                    <ul className="mt-4 space-y-3">
                      {(data?.findings ?? []).map((f) => (
                        <li key={f.id}>
                          <p className="text-sm font-medium text-foreground">{f.title}</p>
                          {f.summary && (
                            <p className="mt-0.5 text-xs text-muted-foreground">{f.summary}</p>
                          )}
                        </li>
                      ))}
                      {!data?.findings.length && (
                        <li className="text-xs text-muted-foreground">
                          Nessun cambiamento rilevato.
                        </li>
                      )}
                    </ul>
                  ) : (
                    <p className="mt-3 text-xs text-muted-foreground">
                      Si popola appena lo strumento raccoglie dati.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <BotSheet
        bot={openBot}
        onClose={() => setOpenBot(null)}
        installedIds={installedIds}
        conversations={data?.conversations ?? []}
      />
    </div>
  );
}

function BotSheet({
  bot,
  onClose,
  installedIds,
  conversations,
}: {
  bot: Bot | null;
  onClose: () => void;
  installedIds: string[];
  conversations: { id: string; title: string | null; bot_id: string | null; updated_at: string }[];
}) {
  const skills = PLUGINS.filter((p) => installedIds.includes(p.id));
  const mine = conversations.filter((c) => c.bot_id === bot?.id).slice(0, 6);

  return (
    <Sheet open={!!bot} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-md">
        {bot && (
          <>
            <SheetHeader>
              <div className="flex items-center gap-3">
                <span className="flex size-12 items-center justify-center rounded-2xl bg-primary text-sm font-bold text-primary-foreground">
                  {initials(bot.name) || "AI"}
                </span>
                <div className="min-w-0">
                  <SheetTitle className="truncate text-left">{bot.name}</SheetTitle>
                  <SheetDescription className="text-left">
                    {bot.subtitle ?? "Assistente operativo"}
                  </SheetDescription>
                </div>
              </div>
            </SheetHeader>

            <div className="space-y-6 overflow-y-auto px-4 pb-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  In questo momento
                </p>
                <p className="mt-2 flex items-center gap-2 text-sm text-foreground">
                  <span className="size-1.5 rounded-full bg-muted-foreground/40" />
                  In attesa di istruzioni
                </p>
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Cosa sa fare
                </p>
                {skills.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {skills.map((s) => (
                      <Badge key={s.id} variant="secondary">
                        {s.name}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">
                    Ancora nessuno strumento collegato: può ragionare e scrivere, ma non agire fuori
                    da qui.
                  </p>
                )}
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Ultimi lavori con te
                </p>
                <ul className="mt-2 space-y-2">
                  {mine.map((c) => (
                    <li key={c.id}>
                      <Link
                        to="/app/chat/$conversationId"
                        params={{ conversationId: c.id }}
                        onClick={onClose}
                        className="block rounded-xl border border-border bg-background px-4 py-3 transition-colors hover:border-primary/40"
                      >
                        <span className="block truncate text-sm text-foreground">
                          {c.title ?? "Conversazione"}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {relative(c.updated_at)}
                        </span>
                      </Link>
                    </li>
                  ))}
                  {!mine.length && (
                    <li className="text-sm text-muted-foreground">
                      Non avete ancora lavorato insieme.
                    </li>
                  )}
                </ul>
              </div>

              <Button asChild className="w-full">
                <Link to="/app/chat" onClick={onClose}>
                  <MessageSquare /> Parla con {bot.name.split(" ")[0]}
                </Link>
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
