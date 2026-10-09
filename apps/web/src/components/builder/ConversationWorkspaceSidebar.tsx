/**
 * Refined left navigation matching modern Linear/Cursor UI.
 */
import {
  ChevronsUpDown,
  PanelLeft,
  Search,
  SquarePen,
  ListTodo,
  FileText,
  Plus,
  ChevronDown,
  Settings,
  Bell,
  Bot,
  ArrowUpRight,
  Folder,
  MessageSquare,
} from "lucide-react";
import { useState, useCallback, useEffect, type ReactNode } from "react";
import { memberProfile } from "./conversation-members";
import type { ConversationPreferences } from "./conversation-preferences";
import type { ConversationScenario } from "./conversation-scenarios";
import type { SpaceData, SpaceView } from "./ConversationSpace";
import type { Work } from "./conversation-types";
import type { EngineAgentProfile } from "@/lib/engine-agents-client";
import { ConversationHelpPopover } from "./ConversationHelpPopover";
import { ConversationSidebarMoreNav as SidebarMoreNav } from "./ConversationSidebarMoreNav";
import "./sidebar-refined.css";

type Props = {
  engineMode?: boolean;
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
  sidebarWidth?: number;
  onSidebarWidthChange?: (width: number) => void;
};

function groupWorksByDate(items: Work[]) {
  /** Raggruppamento per giorno di calendario locale, sulla data reale del
      motore (updated_at). I work senza data vanno in coda senza inventarne
      una: la suddivisione deve riflettere eventi veri, non l'ordine di lista. */
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const todayStart = startOfDay(new Date());
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const today: Work[] = [];
  const yesterday: Work[] = [];
  const older: Work[] = [];

  items.forEach((w) => {
    if (!w.startedAt) {
      older.push(w);
      return;
    }
    const time = new Date(w.startedAt).getTime();
    if (time >= todayStart) {
      today.push(w);
    } else if (time >= yesterdayStart) {
      yesterday.push(w);
    } else {
      older.push(w);
    }
  });

  return { today, yesterday, older };
}

export function ConversationWorkspaceSidebar({
  engineMode = false,
  engineAgents,
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
  scenarios,
  active,
  onOpenWork,
  workListOpen,
  onToggleWorkList,
  squadListOpen,
  onToggleSquadList,
  preferences,
  onOpenSettings,
  notificationCount = 0,
  onToggleNotifications,
  sidebarWidth = 250,
  onSidebarWidthChange,
}: Props) {
  const [projectsOpen, setProjectsOpen] = useState(true);

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!onSidebarWidthChange) return;
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = sidebarWidth;

      const onMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        const next = Math.min(480, Math.max(180, startWidth + delta));
        onSidebarWidthChange(next);
      };
      const onMouseUp = () => {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [sidebarWidth, onSidebarWidthChange],
  );

  // Clean up any stray listeners if component unmounts during drag
  useEffect(() => {
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  const unassignedWorks = visibleWorks.filter((w) => !w.projectId && !w.coordinatedBy);
  const { today, yesterday, older } = groupWorksByDate(unassignedWorks);
  const docCount = visibleWorks.filter((w) => w.source === "engine" && w.engineLatestArtifact).length;

  const uniqueAgents = scenarios.filter(
    (s, i) =>
      scenarios.findIndex((a) => a.agent === s.agent) === i &&
      !spaceData.removedPeople?.includes(s.agent),
  );
  const activeAgentCount = engineAgents
    ? engineAgents.filter((a) => a.status === "active").length
    : uniqueAgents.length;

  return (
    <aside className="cw-sidebar" hidden={!sidebarOpen} style={{ width: sidebarWidth }}>
      {/* Resize handle */}
      {onSidebarWidthChange && (
        <div className="cw-sb-resize-handle" onMouseDown={handleResizeMouseDown} title="Trascina per ridimensionare" />
      )}
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
          className={`cw-sb-nav-item ${space === "Squadra" ? "active" : ""}`}
          onClick={() => onOpenSpace("Squadra")}
        >
          <div className="cw-sb-item-left">
            <Bot size={15} />
            <span>Squadra</span>
          </div>
          {activeAgentCount > 0 && <span className="cw-sb-count">{activeAgentCount}</span>}
        </button>

        <button
          className={`cw-sb-nav-item ${space === "Documenti" || space === "Materiali" ? "active" : ""}`}
          onClick={() => onOpenSpace("Documenti")}
        >
          <div className="cw-sb-item-left">
            <FileText size={15} />
            <span>Documenti</span>
          </div>
          {((docCount || 0) + (libraryCount || 0)) > 0 && (
            <span className="cw-sb-count">{(docCount || 0) + (libraryCount || 0)}</span>
          )}
        </button>

        <SidebarMoreNav
          engineMode={engineMode}
          space={space}
          onOpenSpace={onOpenSpace}
          routineCount={routineCount}
        />
      </div>

      {/* Scrollable Project, Work, and Agents List */}
      <div className="cw-sb-scroll-area">
        {/* Projects section */}
        <div className="cw-sb-section-header">
          <div
            className="cw-sb-section-title-wrap"
            onClick={() => setProjectsOpen(!projectsOpen)}
            title={projectsOpen ? "Comprimi progetti" : "Espandi progetti"}
          >
            <span>Progetti · {spaceData.projects.length}</span>
            <ChevronDown
              size={12}
              style={{
                transform: projectsOpen ? "none" : "rotate(-90deg)",
                transition: "transform 0.15s ease",
              }}
            />
          </div>
          <button
            aria-label="Nuovo progetto"
            title="Nuovo progetto"
            onClick={(e) => {
              e.stopPropagation();
              onOpenSpace("Progetti", "", "new");
            }}
          >
            <Plus size={13} />
          </button>
        </div>

        {projectsOpen && (
          <div>
            {spaceData.projects.map((p) => {
              const count = works.filter((w) => w.projectId === p.id).length;
              const isActive = space === "Progetti" && active === p.id;
              return (
                <button
                  key={p.id}
                  className={`cw-sb-row ${isActive ? "active" : ""}`}
                  onClick={() => onOpenSpace("Progetti", "", p.id)}
                >
                  <div className="cw-sb-item-left">
                    <Folder size={13} style={{ color: isActive ? "#18181b" : "#71717a", flexShrink: 0 }} />
                    <span className="cw-sb-row-title">{p.name}</span>
                  </div>
                  {count > 0 && <span className="cw-sb-count">{count}</span>}
                </button>
              );
            })}
          </div>
        )}

        {/* Unassigned Conversations Section */}
        <div className="cw-sb-section-header" onClick={onToggleWorkList}>
          <div className="cw-sb-section-title-wrap">
            <span>Senza progetto · {unassignedWorks.length}</span>
            <ChevronDown
              size={12}
              style={{
                transform: workListOpen ? "none" : "rotate(-90deg)",
                transition: "transform 0.15s ease",
              }}
            />
          </div>
        </div>

        {workListOpen && (
          <div>
            {today.length > 0 && (
              <>
                <div className="cw-sb-date-label">Oggi</div>
                {today.map((w) => (
                  <button
                    key={w.id}
                    className={`cw-sb-row ${w.id === active ? "active" : ""}`}
                    onClick={() => onOpenWork(w.id)}
                  >
                    <div className="cw-sb-item-left">
                      <MessageSquare size={13} style={{ color: w.id === active ? "#18181b" : "#71717a", flexShrink: 0 }} />
                      <span className="cw-sb-row-title">{w.title}</span>
                    </div>
                  </button>
                ))}
              </>
            )}

            {yesterday.length > 0 && (
              <>
                <div className="cw-sb-date-label">Ieri</div>
                {yesterday.map((w) => (
                  <button
                    key={w.id}
                    className={`cw-sb-row ${w.id === active ? "active" : ""}`}
                    onClick={() => onOpenWork(w.id)}
                  >
                    <div className="cw-sb-item-left">
                      <MessageSquare size={13} style={{ color: w.id === active ? "#18181b" : "#71717a", flexShrink: 0 }} />
                      <span className="cw-sb-row-title">{w.title}</span>
                    </div>
                  </button>
                ))}
              </>
            )}

            {older.length > 0 && (
              <>
                <div className="cw-sb-date-label">Precedenti</div>
                {older.map((w) => (
                  <button
                    key={w.id}
                    className={`cw-sb-row ${w.id === active ? "active" : ""}`}
                    onClick={() => onOpenWork(w.id)}
                  >
                    <div className="cw-sb-item-left">
                      <MessageSquare size={13} style={{ color: w.id === active ? "#18181b" : "#71717a", flexShrink: 0 }} />
                      <span className="cw-sb-row-title">{w.title}</span>
                    </div>
                  </button>
                ))}
              </>
            )}
          </div>
        )}

        {/* Squadra list */}
        <div className="cw-sb-section-header" onClick={onToggleSquadList}>
          <div className="cw-sb-section-title-wrap">
            <span>Squadra · {activeAgentCount}</span>
            <ChevronDown
              size={12}
              style={{
                transform: squadListOpen ? "none" : "rotate(-90deg)",
                transition: "transform 0.15s ease",
              }}
            />
          </div>
          <button
            aria-label="Tutti i collaboratori"
            title="Tutti i collaboratori"
            onClick={(e) => {
              e.stopPropagation();
              onOpenSpace("Squadra");
            }}
          >
            <ArrowUpRight size={13} />
          </button>
        </div>

        {squadListOpen && (
          <div>
            {engineAgents &&
              engineAgents
                .filter((agent) => agent.status === "active")
                .map((agent) => (
                  <button
                    key={agent.id}
                    className="cw-sb-row"
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent("homun:inspect-agent", { detail: agent })
                      )
                    }
                    title={`Visualizza scheda di ${agent.name}`}
                  >
                    <div className="cw-sb-item-left">
                      <span className="cw-sb-dot" style={{ backgroundColor: "#10b981" }} />
                      <span className="cw-sb-row-title">{agent.name}</span>
                    </div>
                    {agent.role && <span className="cw-sb-role-sub">{agent.role}</span>}
                  </button>
                ))}
            {engineAgents && engineAgents.filter((a) => a.status === "active").length === 0 && (
              <div className="cw-sb-empty-sub">Nessun collaboratore attivo</div>
            )}
            {!engineAgents &&
              uniqueAgents.map((s) => (
                <button
                  key={s.agent}
                  className="cw-sb-row"
                  onClick={() => onOpenSpace("Squadra", "", `person:${s.agent}`)}
                  title={`Visualizza ${s.agent}`}
                >
                  <div className="cw-sb-item-left">
                    <span className="cw-sb-dot" style={{ backgroundColor: "#10b981" }} />
                    <span className="cw-sb-row-title">{s.agent}</span>
                  </div>
                  <span className="cw-sb-role-sub">{memberProfile(s.agent, spaceData.profiles).role}</span>
                </button>
              ))}
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
        </button>
        <div className="cw-sb-footer-actions">
          {onToggleNotifications && (
            <button
              type="button"
              className="cw-sb-footer-btn"
              aria-label={`Notifiche${notificationCount ? ` · ${notificationCount} aggiornamenti` : ""}`}
              onClick={onToggleNotifications}
              title="Notifiche"
            >
              <Bell size={15} />
              {!!notificationCount && <span className="cw-sb-notif-badge">{notificationCount}</span>}
            </button>
          )}
          <button className="cw-sb-footer-btn" onClick={onOpenSettings} title="Impostazioni dello spazio">
            <Settings size={15} />
          </button>
          <ConversationHelpPopover
            engineMode={engineMode}
            onOpenSettings={onOpenSettings}
            onSearchOpen={onSearchOpen}
            searchShortcut={searchShortcut}
          />
        </div>
      </div>
    </aside>
  );
}
