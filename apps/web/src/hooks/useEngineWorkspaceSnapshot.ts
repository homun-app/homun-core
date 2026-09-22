/** Authoritative work inventory; denied refreshes discard previously visible data. */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  listEngineWorks,
  listEngineConversations,
  type EngineFollowupNotice,
} from "@/lib/engine-domain-client";
import { listEngineProjects, listEngineTeams, type EngineProject, type EngineTeam } from "@/lib/engine-projects-client";
import { listEngineRoutines, type EngineRoutine } from "@/lib/engine-routines-client";
import { listEngineAgents, type EngineAgentProfile } from "@/lib/engine-agents-client";
export function useEngineWorkspaceSnapshot(
  ready: boolean,
  clearOverlay: () => void,
  onError: (cause: unknown) => void,
) {
  const [agents, setAgents] = useState<EngineAgentProfile[]>([]);
  const [projects, setProjects] = useState<EngineProject[]>([]);
  const [rawWorks, setRawWorks] = useState<Array<Record<string, unknown>>>([]);
  const [followups, setFollowups] = useState<
    Array<EngineFollowupNotice & { conversationTitle: string }>
  >([]);
  const [teams, setTeams] = useState<EngineTeam[]>([]);
  const [routines, setRoutines] = useState<EngineRoutine[]>([]);
  const [loaded, setLoaded] = useState(false);
  const generation = useRef(0);
  const clearRef = useRef(clearOverlay);
  clearRef.current = clearOverlay;
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoaded(false);
    if (!ready) {
      setRawWorks([]);
      setProjects([]);
      setAgents([]);
      setTeams([]);
      setRoutines([]);
      setFollowups([]);
      clearRef.current();
      return;
    }
    try {
      const [items, conversations, currentProjects, currentAgents, currentTeams, currentRoutines] = await Promise.all([
        listEngineWorks(),
        listEngineConversations(),
        listEngineProjects(),
        listEngineAgents(),
        listEngineTeams(),
        listEngineRoutines(),
      ]);
      if (current !== generation.current) return;
      // A work linked to a project only through its conversation still gets
      // the project's materials: mirror the engine's work_project_ids rule.
      setRawWorks(items.map((work) =>
        work["project_id"] == null
          ? { ...work, project_id: conversations.find((c) => c.id === work["primary_conversation_id"])?.project_id ?? null }
          : work,
      ));
      setProjects(currentProjects);
      setAgents(currentAgents);
      setTeams(currentTeams.filter((team) => team.status !== "archived"));
      setRoutines(currentRoutines.filter((r) => r.status !== "stopped"));
      setFollowups(
        conversations.flatMap((conversation) =>
          conversation.followups.map((notice) => ({
            ...notice,
            conversationTitle: conversation.title,
          })),
        ),
      );
    } catch (cause) {
      if (current === generation.current) {
        setRawWorks([]);
        setProjects([]);
        setTeams([]);
      setRoutines([]);
      setAgents([]);
        setFollowups([]);
        clearRef.current();
        onError(cause);
      }
      throw cause;
    } finally {
      if (current === generation.current) setLoaded(true);
    }
  }, [ready, onError]);
  useEffect(() => {
    void refresh().catch(() => {});
    return () => {
      generation.current++;
    };
  }, [refresh]);
  return { rawWorks, projects, agents, teams, routines, followups, loaded, refresh };
}
