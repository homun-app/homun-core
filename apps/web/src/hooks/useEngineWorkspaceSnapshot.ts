/** Authoritative work inventory; denied refreshes discard previously visible data. */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  listEngineWorks,
  listEngineConversations,
  type EngineFollowupNotice,
} from "@/lib/engine-domain-client";
import { listEngineProjects, type EngineProject } from "@/lib/engine-projects-client";
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
      setFollowups([]);
      clearRef.current();
      return;
    }
    try {
      const [items, conversations, currentProjects, currentAgents] = await Promise.all([
        listEngineWorks(),
        listEngineConversations(),
        listEngineProjects(),
        listEngineAgents(),
      ]);
      if (current !== generation.current) return;
      setRawWorks(items);
      setProjects(currentProjects);
      setAgents(currentAgents);
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
  return { rawWorks, projects, agents, followups, loaded, refresh };
}
