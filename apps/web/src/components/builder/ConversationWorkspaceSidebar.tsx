/**
 * Refined left navigation matching modern Linear/Cursor UI.
 */
import {
  ChevronsUpDown,
  PanelLeft,
  Search,
  SquarePen,
  ListTodo,
  Layers,
  FileText,
  Zap,
  Puzzle,
  Radio,
  Plus,
  ChevronDown,
  Settings,
} from "lucide-react";
import type { ReactNode } from "react";
import type { ConversationPreferences } from "./conversation-preferences";
import type { ConversationScenario } from "./conversation-scenarios";
import type { SpaceData, SpaceView } from "./ConversationSpace";
import type { Work } from "./conversation-types";
import type { EngineAgentProfile } from "@/lib/engine-agents-client";
import "./sidebar-refined.css";

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
  notificationCount?: number | undefined;
  onToggleNotifications?: (() => void) | undefined;
};

const PROJECT_DOTS = ["#16a34a", "#f97316", "#0ea5e9", "#8b5cf6", "#ec4899", "#eab308"];
const WORK_DOTS = ["#f97316", "#0ea5e9", "#16a34a", "#94a3b8", "#a855f7", "#ec4899"];

function groupWorksByDate(items: Work[]) {
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  const today: Work[] = [];
  const yesterday: Work[] = [];
  const older: Work[] = [];

  items.forEach((w, i) => {
    const time = w.startedAt ? new Date(w.startedAt).getTime() : now - i * (8 * 60 * 60 * 1000);
    const diff = now - time;
    if (diff < oneDay) {
      today.push(w);
    } else if (diff < 2 * oneDay) {
      yesterday.push(w);
    } else {
      older.push(w);
    }
  });

  return { today, yesterday, older };
}

export function ConversationWorkspaceSidebar({
  sidebarOpen,
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
  active,
  onOpenWork,
  workListOpen,
  onToggleWorkList,
  preferences,
  onOpenSettings,
}: Props) {
  const unassignedWorks = visibleWorks.filter((w) => !w.projectId && !w.coordinatedBy);
  const { today, yesterday, older } = groupWorksByDate(unassignedWorks);
  const docCount = visibleWorks.filter((w) => w.source === "engine" && w.engineLatestArtifact).length;

  return (
    <aside className="cw-sidebar" hidden={!sidebarOpen}>
      {/* Brand Header */}
      <div className="cw-sb-brand-row">
        <div className="cw-sb-brand-left" onClick={() => onOpenSpace("Progetti")} title="Spazio di lavoro">
          <span className="cw-sb-badge">H</span>
          <span className="cw-sb-brand-title">Homun</span>
          <ChevronsUpDown size={12} className="cw-sb-brand-chevron" />
        </div>
        <button
          className="cw-sb-toggle-btn"
          aria-label="Chiudi barra laterale"
          title="Chiudi barra laterale"
          onClick={onCloseSidebar}
        >
          <PanelLeft size={16} />
        </button>
      </div>

      {/* Quick Search */}
      <div className="cw-sb-search" onClick={onSearchOpen} title={`Cerca ovunque (${searchShortcut})`}>
        <Search size={14} className="cw-sb-search-icon" />
        <span className="cw-sb-search-text">Cerca</span>
        <kbd className="cw-sb-search-kbd">{searchShortcut}</kbd>
      </div>

      {/* New conversation button */}
      <button className="cw-sb-new-btn" onClick={onNewConversation}>
        <SquarePen size={15} />
        <span>Nuova conversazione</span>
      </button>

      {/* Main navigation spaces */}
      <div className="cw-sb-nav-group">
        <button
          className={`cw-sb-nav-item ${space === "Compiti" ? "active" : ""}`}
          onClick={() => onOpenSpace("Compiti")}
        >
          <div className="cw-sb-item-left">
            <ListTodo size={15} />
            <span>Compiti</span>
          </div>
          {visibleWorks.length > 0 && <span className="cw-sb-count">{visibleWorks.length}</span>}
        </button>

        <button
          className={`cw-sb-nav-item ${space === "Materiali" ? "active" : ""}`}
          onClick={() => onOpenSpace("Materiali")}
        >
          <div className="cw-sb-item-left">
            <Layers size={15} />
            <span>Materiali</span>
          </div>
          {libraryCount !== null && libraryCount > 0 && <span className="cw-sb-count">{libraryCount}</span>}
        </button>

        <button
          className={`cw-sb-nav-item ${space === "Documenti" ? "active" : ""}`}
          onClick={() => onOpenSpace("Documenti")}
        >
          <div className="cw-sb-item-left">
            <FileText size={15} />
            <span>Documenti</span>
          </div>
          {docCount > 0 && <span className="cw-sb-count">{docCount}</span>}
        </button>

        <button
          className={`cw-sb-nav-item ${space === "Automazioni" ? "active" : ""}`}
          onClick={() => onOpenSpace("Automazioni")}
        >
          <div className="cw-sb-item-left">
            <Zap size={15} />
            <span>Automazioni</span>
          </div>
          {routineCount !== null && routineCount > 0 && <span className="cw-sb-count">{routineCount}</span>}
        </button>

        <button
          className={`cw-sb-nav-item ${space === "Plugin" ? "active" : ""}`}
          onClick={() => onOpenSpace("Plugin")}
        >
          <div className="cw-sb-item-left">
            <Puzzle size={15} />
            <span>Plugin</span>
          </div>
        </button>

        <button
          className={`cw-sb-nav-item ${space === "Canali" ? "active" : ""}`}
          onClick={() => onOpenSpace("Canali")}
        >
          <div className="cw-sb-item-left">
            <Radio size={15} />
            <span>Canali</span>
          </div>
        </button>
      </div>

      {/* Scrollable Project and Work List */}
      <div className="cw-sb-scroll-area">
        {/* Projects section */}
        <div className="cw-sb-section-header">
          <span onClick={() => onOpenSpace("Progetti")}>Progetti</span>
          <button aria-label="Nuovo progetto" title="Nuovo progetto" onClick={() => onOpenSpace("Progetti", "", "new")}>
            <Plus size={13} />
          </button>
        </div>
        {spaceData.projects.map((p, idx) => {
          const count = works.filter((w) => w.projectId === p.id).length;
          const isActive = space === "Progetti" && active === p.id;
          return (
            <button
              key={p.id}
              className={`cw-sb-row ${isActive ? "active" : ""}`}
              onClick={() => onOpenSpace("Progetti", "", p.id)}
            >
              <div className="cw-sb-item-left">
                <span className="cw-sb-dot" style={{ backgroundColor: PROJECT_DOTS[idx % PROJECT_DOTS.length] }} />
                <span className="cw-sb-row-title">{p.name}</span>
              </div>
              {count > 0 && <span className="cw-sb-count">{count}</span>}
            </button>
          );
        })}

        {/* Unassigned Conversations Section */}
        <div className="cw-sb-section-header" onClick={onToggleWorkList}>
          <span>Senza progetto · {unassignedWorks.length}</span>
          <ChevronDown
            size={12}
            style={{
              transform: workListOpen ? "none" : "rotate(-90deg)",
              transition: "transform 0.15s ease",
            }}
          />
        </div>

        {workListOpen && (
          <div>
            {today.length > 0 && (
              <>
                <div className="cw-sb-date-label">Oggi</div>
                {today.map((w, i) => (
                  <button
                    key={w.id}
                    className={`cw-sb-row ${w.id === active ? "active" : ""}`}
                    onClick={() => onOpenWork(w.id)}
                  >
                    <div className="cw-sb-item-left">
                      <span className="cw-sb-dot" style={{ backgroundColor: WORK_DOTS[i % WORK_DOTS.length] }} />
                      <span className="cw-sb-row-title">{w.title}</span>
                    </div>
                  </button>
                ))}
              </>
            )}

            {yesterday.length > 0 && (
              <>
                <div className="cw-sb-date-label">Ieri</div>
                {yesterday.map((w, i) => (
                  <button
                    key={w.id}
                    className={`cw-sb-row ${w.id === active ? "active" : ""}`}
                    onClick={() => onOpenWork(w.id)}
                  >
                    <div className="cw-sb-item-left">
                      <span className="cw-sb-dot" style={{ backgroundColor: WORK_DOTS[(i + 2) % WORK_DOTS.length] }} />
                      <span className="cw-sb-row-title">{w.title}</span>
                    </div>
                  </button>
                ))}
              </>
            )}

            {older.length > 0 && (
              <>
                <div className="cw-sb-date-label">Settimana scorsa</div>
                {older.map((w, i) => (
                  <button
                    key={w.id}
                    className={`cw-sb-row ${w.id === active ? "active" : ""}`}
                    onClick={() => onOpenWork(w.id)}
                  >
                    <div className="cw-sb-item-left">
                      <span className="cw-sb-dot" style={{ backgroundColor: WORK_DOTS[(i + 4) % WORK_DOTS.length] }} />
                      <span className="cw-sb-row-title">{w.title}</span>
                    </div>
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {/* User profile footer */}
      <div className="cw-sb-footer">
        <button className="cw-sb-profile-btn" onClick={onOpenSettings} title="Impostazioni dello spazio">
          <span className="cw-sb-avatar">{preferences.displayName.slice(0, 1)}</span>
          <div className="cw-sb-user-text">
            <span className="cw-sb-username">{preferences.displayName}</span>
            <span className="cw-sb-spacename">{preferences.spaceName}</span>
          </div>
          <Settings size={15} className="cw-sb-settings-icon" />
        </button>
      </div>
    </aside>
  );
}
