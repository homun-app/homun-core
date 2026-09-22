/**
 * Space views host: tasks, materials, plugins, team/projects/automations, new member.
 * Keeps ConversationWorkspace as a thin router between space and conversation stages.
 */

import type { Dispatch, SetStateAction } from "react";
import { ConversationCreateMember } from "./ConversationCreateMember";
import { ConversationMaterials, type ConversationMaterial } from "./ConversationMaterials";
import { ConversationPlugins } from "./ConversationPlugins";
import {
  ConversationSpace,
  spacePeople,
  type SpaceData,
  type SpaceRoutine,
  type SpaceView,
} from "./ConversationSpace";
import { ConversationTasks } from "./ConversationTasks";
import { initialScenarios, scenarioForWork, type ConversationScenario } from "./conversation-scenarios";
import type { Work } from "./conversation-types";

import { EngineWorkspaceProjects } from "./EngineWorkspaceProjects";

type ScenarioState = (ConversationScenario & { custom?: boolean })[];

import type { EngineAgentProfile } from "@/lib/engine-agents-client";
import type { EngineTeam } from "@/lib/engine-projects-client";
import { EngineWorkspaceAgents } from "./EngineWorkspaceAgents";
import { EngineWorkspaceTeams } from "./EngineWorkspaceTeams";
import { EngineDocuments } from "./EngineDocuments";
import { EngineRoutines } from "./EngineRoutines";
import type { EngineRoutine } from "@/lib/engine-routines-client";
type Props = {
  engineAgents?: EngineAgentProfile[] | undefined;
  engineTeams?: EngineTeam[] | undefined;
  engineRoutines?: EngineRoutine[] | undefined;
  engineMode?: boolean;
  space: SpaceView;
  spaceInitial: string;
  spaceSelected: string;
  spaceVersion: number;
  spaceData: SpaceData;
  setSpaceData: Dispatch<SetStateAction<SpaceData>>;
  scenarios: ScenarioState;
  setScenarios: Dispatch<SetStateAction<ScenarioState>>;
  works: Work[];
  setWorks: Dispatch<SetStateAction<Work[]>>;
  setMaterials: Dispatch<SetStateAction<ConversationMaterial[]>>;
  visibleWorks: Work[];
  library: ConversationMaterial[];
  active: string | null;
  viewer: string;
  setViewer: Dispatch<SetStateAction<string>>;
  pending: Work[];
  workStatus: (w: Work) => string;
  onRevealPanel: () => void;
  onOpenSpace: (view: SpaceView, initial?: string, selected?: string) => void;
  onOpenWork: (id: string | null) => void;
  onMoveWork: (id: string, phase: string) => string;
  onStartAssignment: (name: string) => void;
  onCreateFreeWork: (
    name: string,
    text: string,
    attachments: File[],
    projectId?: string,
  ) => string | undefined;
  onRunRoutine: (r: SpaceRoutine) => void;
  onUpdateMaterial: (item: ConversationMaterial) => void;
  onRemoveMaterial: (id: string) => void;
  onLinkMaterial: (id: string, workId: string) => void;
  onRefreshEngine?: (() => Promise<void>) | undefined;
};

export function ConversationWorkspaceSpaceHost({
  engineMode = false, engineAgents, engineTeams, engineRoutines, onRefreshEngine,
  space,
  spaceInitial,
  spaceSelected,
  spaceVersion,
  spaceData,
  setSpaceData,
  scenarios,
  setScenarios,
  works,
  setWorks,
  setMaterials,
  visibleWorks,
  library,
  active,
  viewer,
  setViewer,
  pending,
  workStatus,
  onRevealPanel,
  onOpenSpace,
  onOpenWork,
  onMoveWork,
  onStartAssignment,
  onCreateFreeWork,
  onRunRoutine,
  onUpdateMaterial,
  onRemoveMaterial,
  onLinkMaterial,
}: Props) {
  if (engineMode && space === "Squadra")
    return (
      <>
        <EngineWorkspaceAgents agents={engineAgents ?? []} onChanged={onRefreshEngine} />
        <EngineWorkspaceTeams teams={engineTeams ?? []} agents={engineAgents ?? []} onChanged={onRefreshEngine} />
      </>
    );
  if (engineMode && space === "Progetti") return <EngineWorkspaceProjects projects={spaceData.projects} works={visibleWorks} selected={spaceSelected} onProject={(id) => onOpenSpace("Progetti", "", id)} onWork={onOpenWork} />;

  if (space === "Nuovo collaboratore") {
    return (
      <ConversationCreateMember
        names={[...spacePeople, ...Object.keys(spaceData.profiles || {})]}
        emails={Object.entries(spaceData.profiles || {})
          .filter(([name]) => !spaceData.removedPeople?.includes(name))
          .map(([, p]) => p.email || "")
          .filter(Boolean)}
        initial={spaceInitial}
        onReveal={onRevealPanel}
        onCreate={(name, profile) => {
          setSpaceData((current) => ({
            ...current,
            profiles: { ...current.profiles, [name]: profile },
          }));
          setScenarios((current) => [
            ...current,
            {
              ...initialScenarios[0]!,
              agent: name,
              icon: name.slice(0, 1),
              role: profile.role,
              custom: true,
            },
          ]);
          onOpenSpace("Squadra", "", `person:${name}`);
        }}
      />
    );
  }

  if (space === "Compiti") {
    return (
      <ConversationTasks
        onReveal={onRevealPanel}
        onMove={onMoveWork}
        items={visibleWorks.map((w) => ({
          ...w,
          due: w.engineDue ?? w.due,
          agent: scenarioForWork(w, scenarios).agent,
          status: workStatus(w),
          needsYou: pending.some((p) => p.id === w.id),
          project: spaceData.projects.find((p) => p.id === w.projectId)?.name || "",
          unavailable: !!spaceData.removedPeople?.includes(scenarioForWork(w, scenarios).agent),
          ...(w.engineIntakePending
            ? {
                nextStep:
                  "Homun ha preparato la proposta: confermala nella conversazione per affidare il lavoro.",
                openLabel: "Apri la proposta",
              }
            : {}),
        }))}
        onOpen={onOpenWork}
        onDue={(id, due) =>
          setWorks((current) => current.map((w) => (w.id === id ? { ...w, due } : w)))
        }
      />
    );
  }

  if (engineMode && space === "Automazioni")
    return <EngineRoutines routines={engineRoutines ?? []} onChanged={onRefreshEngine} />;
  if (space === "Documenti") {
    return <EngineDocuments projects={spaceData.projects.map((p) => ({ id: p.id, name: p.name }))} />;
  }
  if (space === "Materiali") {
    return (
      <ConversationMaterials
        onReveal={onRevealPanel}
        key={spaceVersion}
        items={library}
        profiles={spaceData.profiles}
        contextWork={works.find((w) => w.id === spaceInitial)}
        people={[...new Set([...spacePeople, ...Object.keys(spaceData.profiles || {})])].filter(
          (n) => !spaceData.removedPeople?.includes(n),
        )}
        onBack={onOpenWork}
        projects={spaceData.projects}
        works={works
          .filter((w) => !spaceData.removedPeople?.includes(scenarioForWork(w, scenarios).agent))
          .map((w) => ({ ...w, agent: scenarioForWork(w, scenarios).agent }))}
        onBatchLink={(ids, targets) => {
          const selected = library.filter((m) => ids.includes(m.id));
          const projectIds = targets.filter((t) => t.kind === "project").map((t) => t.id);
          const workIds = targets.filter((t) => t.kind === "work").map((t) => t.id);
          setMaterials((current) => [
            ...current.filter((m) => !ids.includes(m.id)),
            ...selected.map((m) => ({
              ...m,
              projectIds: [...new Set([...m.projectIds, ...projectIds])],
            })),
          ]);
          setWorks((current) =>
            current.map((w) =>
              workIds.includes(w.id)
                ? {
                    ...w,
                    materialIds: [...new Set([...(w.materialIds || []), ...ids])],
                    files: [
                      ...new Set([
                        ...w.files,
                        ...selected.flatMap((m) => (m.file ? [m.file] : [])),
                      ]),
                    ],
                  }
                : w,
            ),
          );
        }}
        onAdd={(items) => {
          setMaterials((current) => [...current, ...items]);
          if (spaceInitial)
            setWorks((current) =>
              current.map((w) =>
                w.id === spaceInitial
                  ? {
                      ...w,
                      materialIds: [
                        ...new Set([...(w.materialIds || []), ...items.map((i) => i.id)]),
                      ],
                      files: [...w.files, ...items.flatMap((i) => (i.file ? [i.file] : []))],
                    }
                  : w,
              ),
            );
        }}
        onUpdate={onUpdateMaterial}
        onBatchRemove={(ids) => {
          const files = new Set(
            library.filter((m) => ids.includes(m.id) && m.file).map((m) => m.file),
          );
          setMaterials((current) => current.filter((m) => !ids.includes(m.id)));
          setWorks((current) =>
            current.map((w) => ({
              ...w,
              files: w.files.filter((f) => !files.has(f)),
              materialIds: (w.materialIds || []).filter((id) => !ids.includes(id)),
            })),
          );
        }}
        onRemove={onRemoveMaterial}
        onLink={onLinkMaterial}
        initialId={spaceSelected}
      />
    );
  }

  if (space === "Plugin") {
    return (
      <ConversationPlugins
        onReveal={onRevealPanel}
        data={spaceData}
        onChange={setSpaceData}
        onMember={(n) => onOpenSpace("Squadra", "", `person:${n}`)}
      />
    );
  }

  return (
    <ConversationSpace
      onCreateMember={() => onOpenSpace("Nuovo collaboratore")}
      onAssign={onStartAssignment}
      onReveal={onRevealPanel}
      key={spaceVersion}
      view={space}
      data={spaceData}
      onChange={(next) => {
        const removed = spaceData.projects
          .filter((p) => !next.projects.some((n) => n.id === p.id))
          .map((p) => p.id);
        if (removed.length)
          setWorks((current) =>
            current.map((w) =>
              w.projectId && removed.includes(w.projectId) ? { ...w, projectId: "" } : w,
            ),
          );
        if (removed.length)
          setMaterials((current) =>
            current.map((m) => ({
              ...m,
              projectIds: m.projectIds.filter((id) => !removed.includes(id)),
            })),
          );
        const deleted = next.removedPeople || [];
        if (deleted.includes(viewer)) setViewer("Fabio");
        setSpaceData({
          ...next,
          routines: next.routines.map((r) =>
            works.some(
              (w) => w.id === r.workId && deleted.includes(scenarioForWork(w, scenarios).agent),
            )
              ? { ...r, active: false }
              : r,
          ),
        });
      }}
      works={(active
        ? [...works.filter((w) => w.id === active), ...works.filter((w) => w.id !== active)]
        : works
      )
        .filter((w) => !w.coordinatedBy && !w.archived)
        .map((w) => ({
          ...w,
          status: workStatus(w),
          unavailable: !!spaceData.removedPeople?.includes(scenarioForWork(w, scenarios).agent),
        }))}
      onWork={onOpenWork}
      onProjectWork={onCreateFreeWork}
      projectMaterials={library}
      onMaterial={(id) => onOpenSpace("Materiali", "", id)}
      onRun={onRunRoutine}
      initial={spaceInitial}
      selectedId={spaceSelected}
    />
  );
}
