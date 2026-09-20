/**
 * Build the global search index for the simulated workspace.
 */

import { isHumanMember, memberProfile } from "./conversation-members.ts";
import type { ConversationMaterial } from "./ConversationMaterials";
import { scenarioForWork, type ConversationScenario } from "./conversation-scenarios.ts";
import type { SearchEntry } from "./ConversationSearch";
import { spacePeople, type SpaceData, type SpaceView } from "./ConversationSpace";
import type { Work } from "./conversation-types.ts";

type Args = {
  library: ConversationMaterial[];
  visibleWorks: Work[];
  scenarios: ConversationScenario[];
  spaceData: SpaceData;
  workStatus: (w: Work) => string;
  openSpace: (view: SpaceView, initial?: string, selected?: string) => void;
  openWork: (id: string, selector?: string) => void;
  openResultPreview: (w: Work) => void;
};

export function buildConversationSearchEntries({
  library,
  visibleWorks,
  scenarios,
  spaceData,
  workStatus,
  openSpace,
  openWork,
  openResultPreview,
}: Args): SearchEntry[] {
  return [
    ...library.map((m) => ({
      id: m.id,
      title: m.name,
      kind: "Materiali",
      context: m.path || "Nota",
      text: m.body || "",
      open: () => openSpace("Materiali", "", m.id),
    })),
    ...visibleWorks.map((w) => ({
      id: w.id,
      title: w.title,
      kind: "Lavori",
      context: `${scenarioForWork(w, scenarios).agent} · ${workStatus(w)}`,
      text: w.contribution,
      open: () => openWork(w.id),
    })),
    ...visibleWorks.flatMap((w) =>
      w.messages.map((m, i) => ({
        id: `${w.id}:message:${i}`,
        title: m.who === "you" ? "Tu" : m.sender || scenarioForWork(w, scenarios).agent,
        kind: "Messaggi",
        context: w.title,
        text: m.text,
        open: () => {
          openWork(w.id, `[data-message="${w.id}:${i}"]`);
        },
      })),
    ),
    ...visibleWorks
      .filter((w) => w.phase === "review" || w.phase === "approved")
      .map((w) => ({
        id: `${w.id}:result`,
        title: w.humanResult ? "Risultato consegnato" : scenarioForWork(w, scenarios).result || w.title,
        kind: "Materiali",
        context: w.title,
        text: w.humanResult || scenarioForWork(w, scenarios).body,
        open: () => openResultPreview(w),
      })),
    ...spaceData.teams.map((t) => ({
      id: t.id,
      title: t.name,
      kind: "Team",
      context: t.members.join(", "),
      text: [t.brief, ...(t.notes || [])].join(" "),
      open: () => openSpace("Squadra", "", t.id),
    })),
    ...spaceData.projects.map((p) => ({
      id: p.id,
      title: p.name,
      kind: "Progetti",
      context: spaceData.teams.find((t) => t.id === p.teamId)?.name || "Senza squadra",
      text: [p.brief, ...(p.notes || [])].join(" "),
      open: () => openSpace("Progetti", "", p.id),
    })),
    ...spaceData.routines.map((r) => ({
      id: r.id,
      title: r.name,
      kind: "Automazioni",
      context: r.schedule,
      text: [r.active ? "attiva" : "pausa", ...(r.notes || [])].join(" "),
      open: () => openSpace("Automazioni", "", r.id),
    })),
    ...[...new Set([...spacePeople, ...Object.keys(spaceData.profiles || {})])]
      .filter((n) => !spaceData.removedPeople?.includes(n))
      .map((n) => ({
        id: `person:${n}`,
        title: n,
        kind: "Collaboratori",
        context: memberProfile(n, spaceData.profiles).role,
        text: JSON.stringify(memberProfile(n, spaceData.profiles)),
        open: () => {
          openSpace("Squadra", "", `person:${n}`);
        },
      })),
  ];
}

export function openWorkResultPreview(
  w: Work,
  scenarios: ConversationScenario[],
  profiles: SpaceData["profiles"],
  openWork: (id: string) => void,
  setPreview: (value: boolean) => void,
) {
  openWork(w.id);
  if (!isHumanMember(scenarioForWork(w, scenarios).agent, profiles)) setPreview(true);
}
