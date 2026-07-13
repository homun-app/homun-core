import { useSyncExternalStore } from "react";
import { coreBridge, type Tag, type TagAssignment, type TagEntityType } from "./coreBridge";

// A tiny module-level store for tags + assignments, shared by every sidebar surface (the thread
// menu lives in NavDrawer, the project menu in ProjectsNav — separate components). One load, one
// source of truth, and a single mutation refreshes all subscribers — cleaner than a Context
// provider or prop-drilling for a dataset this small. SOTA read path: `useSyncExternalStore`.

interface TagsSnapshot {
  tags: Tag[];
  assignments: TagAssignment[];
}

let snapshot: TagsSnapshot = { tags: [], assignments: [] };
let loaded = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

async function load(): Promise<void> {
  try {
    const [tags, assignments] = await Promise.all([
      coreBridge.listTags(),
      coreBridge.allTagAssignments(),
    ]);
    snapshot = { tags, assignments };
    emit();
  } catch {
    /* keep last known — the sidebar just shows no tags rather than erroring */
  }
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  if (!loaded) {
    loaded = true;
    void load();
  }
  return () => listeners.delete(callback);
}

function getSnapshot(): TagsSnapshot {
  return snapshot;
}

/** Tags currently assigned to one entity, from the shared snapshot (no request). */
export function tagsForEntity(
  assignments: TagAssignment[],
  entityType: TagEntityType,
  entityId: string,
): Tag[] {
  return assignments
    .filter((a) => a.entity_type === entityType && a.entity_id === entityId)
    .map((a) => a.tag);
}

export function useTags() {
  const state = useSyncExternalStore(subscribe, getSnapshot);
  return {
    tags: state.tags,
    assignments: state.assignments,
    refresh: load,
    createTag: async (name: string, color: string): Promise<Tag> => {
      const tag = await coreBridge.createTag(name, color);
      await load();
      return tag;
    },
    assign: async (tagId: string, entityType: TagEntityType, entityId: string) => {
      await coreBridge.assignTag(tagId, entityType, entityId);
      await load();
    },
    unassign: async (tagId: string, entityType: TagEntityType, entityId: string) => {
      await coreBridge.unassignTag(tagId, entityType, entityId);
      await load();
    },
    deleteTag: async (tagId: string) => {
      await coreBridge.deleteTag(tagId);
      await load();
    },
    renameTag: async (tagId: string, name: string) => {
      await coreBridge.renameTag(tagId, name);
      await load();
    },
    setTagColor: async (tagId: string, color: string) => {
      await coreBridge.setTagColor(tagId, color);
      await load();
    },
  };
}
