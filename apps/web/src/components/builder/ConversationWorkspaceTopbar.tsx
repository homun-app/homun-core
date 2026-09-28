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
      </div>
    </header>
  );
}
