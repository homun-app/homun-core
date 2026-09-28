/**
 * Top bar for the simulated workspace shell.
 * Displays current space/conversation context and contextual viewer controls.
 */

import { PanelRightClose } from "lucide-react";
import { ConversationSelectField } from "./ConversationSelect";
import { isHumanMember, memberProfile } from "./conversation-members";
import type { ConversationPreferences } from "./conversation-preferences";
import { spacePeople, type SpaceData, type SpaceView } from "./ConversationSpace";
import type { Work } from "./conversation-types";

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
};

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
}: Props) {
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
        ) : work ? (
          <>
            <span className="ph-breadcrumb-root">Conversazioni</span>
            <span className="ph-breadcrumb-sep">/</span>
            <span className="ph-topbar-name">{work.title}</span>
          </>
        ) : (
          <span className="ph-breadcrumb-root">{preferences.spaceName}</span>
        )}
        <span
          className={
            engineMode
              ? "ph-source-badge ph-source-badge--engine"
              : "ph-source-badge ph-source-badge--simulation"
          }
        >
          {engineMode ? "motore" : "sim"}
        </span>
      </div>

      <div className="ph-topbar-contextual">
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
