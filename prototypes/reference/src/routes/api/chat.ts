import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { convertToModelMessages, streamText, tool, type UIMessage } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider, HOMUN_MODEL } from "@/lib/ai-gateway.server";
import { PLUGINS } from "@/lib/plugins";

type Body = {
  messages?: UIMessage[];
  projectId?: string;
  conversationId?: string;
};

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
        if (!token) return jsonError("Devi accedere per usare la chat.", 401);

        const body = (await request.json()) as Body;
        const { messages, projectId, conversationId } = body;
        if (!Array.isArray(messages) || !projectId) {
          return jsonError("Richiesta incompleta.", 400);
        }

        const apiKey = process.env["LOVABLE_API_KEY"];
        if (!apiKey) return jsonError("Il servizio AI non è configurato.", 500);

        const supabase = createClient(
          process.env["SUPABASE_URL"] ?? import.meta.env["VITE_SUPABASE_URL"]!,
          import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"]!,
          {
            auth: { persistSession: false, autoRefreshToken: false },
            global: { headers: { Authorization: `Bearer ${token}` } },
          }
        );

        // Il progetto è leggibile solo se l'utente ne fa parte (regole del database).
        const { data: project } = await supabase
          .from("projects")
          .select("id,name,description")
          .eq("id", projectId)
          .maybeSingle();
        if (!project) return jsonError("Progetto non disponibile.", 403);

        const { data: installs } = await supabase
          .from("plugin_installations")
          .select("plugin_id,connected,settings")
          .eq("project_id", projectId);
        const installed = installs ?? [];
        const installedIds = installed.map((i) => i.plugin_id);
        const activePlugins = PLUGINS.filter((p) => installedIds.includes(p.id));

        const { data: bot } = await supabase
          .from("bots")
          .select("name,instructions")
          .eq("project_id", projectId)
          .limit(1)
          .maybeSingle();

        const connectionState = (pluginId: string) =>
          installed.find((i) => i.plugin_id === pluginId)?.connected ?? false;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tools: Record<string, any> = {};

        if (installedIds.includes("concorrenti")) {
          tools["elenca_concorrenti"] = tool({
            description: "Elenca i concorrenti seguiti in questo progetto.",
            inputSchema: z.object({}),
            execute: async () => {
              const { data } = await supabase
                .from("competitors")
                .select("name,url,notes,last_checked_at")
                .eq("project_id", projectId)
                .order("created_at");
              return { concorrenti: data ?? [] };
            },
          });
          tools["aggiungi_concorrente"] = tool({
            description: "Inizia a seguire un nuovo concorrente indicando nome e sito.",
            inputSchema: z.object({
              nome: z.string().describe("Nome del concorrente"),
              sito: z.string().describe("Indirizzo del sito, con https://"),
              note: z.string().optional(),
            }),
            execute: async ({ nome, sito, note }) => {
              const { data: userRes } = await supabase.auth.getUser();
              const { error } = await supabase.from("competitors").insert({
                project_id: projectId,
                name: nome,
                url: sito,
                notes: note ?? null,
                created_by: userRes.user?.id as string,
              });
              if (error) return { esito: "errore", messaggio: error.message };
              return { esito: "aggiunto", nome, sito };
            },
          });
        }

        if (installedIds.includes("monitoraggio") || installedIds.includes("concorrenti")) {
          tools["leggi_pagina"] = tool({
            description:
              "Legge il contenuto testuale di una pagina web pubblica, per capire cosa offre o cosa è cambiato.",
            inputSchema: z.object({ url: z.string().describe("Indirizzo completo della pagina") }),
            execute: async ({ url }) => {
              try {
                const res = await fetch(url, { headers: { "user-agent": "HomunBot/1.0" } });
                if (!res.ok) return { esito: "errore", messaggio: `La pagina ha risposto ${res.status}` };
                const html = await res.text();
                const text = html
                  .replace(/<script[\s\S]*?<\/script>/gi, " ")
                  .replace(/<style[\s\S]*?<\/style>/gi, " ")
                  .replace(/<[^>]+>/g, " ")
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 6000);
                return { url, contenuto: text };
              } catch (e) {
                return { esito: "errore", messaggio: e instanceof Error ? e.message : "Pagina non raggiungibile" };
              }
            },
          });
          tools["elenca_cambiamenti"] = tool({
            description: "Elenca i cambiamenti rilevati di recente sulle pagine seguite.",
            inputSchema: z.object({}),
            execute: async () => {
              const { data } = await supabase
                .from("monitor_findings")
                .select("title,summary,source_url,detected_at")
                .eq("project_id", projectId)
                .order("detected_at", { ascending: false })
                .limit(20);
              return { cambiamenti: data ?? [] };
            },
          });
        }

        // Plugin che richiedono un collegamento non ancora attivo: il bot lo dice chiaramente.
        for (const p of activePlugins) {
          if (p.needsConnection && !connectionState(p.id)) {
            tools[`stato_${p.id}`] = tool({
              description: `Verifica se il plugin ${p.name} è collegato prima di promettere azioni.`,
              inputSchema: z.object({}),
              execute: async () => ({
                plugin: p.name,
                collegato: false,
                messaggio: `Il plugin ${p.name} è installato ma non ancora collegato: chiedi all'utente di completare il collegamento nella pagina Plugin.`,
              }),
            });
          }
        }

        const capacita = activePlugins.length
          ? activePlugins
              .map(
                (p) =>
                  `- ${p.name}${p.needsConnection && !connectionState(p.id) ? " (installato, NON ancora collegato)" : ""}: ${p.tagline}`
              )
              .join("\n")
          : "- nessun plugin installato";

        const system = [
          bot?.instructions ??
            "Sei un assistente operativo per una piccola azienda italiana. Rispondi in italiano, in modo semplice e concreto.",
          `Progetto: ${project.name}${project.description ? ` — ${project.description}` : ""}.`,
          `Capacità disponibili in questo progetto:\n${capacita}`,
          "Regole: non inventare dati. Se ti serve un plugin non installato o non collegato, dillo e spiega in una frase come attivarlo (pagina Plugin). Usa gli strumenti quando servono dati reali. Risposte brevi, elenchi quando aiutano.",
        ].join("\n\n");

        const gateway = createLovableAiGatewayProvider(apiKey);

        try {
          const result = streamText({
            model: gateway(HOMUN_MODEL),
            system,
            messages: await convertToModelMessages(messages),
            tools,
          });

          return result.toUIMessageStreamResponse({
            originalMessages: messages,
            onFinish: async ({ responseMessage }) => {
              if (!conversationId) return;
              const { error } = await supabase.from("messages").insert({
                conversation_id: conversationId,
                external_id: responseMessage.id,
                role: responseMessage.role,
                parts: responseMessage.parts as unknown as object,
              });
              if (error) console.error("Salvataggio messaggio assistente:", error.message);
              await supabase
                .from("conversations")
                .update({ updated_at: new Date().toISOString() })
                .eq("id", conversationId);
            },
          });
        } catch (e) {
          console.error(e);
          return jsonError("Il modello non ha risposto. Riprova tra poco.", 502);
        }
      },
    },
  },
});
