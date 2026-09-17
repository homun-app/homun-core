import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Eye, FileText, LineChart, Mail, Sparkle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useConversations, useCreateConversation } from "./app.chat";
import { HomunMark } from "@/components/brand/Wordmark";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/app/chat/")({
  component: ChatIndex,
});

const STARTERS = [
  {
    icon: LineChart,
    plugin: "concorrenti",
    title: "Guarda i concorrenti",
    prompt: "Fammi il punto sui miei concorrenti: cosa è cambiato di recente?",
  },
  {
    icon: Eye,
    plugin: "monitoraggio",
    title: "Tieni d'occhio una pagina",
    prompt:
      "Controlla questa pagina e avvisami quando cambia qualcosa di importante: https://",
  },
  {
    icon: FileText,
    plugin: "fatture",
    title: "Sollecita una fattura",
    prompt: "Prepara un sollecito gentile per una fattura scaduta da dieci giorni.",
  },
  {
    icon: Mail,
    plugin: "email",
    title: "Rispondi a un messaggio",
    prompt: "Aiutami a rispondere a un cliente che chiede un preventivo.",
  },
];

function ChatIndex() {
  const navigate = useNavigate();
  const { activeProject, canWrite } = useWorkspace();
  const { data, isLoading } = useConversations();
  const create = useCreateConversation();

  const { data: installs } = useQuery({
    queryKey: ["plugin-installations", activeProject?.id],
    enabled: !!activeProject,
    queryFn: async () => {
      const { data: rows } = await supabase
        .from("plugin_installations")
        .select("plugin_id,connected")
        .eq("project_id", activeProject!.id);
      return rows ?? [];
    },
  });

  useEffect(() => {
    const first = data?.[0];
    if (first) {
      void navigate({
        to: "/app/chat/$conversationId",
        params: { conversationId: first.id },
        replace: true,
      });
    }
  }, [data, navigate]);

  if (isLoading || data?.length) return null;

  const installedIds = (installs ?? []).map((i) => i.plugin_id);

  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-2xl">
        <div className="flex flex-col items-center text-center">
          <span className="inline-flex size-14 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/15">
            <HomunMark className="size-8" />
          </span>
          <h1 className="mt-5 text-3xl font-bold tracking-tight text-foreground">
            Ciao, di cosa hai bisogno?
          </h1>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            Scrivi come parleresti a un collega. Il tuo assistente usa le funzioni installate nel
            progetto «{activeProject?.name}» e ti dice sempre cosa ha fatto.
          </p>
        </div>

        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          {STARTERS.map((s) => {
            const ready = installedIds.includes(s.plugin);
            return (
              <button
                key={s.title}
                type="button"
                disabled={!canWrite || create.isPending}
                onClick={() => create.mutate(s.prompt)}
                className="group rounded-2xl border border-border bg-card p-4 text-left transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md disabled:opacity-60"
              >
                <div className="flex items-center justify-between">
                  <span className="inline-flex size-9 items-center justify-center rounded-xl bg-secondary text-primary">
                    <s.icon className="size-4" />
                  </span>
                  <ArrowUpRight className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </div>
                <p className="mt-3 text-sm font-semibold text-foreground">{s.title}</p>
                <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                  {s.prompt.replace("https://", "")}
                </p>
                {!ready && (
                  <p className="mt-2 text-[11px] font-medium text-muted-foreground/80">
                    Funzione non ancora installata
                  </p>
                )}
              </button>
            );
          })}
        </div>

        <div className="mt-8 flex flex-col items-center gap-3">
          <Button
            size="lg"
            onClick={() => create.mutate(undefined)}
            disabled={!canWrite || create.isPending}
          >
            <Sparkle /> Inizia da zero
          </Button>
          <p className="text-xs text-muted-foreground">
            Ogni conversazione resta dentro questo progetto, visibile solo a chi vi lavora.
          </p>
        </div>
      </div>
    </div>
  );
}
