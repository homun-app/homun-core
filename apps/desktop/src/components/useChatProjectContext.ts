import { useEffect, useState } from "react";
import { coreBridge } from "../lib/coreBridge";

export function useChatProjectContext(threadId: string) {
  const [threadIsProject, setThreadIsProject] = useState(false);
  const [projectGoalCount, setProjectGoalCount] = useState(0);
  const [projectObjective, setProjectObjective] = useState<string | null>(null);
  const [projectMemoryCount, setProjectMemoryCount] = useState(0);
  const [goalSeed, setGoalSeed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setThreadIsProject(false);
    setProjectGoalCount(0);
    setProjectObjective(null);
    setProjectMemoryCount(0);
    void coreBridge
      .projectGoals(threadId)
      .then((d) => {
        if (cancelled) return;
        const isProject = Boolean(d?.is_project);
        setThreadIsProject(isProject);
        setProjectGoalCount(d?.goals.length ?? 0);
        setProjectObjective(d?.objective ?? null);
        if (!isProject) {
          setProjectMemoryCount(0);
          return;
        }
        void coreBridge
          .memoryGraph(threadId)
          .then((graph) => {
            if (!cancelled) {
              setProjectMemoryCount(Math.max(0, graph.nodes.length - 1));
            }
          })
          .catch(() => {
            if (!cancelled) setProjectMemoryCount(0);
          });
      })
      .catch(() => {
        if (cancelled) return;
        setThreadIsProject(false);
        setProjectGoalCount(0);
        setProjectObjective(null);
        setProjectMemoryCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  return {
    goalSeed,
    projectGoalCount,
    projectMemoryCount,
    projectObjective,
    setGoalSeed,
    threadIsProject,
  };
}
