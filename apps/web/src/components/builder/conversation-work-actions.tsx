/**
 * Row actions (rename/move/archive/delete/repeat/promote) for conversation
 * list entries, simulation vs engine branches, plus promoteWork. Bodies moved
 * verbatim from ConversationWorkspace, which stays the composition shell.
 */
import type { Dispatch, SetStateAction } from "react";
import { ConversationActions } from "./ConversationActions";
import type { SpaceData, SpaceView } from "./ConversationSpace";
import type { ConversationMaterial } from "./ConversationMaterials";
import type { Work } from "./conversation-types";
import { isEngineBackedWork } from "@/lib/conversation-engine-bridge";
import { pausedRoutines } from "@/lib/conversation-routines";
import { repeatEngineWork } from "@/lib/engine-work-repeat";

export type ConversationWorkActionsDeps = {
  work: Work | undefined;
  displaySpaceData: SpaceData;
  spaceData: SpaceData;
  works: Work[];
  active: string | null;
  library: ConversationMaterial[];
  setWorks: Dispatch<SetStateAction<Work[]>>;
  setMaterials: Dispatch<SetStateAction<ConversationMaterial[]>>;
  setSpaceData: Dispatch<SetStateAction<SpaceData>>;
  setNotice: Dispatch<SetStateAction<string>>;
  open: (id: string | null, selector?: string) => void;
  openSpace: (view: SpaceView, initial?: string, selected?: string) => void;
  moveConversation: (id: string, projectId: string) => void;
};

export function createConversationWorkActions({
  work,
  displaySpaceData,
  spaceData,
  works,
  active,
  library,
  setWorks,
  setMaterials,
  setSpaceData,
  setNotice,
  open,
  openSpace,
  moveConversation,
}: ConversationWorkActionsDeps) {
  function promoteWork(target = work) {
    const work = target;
    if (!work) return;
    const id = crypto.randomUUID();
    setSpaceData((current) => ({
      ...current,
      projects: [
        ...current.projects,
        {
          id,
          name: work.title,
          brief: work.messages[0]?.text || work.title,
          teamId: "",
        },
      ],
    }));
    setWorks((current) => current.map((w) => (w.id === work.id ? { ...w, projectId: id } : w)));
    setMaterials((current) =>
      current.map((m) =>
        work.materialIds?.includes(m.id)
          ? { ...m, projectIds: [...new Set([...m.projectIds, id])] }
          : m,
      ),
    );
    openSpace("Progetti", "", id);
  }
  function conversationActions(w: Work) {
    if (isEngineBackedWork(w)) {
      return (
        <ConversationActions
          title={w.title}
          projects={displaySpaceData.projects}
          current={w.projectId || ""}
          onRename={() => setNotice("Rinomina non ancora disponibile.")}
          onMove={(projId) => moveConversation(w.id, projId)}
          onCreate={() => setNotice("Promozione a progetto non ancora collegata al motore.")}
          onRepeat={() => repeatEngineWork(w, openSpace, setNotice)}
        />
      );
    }
    return (
      <ConversationActions
        title={w.title}
        projects={spaceData.projects}
        current={w.projectId || ""}
        onRename={(name) =>
          setWorks((current) =>
            current.map((item) => (item.id === w.id ? { ...item, title: name } : item)),
          )
        }
        {...(!w.coordinatedBy
          ? {
              onArchive: () => {
                setWorks((current) =>
                  current.map((item) =>
                    item.id === w.id || item.coordinatedBy === w.id
                      ? { ...item, archived: true }
                      : item,
                  ),
                );
                setSpaceData((current) => ({
                  ...current,
                  routines: pausedRoutines(current.routines, (r) => r.workId === w.id),
                }));
                if (active === w.id) {
                  open(null);
                  openSpace("Compiti");
                }
                setNotice("Conversazione archiviata. Puoi ripristinarla dalle impostazioni.");
              },
              onDelete: () => {
                const removed = new Set(
                  works
                    .filter((item) => item.id === w.id || item.coordinatedBy === w.id)
                    .map((item) => item.id),
                );
                setMaterials([...library]);
                setWorks((current) =>
                  current
                    .filter((item) => !removed.has(item.id))
                    .map((item) =>
                      item.request?.childId && removed.has(item.request.childId)
                        ? {
                            ...item,
                            phase: "waiting",
                            request: {
                              to: item.requester || "Fabio",
                              need:
                                "Il contributo collegato è stato eliminato. Fornisci nuovamente: " +
                                item.request.need,
                              status: "pending",
                            },
                          }
                        : item,
                    ),
                );
                setSpaceData((current) => ({
                  ...current,
                  routines: pausedRoutines(current.routines, (r) => removed.has(r.workId)),
                }));
                if (active && removed.has(active)) {
                  open(null);
                  openSpace("Compiti");
                }
              },
            }
          : {})}
        onMove={(id) => moveConversation(w.id, id)}
        onCreate={() => promoteWork(w)}
        onRepeat={() => {
          open(w.id);
          openSpace("Automazioni", "Ripeti questo lavoro ogni lunedì alle 9");
        }}
      />
    );
  }
  return conversationActions;
}
