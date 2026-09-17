import { createFileRoute, Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Puzzle,
  Users,
  Workflow,
  ChevronsUpDown,
  Plus,
  Sparkle,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useWorkspace } from "@/hooks/useWorkspace";
import { Wordmark } from "@/components/brand/Wordmark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/app")({
  head: () => ({
    meta: [
      { title: "Spazio di lavoro — Homun" },
      { name: "description", content: "Assistenti, automazioni e plugin del tuo progetto Homun." },
      { property: "og:title", content: "Spazio di lavoro — Homun" },
      { property: "og:description", content: "Assistenti, automazioni e plugin del tuo progetto." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AppLayout,
});

type NavItem = {
  to: "/app" | "/app/create" | "/app/chat" | "/app/pipelines" | "/app/plugins" | "/app/team";
  label: string;
  icon: typeof LayoutDashboard;
  exact?: boolean;
};

const nav: NavItem[] = [
  { to: "/app", label: "Panoramica", icon: LayoutDashboard, exact: true },
  { to: "/app/create", label: "Crea", icon: Sparkle },
  { to: "/app/chat", label: "Chat", icon: MessageSquare },
  { to: "/app/pipelines", label: "Automazioni", icon: Workflow },
  { to: "/app/plugins", label: "Plugin", icon: Puzzle },
  { to: "/app/team", label: "Persone", icon: Users },
];

function AppLayout() {
  const { user, loading, signOut } = useAuth();
  const navigate = useNavigate();
  const { projects, activeProject, activeOrg, loading: wsLoading, setActiveProjectId, refresh } =
    useWorkspace();
  const [newOpen, setNewOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user) void navigate({ to: "/auth" });
  }, [loading, user, navigate]);

  if (loading || wsLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Carico il tuo spazio…
      </div>
    );
  }
  if (!user) return null;
  if (!activeProject) return <Onboarding />;

  return (
    <div className="flex min-h-screen bg-secondary/30">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-card/70 p-4 md:flex">
        <Link to="/app" className="px-2 py-1">
          <Wordmark className="h-6" />
        </Link>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="mt-6 flex w-full items-center justify-between rounded-xl border border-border bg-background px-3 py-2.5 text-left transition-colors hover:bg-accent">
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-foreground">
                  {activeProject.name}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {activeOrg?.name ?? "Progetto"}
                </span>
              </span>
              <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuLabel>Progetti</DropdownMenuLabel>
            {projects.map((p) => (
              <DropdownMenuItem key={p.id} onSelect={() => setActiveProjectId(p.id)}>
                {p.name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setNewOpen(true)}>
              <Plus /> Nuovo progetto
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <nav className="mt-6 flex flex-1 flex-col gap-1">
          {nav.map(({ to, label, icon: Icon, exact }) => (
            <Link
              key={to}
              to={to}
              activeOptions={{ exact: Boolean(exact) }}
              className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[status=active]:bg-primary/10 data-[status=active]:text-primary"
            >
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
        </nav>

        <div className="mt-4 border-t border-border pt-4">
          <p className="truncate px-3 text-xs text-muted-foreground">{user.email}</p>
          <button
            onClick={async () => {
              await signOut();
              void navigate({ to: "/" });
            }}
            className="mt-2 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <LogOut className="size-4" /> Esci
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 overflow-x-auto border-b border-border bg-card/70 px-3 py-2 md:hidden">
          <Wordmark className="h-5" />
          {nav.map(({ to, label }) => (
            <Link
              key={to}
              to={to}
              className="whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground data-[status=active]:bg-primary/10 data-[status=active]:text-primary"
            >
              {label}
            </Link>
          ))}
        </div>
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
      </div>

      <NewProjectDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        orgId={activeOrg?.id ?? null}
        onCreated={(id) => {
          refresh();
          setActiveProjectId(id);
        }}
      />
    </div>
  );
}

function NewProjectDialog({
  open,
  onOpenChange,
  orgId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  orgId: string | null;
  onCreated: (id: string) => void;
}) {
  const { user } = useAuth();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const create = useMutation({
    mutationFn: async () => {
      if (!orgId || !user) throw new Error("Azienda non disponibile");
      const { data, error } = await supabase
        .from("projects")
        .insert({ org_id: orgId, name, description: description || null, created_by: user.id })
        .select("id")
        .single();
      if (error) throw error;
      await supabase
        .from("project_members")
        .insert({ project_id: data.id, user_id: user.id, role: "titolare" });
      return data.id;
    },
    onSuccess: (id) => {
      toast.success("Progetto creato");
      setName("");
      setDescription("");
      onOpenChange(false);
      onCreated(id);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Non riuscito"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuovo progetto</DialogTitle>
          <DialogDescription>
            Ogni progetto ha assistenti, automazioni e dati separati dagli altri.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="p-name">Nome</Label>
            <Input
              id="p-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Studio Rossi"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="p-desc">A cosa serve (facoltativo)</Label>
            <Textarea
              id="p-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Gestione clienti e fatture dello studio"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => create.mutate()}
            disabled={!name.trim() || create.isPending}
          >
            Crea progetto
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Onboarding() {
  const { user } = useAuth();
  const { refresh, setActiveProjectId } = useWorkspace();
  const queryClient = useQueryClient();
  const [company, setCompany] = useState("");
  const [project, setProject] = useState("Operazioni");

  const start = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error("Sessione scaduta");
      const { data: org, error: orgError } = await supabase
        .from("organizations")
        .insert({ name: company, owner_id: user.id })
        .select("id")
        .single();
      if (orgError) throw orgError;
      await supabase.from("org_members").insert({ org_id: org.id, user_id: user.id, role: "titolare" });
      const { data: proj, error: projError } = await supabase
        .from("projects")
        .insert({ org_id: org.id, name: project, created_by: user.id })
        .select("id")
        .single();
      if (projError) throw projError;
      await supabase
        .from("project_members")
        .insert({ project_id: proj.id, user_id: user.id, role: "titolare" });
      await supabase.from("bots").insert({
        project_id: proj.id,
        name: "Assistente di " + company,
        subtitle: "Il tuo assistente operativo",
        created_by: user.id,
        instructions:
          "Sei l'assistente operativo di " +
          company +
          ". Rispondi in italiano, in modo semplice e concreto, e proponi automazioni quando un compito si ripete.",
      });
      await supabase.from("dashboard_widgets").insert(
        ["bots_attivi", "pipeline_in_corso", "attivita_recente"].map((widget_key, i) => ({
          project_id: proj.id,
          user_id: user.id,
          widget_key,
          position: i,
        }))
      );
      return proj.id;
    },
    onSuccess: (id) => {
      void queryClient.invalidateQueries();
      refresh();
      setActiveProjectId(id);
      toast.success("Tutto pronto");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Non riuscito"),
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-secondary/40 px-6 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Wordmark className="h-7" />
        </div>
        <div className="frost-panel p-7">
          <span className="inline-flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Bot className="size-5" />
          </span>
          <h1 className="mt-4 text-xl font-semibold tracking-tight text-foreground">
            Iniziamo dalla tua azienda
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Creiamo il tuo spazio e il primo assistente. Potrai aggiungere progetti e persone dopo.
          </p>
          <div className="mt-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="company">Nome dell'azienda</Label>
              <Input
                id="company"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="Rossi Impianti"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="first-project">Primo progetto</Label>
              <Input id="first-project" value={project} onChange={(e) => setProject(e.target.value)} />
            </div>
            <Button
              className="w-full"
              disabled={!company.trim() || !project.trim() || start.isPending}
              onClick={() => start.mutate()}
            >
              {start.isPending ? "Preparo tutto…" : "Crea il mio spazio"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
