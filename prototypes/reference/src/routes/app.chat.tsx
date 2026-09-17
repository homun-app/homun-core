import { createFileRoute, Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquarePlus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useWorkspace } from "@/hooks/useWorkspace";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/app/chat")({
  component: ChatLayout,
});

export function useConversations() {
  const { activeProject } = useWorkspace();
  return useQuery({
    queryKey: ["conversations", activeProject?.id],
    enabled: !!activeProject,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select("id,title,updated_at")
        .eq("project_id", activeProject!.id)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

export function useCreateConversation() {
  const { activeProject } = useWorkspace();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (prompt?: string) => {
      if (!activeProject || !user) throw new Error("Progetto non disponibile");
      const { data: bot } = await supabase
        .from("bots")
        .select("id")
        .eq("project_id", activeProject.id)
        .limit(1)
        .maybeSingle();
      const { data, error } = await supabase
        .from("conversations")
        .insert({
          project_id: activeProject.id,
          created_by: user.id,
          title: prompt ? prompt.slice(0, 60) : "Nuova conversazione",
          bot_id: bot?.id ?? null,
        })
        .select("id")
        .single();
      if (error) throw error;
      if (prompt) {
        sessionStorage.setItem(`homun.pendingPrompt.${data.id}`, prompt);
      }
      return data.id;
    },
    onSuccess: async (id) => {
      await queryClient.invalidateQueries({ queryKey: ["conversations", activeProject?.id] });
      void navigate({ to: "/app/chat/$conversationId", params: { conversationId: id } });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Non riuscito"),
  });
}

function ChatLayout() {
  const { canWrite, activeProject } = useWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams({ strict: false }) as { conversationId?: string };
  const { data: conversations } = useConversations();
  const createConversation = useCreateConversation();


  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("conversations").delete().eq("id", id);
      if (error) throw error;
      return id;
    },
    onSuccess: async (id) => {
      await queryClient.invalidateQueries({ queryKey: ["conversations", activeProject?.id] });
      if (params.conversationId === id) void navigate({ to: "/app/chat" });
    },
    onError: () => toast.error("Non è stato possibile eliminare la conversazione"),
  });

  return (
    <div className="flex h-[calc(100vh-0px)] min-h-0">
      <div className="hidden w-72 shrink-0 flex-col border-r border-border bg-card/60 lg:flex">
        <div className="p-4">
          <Button
            className="w-full"
            onClick={() => createConversation.mutate(undefined)}
            disabled={!canWrite || createConversation.isPending}
          >
            <MessageSquarePlus /> Nuova conversazione
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {(conversations ?? []).map((c) => (
            <div
              key={c.id}
              className="group flex items-center gap-1 rounded-lg px-1 hover:bg-accent"
            >
              <Link
                to="/app/chat/$conversationId"
                params={{ conversationId: c.id }}
                className="min-w-0 flex-1 px-2 py-2 text-sm text-muted-foreground data-[status=active]:font-medium data-[status=active]:text-primary"
              >
                <span className="block truncate">{c.title}</span>
                <span className="block text-xs text-muted-foreground/70">
                  {new Date(c.updated_at).toLocaleDateString("it-IT")}
                </span>
              </Link>
              <button
                type="button"
                aria-label="Elimina conversazione"
                onClick={() => remove.mutate(c.id)}
                className="opacity-0 transition-opacity group-hover:opacity-100"
              >
                <Trash2 className="size-4 text-muted-foreground hover:text-destructive" />
              </button>
            </div>
          ))}
          {!conversations?.length && (
            <p className="px-3 py-4 text-sm text-muted-foreground">
              Nessuna conversazione. Iniziane una per chiedere qualcosa al tuo assistente.
            </p>
          )}
        </div>
      </div>
      <div className="min-h-0 min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
