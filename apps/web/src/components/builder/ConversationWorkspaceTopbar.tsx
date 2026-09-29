/**
 * Top bar for the simulated workspace shell.
 * Displays current space/conversation context and contextual viewer controls.
 */

import type { ReactNode } from "react";
import { PanelRightClose, FileText, Layers, Users, Bot, User, Plus, List, Columns3, Calendar } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@homun/ui/components/popover";
import { ConversationSelectField } from "./ConversationSelect";
import { isHumanMember, memberProfile } from "./conversation-members";
import type { ConversationPreferences } from "./conversation-preferences";
import { spacePeople, type SpaceData, type SpaceView } from "./ConversationSpace";
import type { Work } from "./conversation-types";
import { ConversationWorkspaceHistoryMenu } from "./ConversationWorkspaceHistoryMenu";
import { ConversationAvatar } from "./ConversationAvatar";
import type { ConversationScenario } from "./conversation-scenarios";

type Props = {
  engineMode?: boolean;
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  space: SpaceView | null;
  work: Work | null | undefined;
  preferences: ConversationPreferences;
  viewer: string;
  onViewerChange: (viewer: string) => void;
  spaceData: SpaceData;
  works?: Work[];
  onOpenWork?: (id: string | null) => void;
  onNewConversation?: () => void;
  spaceInitial?: string;
  onOpenSpace?: (space: SpaceView, initial?: string, selected?: string) => void;
  scenario?: ConversationScenario | null;
  scenarios?: (ConversationScenario & { custom?: boolean })[];
  workActions?: ReactNode;
};

function getWorkAgents(
  work: Work | null | undefined,
  scenario: ConversationScenario | null | undefined,
  scenarios?: (ConversationScenario & { custom?: boolean })[],
  profiles?: Record<string, { role?: string; responsibilities?: string; specialization?: string }>,
) {
  if (!work) return [];
  const map = new Map<string, {
    name: string;
    isCoordinator: boolean;
    role: string;
    description: string;
    steps: string[];
  }>();

  if (scenario?.agent) {
    map.set(scenario.agent, {
      name: scenario.agent,
      isCoordinator: true,
      role: scenario.role || "Coordinatore del lavoro",
      description: scenario.outcome || scenario.help || "Coordina l'esecuzione del lavoro e supervisiona i passaggi.",
      steps: [],
    });
  }

  if (work.catalogPlan?.steps) {
    for (const step of work.catalogPlan.steps) {
      if (step.agent) {
        const existing = map.get(step.agent);
        if (existing) {
          if (!existing.steps.includes(step.title)) existing.steps.push(step.title);
        } else {
          const sc = scenarios?.find((s) => s.agent === step.agent);
          const prof = profiles?.[step.agent];
          map.set(step.agent, {
            name: step.agent,
            isCoordinator: false,
            role: sc?.role || prof?.role || "Specialista",
            description: sc?.outcome || sc?.help || prof?.responsibilities || prof?.specialization || "Esegue passaggi specifici del piano di lavoro.",
            steps: [step.title],
          });
        }
      }
    }
  }

  if (work.enginePlan) {
    for (const step of work.enginePlan) {
      const name = step.assignee_id || (step as any).agent_name || (step as any).agent;
      if (name) {
        const existing = map.get(name);
        if (existing) {
          if (!existing.steps.includes(step.title)) existing.steps.push(step.title);
        } else {
          const sc = scenarios?.find((s) => s.agent === name);
          const prof = profiles?.[name];
          map.set(name, {
            name,
            isCoordinator: false,
            role: sc?.role || prof?.role || step.capability || "Specialista",
            description: sc?.outcome || sc?.help || prof?.responsibilities || prof?.specialization || "Esegue passaggi specifici del piano di lavoro.",
            steps: [step.title],
          });
        }
      }
    }
  }

  return Array.from(map.values());
}

export function ConversationWorkspaceTopbar({
  engineMode = false,
  sidebarOpen,
  onOpenSidebar,
  space,
  work,
  preferences,
  viewer,
  onViewerChange,
  spaceData,
  works = [],
  onOpenWork,
  onNewConversation,
  spaceInitial,
  onOpenSpace,
  scenario,
  scenarios = [],
  workActions,
}: Props) {
  const involvedAgents = getWorkAgents(work, scenario, scenarios, spaceData.profiles);
  const humanViewers = [...new Set([...spacePeople, ...Object.keys(spaceData.profiles || {})])]
    .filter(
      (n) =>
        isHumanMember(n, spaceData.profiles) &&
        !spaceData.removedPeople?.includes(n) &&
        memberProfile(n, spaceData.profiles).invitation !== "pending",
    );

  return (
    <header className="cw-topbar">
      <div className="ph-topbar-breadcrumb-group">
        {!sidebarOpen && (
          <button
            className="cw-icon"
            aria-label="Apri barra laterale"
            title="Apri barra laterale"
            onClick={onOpenSidebar}
          >
            <PanelRightClose size={19} />
          </button>
        )}
        {space ? (
          <span className="ph-breadcrumb-root">{space}</span>
        ) : onOpenWork && onNewConversation ? (
          <ConversationWorkspaceHistoryMenu
            activeWork={work}
            works={works}
            onOpenWork={onOpenWork}
            onNewConversation={onNewConversation}
          />
        ) : work ? (
          <span className="ph-topbar-name">{work.title}</span>
        ) : (
          <span className="ph-breadcrumb-root">{preferences.spaceName}</span>
        )}
      </div>

      <div className="ph-topbar-contextual">
        {space === "Documenti" && onOpenSpace && (
          <div className="ph-icon-tabs" role="tablist" aria-label="Sezioni documenti">
            <button
              role="tab"
              aria-selected={spaceInitial !== "materials"}
              title="Documenti prodotti"
              className={`ph-icon-tab ${spaceInitial !== "materials" ? "is-active" : ""}`}
              onClick={() => onOpenSpace("Documenti", "documents")}
            >
              <FileText size={15} />
            </button>
            <button
              role="tab"
              aria-selected={spaceInitial === "materials"}
              title="File & Materiali di lavoro"
              className={`ph-icon-tab ${spaceInitial === "materials" ? "is-active" : ""}`}
              onClick={() => onOpenSpace("Documenti", "materials")}
            >
              <Layers size={15} />
            </button>
          </div>
        )}

        {space === "Squadra" && onOpenSpace && (
          <div className="ph-icon-tabs" role="tablist" aria-label="Filtro squadra">
            <button
              role="tab"
              aria-selected={!spaceInitial || spaceInitial === "all"}
              title="Tutti i collaboratori"
              className={`ph-icon-tab ${!spaceInitial || spaceInitial === "all" ? "is-active" : ""}`}
              onClick={() => onOpenSpace("Squadra", "all")}
            >
              <Users size={15} />
            </button>
            <button
              role="tab"
              aria-selected={spaceInitial === "agents"}
              title="Solo agenti AI"
              className={`ph-icon-tab ${spaceInitial === "agents" ? "is-active" : ""}`}
              onClick={() => onOpenSpace("Squadra", "agents")}
            >
              <Bot size={15} />
            </button>
            <button
              role="tab"
              aria-selected={spaceInitial === "humans"}
              title="Solo persone"
              className={`ph-icon-tab ${spaceInitial === "humans" ? "is-active" : ""}`}
              onClick={() => onOpenSpace("Squadra", "humans")}
            >
              <User size={15} />
            </button>
            <span className="ph-topbar-sep" aria-hidden="true" />
            <button
              className="ph-icon-tab"
              title="Invita una nuova persona nella squadra"
              onClick={() => onOpenSpace("Nuovo collaboratore")}
            >
              <Plus size={15} />
            </button>
          </div>
        )}

        {space === "Compiti" && onOpenSpace && (
          <div className="ph-icon-tabs" role="tablist" aria-label="Viste compiti">
            <button
              role="tab"
              aria-selected={!spaceInitial || spaceInitial === "list" || spaceInitial === "Elenco"}
              title="Vista elenco"
              className={`ph-icon-tab ${!spaceInitial || spaceInitial === "list" || spaceInitial === "Elenco" ? "is-active" : ""}`}
              onClick={() => onOpenSpace("Compiti", "Elenco")}
            >
              <List size={15} />
            </button>
            <button
              role="tab"
              aria-selected={spaceInitial === "kanban" || spaceInitial === "Kanban"}
              title="Vista kanban"
              className={`ph-icon-tab ${spaceInitial === "kanban" || spaceInitial === "Kanban" ? "is-active" : ""}`}
              onClick={() => onOpenSpace("Compiti", "Kanban")}
            >
              <Columns3 size={15} />
            </button>
            <button
              role="tab"
              aria-selected={spaceInitial === "calendar" || spaceInitial === "Calendario"}
              title="Vista calendario"
              className={`ph-icon-tab ${spaceInitial === "calendar" || spaceInitial === "Calendario" ? "is-active" : ""}`}
              onClick={() => onOpenSpace("Compiti", "Calendario")}
            >
              <Calendar size={15} />
            </button>
          </div>
        )}

        {!space && work && (
          <div className="ph-topbar-work-actions">
            {involvedAgents.length > 0 && (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="ph-coordinator-btn"
                    aria-label={`Agenti in questa chat: ${involvedAgents.length}`}
                    title={`Agenti in questa chat (${involvedAgents.length}): clicca per dettagli`}
                  >
                    <ConversationAvatar
                      name={scenario?.agent || involvedAgents[0]?.name || "Homun"}
                      human={isHumanMember(scenario?.agent || involvedAgents[0]?.name || "Homun", spaceData.profiles)}
                    />
                    {involvedAgents.length > 1 && (
                      <span className="ph-agent-count-badge">+{involvedAgents.length - 1}</span>
                    )}
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" className="cw-agent-team-popover">
                  <div className="cw-agent-popover-header">
                    <strong>Squadra del lavoro</strong>
                    <span>
                      {involvedAgents.length === 1
                        ? "1 agente assegnato"
                        : `${involvedAgents.length} agenti coinvolti`}
                    </span>
                  </div>
                  <div className="cw-agent-popover-list">
                    {involvedAgents.map((ag) => (
                      <div key={ag.name} className="cw-agent-popover-item">
                        <ConversationAvatar
                          name={ag.name}
                          human={isHumanMember(ag.name, spaceData.profiles)}
                        />
                        <div className="cw-agent-popover-info">
                          <div className="cw-agent-popover-name-row">
                            <strong>{ag.name}</strong>
                            <span className={`cw-agent-popover-badge ${ag.isCoordinator ? "is-coord" : ""}`}>
                              {ag.isCoordinator ? "Coordinatore" : "Specialista"}
                            </span>
                          </div>
                          <p className="cw-agent-popover-role">{ag.role}</p>
                          {ag.description && (
                            <p className="cw-agent-popover-desc">{ag.description}</p>
                          )}
                          {ag.steps.length > 0 && (
                            <div className="cw-agent-popover-steps">
                              <small>Passaggi assegnati:</small>
                              <ul>
                                {ag.steps.map((st) => (
                                  <li key={st}>{st}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="cw-agent-popover-footer">
                    <span>
                      {work.autonomy === "autonomous"
                        ? "Esecuzione autonoma"
                        : "Sotto supervisione umana"}
                    </span>
                  </div>
                </PopoverContent>
              </Popover>
            )}
            {workActions}
          </div>
        )}

        {!engineMode && (
          <label className="cw-viewer" style={{ margin: 0, fontSize: "11px" }}>
            <ConversationSelectField
              aria-label="Vista utente demo"
              value={viewer}
              onChange={(e) => onViewerChange(e.target.value)}
            >
              {humanViewers.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </ConversationSelectField>
          </label>
        )}
      </div>
    </header>
  );
}
