import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export type MemberRole = "titolare" | "gestore" | "collaboratore" | "ospite";

export type Project = {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
};

export type Organization = { id: string; name: string; owner_id: string };

type WorkspaceState = {
  loading: boolean;
  organizations: Organization[];
  projects: Project[];
  activeProject: Project | null;
  activeOrg: Organization | null;
  role: MemberRole | null;
  canManage: boolean;
  canWrite: boolean;
  setActiveProjectId: (id: string) => void;
  refresh: () => void;
};

const STORAGE_KEY = "homun.activeProject";

const WorkspaceContext = createContext<WorkspaceState>({
  loading: true,
  organizations: [],
  projects: [],
  activeProject: null,
  activeOrg: null,
  role: null,
  canManage: false,
  canWrite: false,
  setActiveProjectId: () => {},
  refresh: () => {},
});

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setActiveId(window.localStorage.getItem(STORAGE_KEY));
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ["workspace", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const [{ data: orgs }, { data: projects }, { data: memberships }] = await Promise.all([
        supabase.from("organizations").select("id,name,owner_id").order("created_at"),
        supabase.from("projects").select("id,org_id,name,description").order("created_at"),
        supabase.from("project_members").select("project_id,role").eq("user_id", user!.id),
      ]);
      return {
        organizations: (orgs ?? []) as Organization[],
        projects: (projects ?? []) as Project[],
        roles: Object.fromEntries((memberships ?? []).map((m) => [m.project_id, m.role as MemberRole])),
      };
    },
  });

  const projects = data?.projects ?? [];
  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeId) ?? projects[0] ?? null,
    [projects, activeId]
  );
  const activeOrg = useMemo(
    () => (data?.organizations ?? []).find((o) => o.id === activeProject?.org_id) ?? null,
    [data?.organizations, activeProject]
  );
  const ownerRole: MemberRole | null = activeOrg && activeOrg.owner_id === user?.id ? "titolare" : null;
  const role = (activeProject ? data?.roles[activeProject.id] : null) ?? ownerRole ?? null;

  return (
    <WorkspaceContext.Provider
      value={{
        loading: isLoading,
        organizations: data?.organizations ?? [],
        projects,
        activeProject,
        activeOrg,
        role,
        canManage: role === "titolare" || role === "gestore",
        canWrite: role === "titolare" || role === "gestore" || role === "collaboratore",
        setActiveProjectId: (id) => {
          setActiveId(id);
          if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, id);
        },
        refresh: () => {
          void queryClient.invalidateQueries({ queryKey: ["workspace", user?.id] });
        },
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  return useContext(WorkspaceContext);
}
