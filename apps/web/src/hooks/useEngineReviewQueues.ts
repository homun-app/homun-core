import { useCallback, useEffect, useRef, useState } from "react";
import { listEngineWorks } from "@/lib/engine-domain-client";
import { listAgentRuns, type AgentRun } from "@/lib/engine-agent-run-client";
import { listTerminalJobs, type TerminalJob } from "@/lib/engine-terminal-client";
import { listFileEdits, type FileEdit } from "@/lib/engine-file-edit-client";
import { listEngineSkills, type Skill } from "@/lib/engine-mcp-client";

export type ReviewQueues = {
  loading: boolean;
  error: unknown;
  runs: Array<{ workId: string; workTitle: string; run: AgentRun }>;
  terminal: Array<{ workId: string; workTitle: string; job: TerminalJob }>;
  edits: Array<{ workId: string; workTitle: string; edit: FileEdit }>;
  skills: Skill[];
  lastRefreshedAt: Date | null;
  refresh: () => void;
};

/**
 * Aggrega le code di revisione del motore: run in attesa di approvazione,
 * comandi terminale e modifiche file proposte dagli agenti, skill in quarantena.
 * Fonte: solo motore — mai dati di simulazione.
 */
export function useEngineReviewQueues(active: boolean, pollMs = 4000): ReviewQueues {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [runs, setRuns] = useState<ReviewQueues["runs"]>([]);
  const [terminal, setTerminal] = useState<ReviewQueues["terminal"]>([]);
  const [edits, setEdits] = useState<ReviewQueues["edits"]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [tick, setTick] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const collect = async () => {
      try {
        const works = await listEngineWorks();
        const open = works
          .filter((work) => work['archived'] !== true)
          .slice(-30) as Array<{ id: string; title?: string }>;
        const [runRows, terminalRows, editRows, staged] = await Promise.all([
          Promise.all(
            open.map(async (work) => {
              try {
                const items = await listAgentRuns(work.id);
                return items
                  .filter((run) => run.status === "pending_approval")
                  .map((run) => ({ workId: work.id, workTitle: work.title ?? work.id, run }));
              } catch {
                return [];
              }
            }),
          ),
          Promise.all(
            open.map(async (work) => {
              try {
                const items = await listTerminalJobs(work.id);
                return items
                  .filter((job) => job.status === "pending_approval")
                  .map((job) => ({ workId: work.id, workTitle: work.title ?? work.id, job }));
              } catch {
                return [];
              }
            }),
          ),
          Promise.all(
            open.map(async (work) => {
              try {
                const items = await listFileEdits(work.id);
                return items
                  .filter((edit) => edit.status === "pending_approval")
                  .map((edit) => ({ workId: work.id, workTitle: work.title ?? work.id, edit }));
              } catch {
                return [];
              }
            }),
          ),
          listEngineSkills().then((items) => items.filter((skill) => skill.status === "staged")),
        ]);
        if (cancelled || !mounted.current) return;
        setRuns(runRows.flat());
        setTerminal(terminalRows.flat());
        setEdits(editRows.flat());
        setSkills(staged);
        setError(null);
        setLastRefreshedAt(new Date());
      } catch (reason) {
        if (cancelled || !mounted.current) return;
        setError(reason);
      } finally {
        if (!cancelled && mounted.current) {
          setLoading(false);
          timer = setTimeout(collect, pollMs);
        }
      }
    };

    setLoading(true);
    collect();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, pollMs, tick]);

  return { loading, error, runs, terminal, edits, skills, lastRefreshedAt, refresh };
}
