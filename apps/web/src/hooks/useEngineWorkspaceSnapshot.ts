/** Last engine snapshot; on connection loss it stays visible read-only. */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  listEngineWorks,
  listEngineConversations,
  type EngineFollowupNotice,
} from "@/lib/engine-domain-client";
import {
  listEngineProjects,
  listEngineTeams,
  type EngineProject,
  type EngineTeam,
} from "@/lib/engine-projects-client";
import { listEngineRoutines, type EngineRoutine } from "@/lib/engine-routines-client";
import { listEngineAgents, type EngineAgentProfile } from "@/lib/engine-agents-client";
import {
  emptyEngineWorkspaceCollections,
  workspaceAfterReadFailure,
  type EngineWorkspaceCollections,
} from "@/lib/engine-read-retention";
export function useEngineWorkspaceSnapshot(
  ready: boolean,
  clearOverlay: () => void,
  onError: (cause: unknown) => void,
) {
  const [agents, setAgents] = useState<EngineAgentProfile[]>([]);
  const [projects, setProjects] = useState<EngineProject[]>([]);
  const [rawWorks, setRawWorks] = useState<Array<Record<string, unknown>>>([]);
  const [followups, setFollowups] = useState<
    Array<EngineFollowupNotice & { conversationId: string; conversationTitle: string }>
  >([]);
  const [teams, setTeams] = useState<EngineTeam[]>([]);
  const [routines, setRoutines] = useState<EngineRoutine[]>([]);
  const [loaded, setLoaded] = useState(false);
  const generation = useRef(0);
  // L'ultimo snapshot consegnato dal motore: la politica di ritenzione decide
  // per ogni collezione se sopravvive a una lettura fallita.
  const deliveredRef = useRef<EngineWorkspaceCollections>(emptyEngineWorkspaceCollections());
  const clearRef = useRef(clearOverlay);
  clearRef.current = clearOverlay;
  const applyCollections = useCallback((next: EngineWorkspaceCollections) => {
    setRawWorks(next.rawWorks);
    setProjects(next.projects);
    setAgents(next.agents);
    setTeams(next.teams);
    setRoutines(next.routines);
    setFollowups(next.followups);
  }, []);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoaded(false);
    if (!ready) {
      // Il motore non risponde: l'ultimo snapshot ricevuto resta visibile, in
      // sola lettura — conversazioni, lavori e thread aperto compresi, con il
      // campo di scrittura bloccato e l'avviso che lo dice. Nessun dato
      // inventato e nessuna simulazione: solo ciò che il motore aveva già
      // restituito. Alla riconnessione si ricarica tutto normalmente.
      setLoaded(true);
      return;
    }
    try {
      const [items, conversations, currentProjects, currentAgents, currentTeams, currentRoutines] =
        await Promise.all([
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
      const delivered: EngineWorkspaceCollections = {
        rawWorks: items.map((work) =>
          work["project_id"] == null
            ? {
                ...work,
                project_id:
                  conversations.find((c) => c.id === work["primary_conversation_id"])?.project_id ??
                  null,
              }
            : work,
        ),
        projects: currentProjects,
        agents: currentAgents,
        teams: currentTeams.filter((team) => team.status !== "archived"),
        routines: currentRoutines.filter((r) => r.status !== "stopped"),
        followups: conversations.flatMap((conversation) =>
          conversation.followups.map((notice) => ({
            ...notice,
            conversationId: conversation.id,
            conversationTitle: conversation.title,
          })),
        ),
      };
      deliveredRef.current = delivered;
      applyCollections(delivered);
    } catch (cause) {
      if (current === generation.current) {
        // La caduta della connessione conserva l'ultimo snapshot ricevuto
        // (l'avviso la racconta); le letture negate o non valide continuano
        // a scartare ciò che era visibile, come prima.
        const retained = workspaceAfterReadFailure(cause, deliveredRef.current);
        const discarded = retained !== deliveredRef.current;
        deliveredRef.current = retained;
        // a connessione caduta i riferimenti sono gli stessi: React non ridisegna
        applyCollections(retained);
        if (discarded) clearRef.current();
        onError(cause);
      }
      throw cause;
    } finally {
      if (current === generation.current) setLoaded(true);
    }
  }, [ready, onError, applyCollections]);
  useEffect(() => {
    void refresh().catch(() => {});
    return () => {
      generation.current++;
    };
  }, [refresh]);
  return { rawWorks, projects, agents, teams, routines, followups, loaded, refresh };
}
