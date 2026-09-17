import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Mail, ShieldCheck, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace, type MemberRole } from "@/hooks/useWorkspace";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/app/team")({
  head: () => ({
    meta: [
      { title: "Persone — Homun" },
      { name: "description", content: "Invita colleghi e decidi cosa può vedere ciascuno." },
      { property: "og:title", content: "Persone — Homun" },
      { property: "og:description", content: "Ruoli e accessi ai progetti." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: TeamPage,
});

const ROLES: { value: MemberRole; label: string; description: string }[] = [
  { value: "titolare", label: "Titolare", description: "Può tutto, anche invitare e rimuovere persone." },
  { value: "gestore", label: "Gestore", description: "Gestisce assistenti, plugin e automazioni." },
  { value: "collaboratore", label: "Collaboratore", description: "Usa la chat e avvia automazioni." },
  { value: "ospite", label: "Ospite", description: "Guarda soltanto, senza modificare nulla." },
];

function TeamPage() {
  const { activeOrg, activeProject, canManage, role } = useWorkspace();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<MemberRole>("collaboratore");

  const { data: members } = useQuery({
    queryKey: ["org-members", activeOrg?.id],
    enabled: !!activeOrg,
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from("org_members")
        .select("id,user_id,role,invited_email,created_at")
        .eq("org_id", activeOrg!.id)
        .order("created_at");
      if (error) throw error;
      const userIds = (rows ?? []).map((r) => r.user_id).filter(Boolean);
      const { data: profiles } = userIds.length
        ? await supabase.from("profiles").select("id,full_name").in("id", userIds)
        : { data: [] };
      return (rows ?? []).map((r) => ({
        ...r,
        name: (profiles ?? []).find((p) => p.id === r.user_id)?.full_name ?? null,
      }));
    },
  });

  const invite = useMutation({
    mutationFn: async () => {
      if (!activeOrg) throw new Error("Azienda non disponibile");
      const { error } = await supabase.from("org_members").insert({
        org_id: activeOrg.id,
        user_id: crypto.randomUUID(),
        invited_email: email.trim().toLowerCase(),
        role: inviteRole,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Invito registrato", {
        description: "La persona entra nel progetto al primo accesso con questa email.",
      });
      setEmail("");
      void queryClient.invalidateQueries({ queryKey: ["org-members", activeOrg?.id] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Invito non riuscito"),
  });

  const changeRole = useMutation({
    mutationFn: async ({ id, newRole }: { id: string; newRole: MemberRole }) => {
      const { error } = await supabase.from("org_members").update({ role: newRole }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["org-members", activeOrg?.id] }),
    onError: () => toast.error("Non è stato possibile cambiare il ruolo"),
  });

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Persone</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {activeOrg?.name} — chi lavora su «{activeProject?.name}» e con quale ruolo.
        </p>
      </header>

      {canManage && (
        <section className="frost-panel mt-6 p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <UserPlus className="size-4 text-primary" /> Invita una persona
          </h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto_auto]">
            <div className="space-y-1.5">
              <Label htmlFor="invite-email" className="text-xs">
                Email
              </Label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="collega@azienda.it"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Ruolo</Label>
              <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as MemberRole)}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <Button
                onClick={() => invite.mutate()}
                disabled={!email.includes("@") || invite.isPending}
              >
                <Mail /> Invita
              </Button>
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {ROLES.find((r) => r.value === inviteRole)?.description}
          </p>
        </section>
      )}

      <section className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          In azienda
        </h2>
        <ul className="mt-3 space-y-2">
          {(members ?? []).map((m) => (
            <li
              key={m.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {m.name ?? m.invited_email ?? "Persona invitata"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {m.invited_email && !m.name ? "In attesa del primo accesso" : "Attivo"}
                </p>
              </div>
              {canManage ? (
                <Select
                  value={m.role}
                  onValueChange={(v) => changeRole.mutate({ id: m.id, newRole: v as MemberRole })}
                >
                  <SelectTrigger className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Badge variant="secondary">
                  {ROLES.find((r) => r.value === m.role)?.label ?? m.role}
                </Badge>
              )}
            </li>
          ))}
          {!members?.length && (
            <li className="text-sm text-muted-foreground">Per ora ci sei solo tu.</li>
          )}
        </ul>
      </section>

      <section className="frost-panel mt-8 p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <ShieldCheck className="size-4 text-primary" /> Privacy dei progetti
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Ogni progetto è separato: conversazioni, automazioni e dati dei plugin restano visibili solo
          a chi è stato aggiunto a quel progetto. Il tuo ruolo qui è{" "}
          <strong className="text-foreground">
            {ROLES.find((r) => r.value === role)?.label ?? "non assegnato"}
          </strong>
          .
        </p>
      </section>
    </div>
  );
}
