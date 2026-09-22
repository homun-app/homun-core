/**
 * Left navigation for the simulated conversation workspace.
 */

import { ArrowLeft, ArrowUpRight, ChevronDown, PanelRightOpen, Plus, Search, Settings2 } from "lucide-react";
import type { ReactNode } from "react";
import { ConversationAvatar } from "./ConversationAvatar";
import { ConversationProjectNav } from "./ConversationProjectNav";
import { isHumanMember, memberProfile } from "./conversation-members";
import type { ConversationPreferences } from "./conversation-preferences";
import { scenarioForWork, type ConversationScenario } from "./conversation-scenarios";
import type { SpaceData, SpaceView } from "./ConversationSpace";
import type { Work } from "./conversation-types";

import type { EngineAgentProfile } from "@/lib/engine-agents-client";
type Props = {
  engineAgents?: EngineAgentProfile[] | undefined;
  sidebarOpen: boolean;
  searchShortcut: string;
  onSearchOpen: () => void;
  onCloseSidebar: () => void;
  onNewConversation: () => void;
  space: SpaceView | null;
  onOpenSpace: (view: SpaceView, initial?: string, selected?: string) => void;
  spaceData: SpaceData;
  libraryCount: number | null;
  routineCount?: number | null;
  visibleWorks: Work[];
  works: Work[];
  scenarios: ConversationScenario[];
  active: string | null;
  onOpenWork: (id: string | null) => void;
  onMoveConversation: (id: string, projectId: string) => void;
  conversationActions: (w: Work) => ReactNode;
  workStatus: (w: Work) => string;
  workListOpen: boolean;
  onToggleWorkList: () => void;
  squadListOpen: boolean;
  onToggleSquadList: () => void;
  preferences: ConversationPreferences;
  onOpenSettings: () => void;
};

const SPACE_LINKS: SpaceView[] = ["Compiti", "Materiali", "Documenti", "Automazioni", "Plugin"];

function spaceLinkCount(
  view: SpaceView,
  spaceData: SpaceData,
  libraryCount: number | null,
  routineCount: number | null,
  visibleWorks: Work[],
): number | null {
  switch (view) {
    case "Squadra":
      return spaceData.teams.length;
    case "Progetti":
      return spaceData.projects.length;
    case "Automazioni":
      return routineCount ?? spaceData.routines.length;
    case "Materiali":
      return libraryCount;
    case "Documenti":
      return visibleWorks.filter((w) => w.source === "engine" && w.engineLatestArtifact).length;
    case "Compiti":
      return visibleWorks.length;
    case "Plugin":
      return (spaceData.installedPlugins || []).length;
    case "Nuovo collaboratore":
      return 0;
    default: {
      const _exhaustive: never = view;
      return _exhaustive;
    }
  }
}

export function ConversationWorkspaceSidebar({
  engineAgents, sidebarOpen,
  searchShortcut,
  onSearchOpen,
  onCloseSidebar,
  onNewConversation,
  space,
  onOpenSpace,
  spaceData,
  libraryCount,
  routineCount = null,
  visibleWorks,
  works,
  scenarios,
  active,
  onOpenWork,
  onMoveConversation,
  conversationActions,
  workStatus,
  workListOpen,
  onToggleWorkList,
  squadListOpen,
  onToggleSquadList,
  preferences,
  onOpenSettings,
}: Props) {
  const uniqueAgents = scenarios.filter(
    (s, i) =>
      scenarios.findIndex((a) => a.agent === s.agent) === i &&
      !spaceData.removedPeople?.includes(s.agent),
  );

  return (
    <aside className="cw-sidebar" hidden={!sidebarOpen}>
      <div className="cw-sidebar-fixed">
        <div className="cw-sidebar-tools">
          <button
            aria-label="Cerca ovunque"
            title={`Cerca ovunque (${searchShortcut})`}
            onClick={onSearchOpen}
          >
            <Search size={18} />
            <kbd>{searchShortcut}</kbd>
          </button>
          <button
            aria-label="Chiudi barra laterale"
            title="Chiudi barra laterale"
            onClick={onCloseSidebar}
          >
            <PanelRightOpen size={18} />
          </button>
        </div>
        <button className="cw-new" onClick={onNewConversation}>
          <Plus size={17} /> Nuova conversazione
        </button>
      </div>
      <div className="cw-sidebar-scroll">
        <div className="cs-space-links">
          {SPACE_LINKS.map((v) => (
            <button className={space === v ? "active" : ""} key={v} onClick={() => onOpenSpace(v)}>
              {v}
              {!(v === "Materiali" && libraryCount === null) && <span>{spaceLinkCount(v, spaceData, libraryCount, routineCount, visibleWorks)}</span>}
            </button>
          ))}
        </div>
        <ConversationProjectNav
          projects={spaceData.projects}
          works={visibleWorks.filter((w) => !w.coordinatedBy)}
          onProject={(id) => onOpenSpace("Progetti", "", id)}
          onWork={onOpenWork}
          onAll={() => onOpenSpace("Progetti")}
          onMove={onMoveConversation}
          actions={(id) => {
            const w = works.find((item) => item.id === id);
            return w ? conversationActions(w) : null;
          }}
        />
        <button
          className="cw-nav-label cw-section-toggle"
          aria-label="Lavori"
          aria-expanded={workListOpen}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("application/homun-work")) e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
            onMoveConversation(e.dataTransfer.getData("application/homun-work"), "");
          }}
          aria-controls="cw-sidebar-works"
          onClick={onToggleWorkList}
        >
          <span>Senza progetto</span>
          <span className="cw-section-count">
            {visibleWorks.filter((w) => !w.projectId && !w.coordinatedBy).length}
          </span>
          <ChevronDown size={14} className="cw-section-chevron" aria-hidden="true" />
        </button>
        <nav
          id="cw-sidebar-works"
          hidden={!workListOpen}
          className="cw-work-list"
          aria-label="Conversazioni"
        >
          {visibleWorks
            .filter((w) => !w.projectId && !w.coordinatedBy)
            .map((w) => {
              const chrome = scenarioForWork(w, scenarios);
              return (
              <div
                key={w.id}
                className="cv-chat-nav-row"
                draggable
                onDragStart={(e) => e.dataTransfer.setData("application/homun-work", w.id)}
              >
                <button className={w.id === active ? "selected" : ""} onClick={() => onOpenWork(w.id)}>
                  <ConversationAvatar
                    name={chrome.agent}
                    human={isHumanMember(chrome.agent, spaceData.profiles)}
                  />
                  <span>
                    {w.title}
                    <small>{workStatus(w)}</small>
                  </span>
                  {(w.phase === "waiting" || w.phase === "review") && <i />}
                </button>
                {conversationActions(w)}
              </div>
            );
            })}
          {(spaceData.detachedChats || []).map((c) => (
            <button key={c.id} onClick={() => onOpenSpace("Progetti", "", "loose:" + c.id)}>
              {c.title}
            </button>
          ))}
          {!works.some((w) => !w.projectId) && !spaceData.detachedChats?.length && (
            <p className="cw-nav-empty">Nessun lavoro senza progetto</p>
          )}
        </nav>
        <button
          className="cw-nav-label cw-section-toggle"
          aria-label="Squadra"
          aria-expanded={squadListOpen}
          aria-controls="cw-sidebar-squad"
          onClick={onToggleSquadList}
        >
          <span>Squadra</span>
          <span className="cw-section-count">{engineAgents ? engineAgents.filter(agent => agent.status === "active").length : uniqueAgents.length}</span>
          <ChevronDown size={14} className="cw-section-chevron" aria-hidden="true" />
        </button>
        <div id="cw-sidebar-squad" hidden={!squadListOpen} className="cw-team">
          <button className="cv-manage-team" onClick={() => onOpenSpace("Squadra")}>
            Tutti i collaboratori e team <ArrowUpRight size={14} />
          </button>
          {engineAgents && engineAgents.filter(agent => agent.status === "active").map(agent => <button key={agent.id} onClick={() => onOpenSpace("Squadra", "", agent.id)}><ConversationAvatar name={agent.name}/><span>{agent.name}<small>{agent.role}</small></span></button>)}
          {engineAgents?.length === 0 && <p className="cw-nav-empty">I collaboratori che confermi compariranno qui.</p>}
          {!engineAgents && uniqueAgents.map((s) => (
            <button key={s.agent} onClick={() => onOpenSpace("Squadra", "", `person:${s.agent}`)}>
              <ConversationAvatar
                name={s.agent}
                human={isHumanMember(s.agent, spaceData.profiles)}
              />
              <span>
                {s.agent}
                <small>{memberProfile(s.agent, spaceData.profiles).role}</small>
              </span>
              <ArrowUpRight size={14} />
            </button>
          ))}
        </div>
      </div>
      <div className="cw-sidebar-foot">
        <a href="http://127.0.0.1:4182/prototypes/first-work.html">
          <ArrowLeft size={14} /> Versione precedente
        </a>
        <button aria-label="Impostazioni dello spazio" onClick={onOpenSettings}>
          <span className="cw-user">{preferences.displayName.slice(0, 1)}</span>
          <span>
            {preferences.displayName}
            <small>{preferences.spaceName}</small>
          </span>
          <Settings2 size={17} />
        </button>
      </div>
    </aside>
  );
}
