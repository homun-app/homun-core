/**
 * Top bar and notification tray for the simulated workspace shell.
 */

import { ArrowUpRight, Bell, PanelRightClose, PanelRightOpen, Settings2, X } from "lucide-react";
import { defaultLocalActor } from "@/lib/engine-domain-client";
import { ConversationSelectField } from "./ConversationSelect";
import { isHumanMember, memberProfile } from "./conversation-members";
import type { ConversationPreferences } from "./conversation-preferences";
import { scenarioForWork, type ConversationScenario } from "./conversation-scenarios";
import { spacePeople, type SpaceData, type SpaceView } from "./ConversationSpace";
import type { Work } from "./conversation-types";

type Props = {
  engineMode?: boolean;
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  space: SpaceView | null;
  work: Work | null | undefined;
  preferences: ConversationPreferences;
  onOpenSettings: () => void;
  viewer: string;
  onViewerChange: (viewer: string) => void;
  spaceData: SpaceData;
  notificationCount: number;
  notificationsOpen: boolean;
  onToggleNotifications: () => void;
  onCloseNotifications: () => void;
  pending: Work[];
  completedNotices: Work[];
  scenarios: ConversationScenario[];
  onOpenWork: (id: string) => void;
  showPanelToggle: boolean;
  panelOpen: boolean;
  onTogglePanel: () => void;
};

export function ConversationWorkspaceTopbar({
  engineMode = false,
  sidebarOpen,
  onOpenSidebar,
  space,
  work,
  preferences,
  onOpenSettings,
  viewer,
  onViewerChange,
  spaceData,
  notificationCount,
  notificationsOpen,
  onToggleNotifications,
  onCloseNotifications,
  pending,
  completedNotices,
  scenarios,
  onOpenWork,
  showPanelToggle,
  panelOpen,
  onTogglePanel,
}: Props) {
  const humanViewers = [...new Set([...spacePeople, ...Object.keys(spaceData.profiles || {})])]
    .filter(
      (n) =>
        isHumanMember(n, spaceData.profiles) &&
        !spaceData.removedPeople?.includes(n) &&
        memberProfile(n, spaceData.profiles).invitation !== "pending",
    );

  return (
    <>
      <header className="cw-topbar">
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
        <span>
          {space ? (
            space
          ) : work ? (
            <>
              <span className="cw-breadcrumb">Conversazioni / </span>
              {work.title}
            </>
          ) : (
            preferences.spaceName
          )}
        </span>
        <div>
          <button
            className="cw-icon"
            aria-label="Apri impostazioni"
            onClick={onOpenSettings}
          >
            <Settings2 size={18} />
          </button>
          {!engineMode && (
            <label className="cw-viewer">
              Fonte: simulazione · Vista demo{" "}
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
          <button
            className="cw-icon"
            aria-label={`Notifiche${notificationCount ? ` · ${notificationCount} aggiornamenti` : ""}`}
            onClick={onToggleNotifications}
          >
            <Bell size={18} />
            {!!notificationCount && <b>{notificationCount}</b>}
          </button>
          {showPanelToggle && (
            <button
              className="cw-icon"
              aria-label={panelOpen ? "Chiudi pannello dettagli" : "Apri pannello dettagli"}
              title={panelOpen ? "Chiudi dettagli" : "Mostra dettagli"}
              aria-expanded={panelOpen}
              onClick={onTogglePanel}
            >
              {panelOpen ? <PanelRightClose size={19} /> : <PanelRightOpen size={19} />}
            </button>
          )}
        </div>
      </header>
      {notificationsOpen && (
        <section className="cw-notifications">
          <header>
            <strong>Notifiche</strong>
            <button
              className="cw-icon"
              aria-label="Chiudi notifiche"
              onClick={onCloseNotifications}
            >
              <X size={16} />
            </button>
          </header>
          {!notificationCount ? (
            <p>Niente in sospeso. Puoi concentrarti sul tuo lavoro.</p>
          ) : (
            pending.map((w) => (
              <button key={w.id} onClick={() => onOpenWork(w.id)}>
                <strong>
                  {w.request?.status === "pending"
                    ? w.request.need
                    : w.phase === "ready" &&
                        isHumanMember(scenarioForWork(w, scenarios).agent, spaceData.profiles)
                      ? "Nuovo incarico"
                      : w.phase === "waiting"
                        ? scenarioForWork(w, scenarios).input
                        : "Verifica il risultato"}
                </strong>
                <small>
                  {w.title} · {scenarioForWork(w, scenarios).agent}
                </small>
                <ArrowUpRight size={16} />
              </button>
            ))
          )}
          {completedNotices.length > 0 && (
            <>
              <strong>Risultati pronti</strong>
              {completedNotices.map((w) => (
                <button key={w.id} onClick={() => onOpenWork(w.id)}>
                  <strong>
                    {w.autoDelivered ? "Consegnato in autonomia" : "Risultato approvato"}
                  </strong>
                  <small>
                    {w.title} · {scenarioForWork(w, scenarios).agent}
                  </small>
                  <ArrowUpRight size={16} />
                </button>
              ))}
            </>
          )}
        </section>
      )}
    </>
  );
}
