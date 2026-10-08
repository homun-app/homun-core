/** Synthesis uses the common durable execution UI lifecycle. */
import type { Work } from "@/components/builder/conversation-types";
import { approveSynthesis, listSyntheses, prepareSynthesis } from "@/lib/engine-synthesis-client";
import { useEngineExecution } from "./useEngineExecution";

export function useSynthesis(work: Work, onChanged: () => Promise<void>) {
  return useEngineExecution(work, onChanged, {
    list: listSyntheses, approve: approveSynthesis,
    prepare: (work: Work, id: string, materials: string[], skills: string[] = []) =>
      prepareSynthesis(work, materials, id, skills),
  });
}
