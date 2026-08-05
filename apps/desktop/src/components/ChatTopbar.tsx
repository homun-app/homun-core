import { PanelLeftOpen, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { InspectorTabKind } from "../lib/inspectorWorkspace";
import { ChatHeaderMenu } from "./ChatHeaderMenu";

interface ChatTopbarProps {
  title: string;
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
  onOpenSearch?: () => void;
  onOpenInspector: (kind: InspectorTabKind) => void;
  onCaptureScreenshot?: () => void;
}

export function ChatTopbar({
  title,
  sidebarCollapsed,
  onExpandSidebar,
  onOpenSearch,
  onOpenInspector,
  onCaptureScreenshot,
}: ChatTopbarProps) {
  const { t } = useTranslation();

  return (
    <header className="task-topbar">
      <div className="task-title-area">
        {sidebarCollapsed && (
          <span className="task-collapsed-controls">
            <button
              type="button"
              className="task-collapsed-action"
              aria-label={t("sidebar.expandSidebar")}
              title={t("sidebar.expandSidebar")}
              onClick={() => onExpandSidebar?.()}
            >
              <PanelLeftOpen size={17} />
            </button>
            <button
              type="button"
              className="task-collapsed-action"
              aria-label={t("sidebar.search")}
              title={t("sidebar.search")}
              onClick={() => onOpenSearch?.()}
            >
              <Search size={17} />
            </button>
          </span>
        )}
        <div className="task-title-button" style={{ cursor: "default" }}>
          <span id="chat-title">{title}</span>
        </div>
      </div>
      <span className="task-header-actions">
        <ChatHeaderMenu
          onOpenInspector={onOpenInspector}
          onCaptureScreenshot={onCaptureScreenshot}
        />
      </span>
    </header>
  );
}
