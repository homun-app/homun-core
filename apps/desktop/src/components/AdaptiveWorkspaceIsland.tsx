import {
  Activity,
  Files,
  Layers3,
  Monitor,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  workspaceSectionSelection,
  type WorkspaceSection,
  type WorkspaceSectionId,
} from "../lib/workspaceIslandSections";

const SECTION_ICONS: Record<WorkspaceSectionId, LucideIcon> = {
  activity: Activity,
  browser: Monitor,
  artifacts: Layers3,
  sources: Files,
};

const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 520;
const RESIZE_STEP = 16;

export interface AdaptiveWorkspaceIslandProps {
  threadId: string;
  sections: WorkspaceSection[];
  renderSection: (section: WorkspaceSectionId) => ReactNode;
  openSectionRequest?: { section: WorkspaceSectionId; nonce: number };
  onOpenBrowserDock?: () => void;
  disabled?: boolean;
}

export function AdaptiveWorkspaceIsland({
  threadId,
  sections,
  renderSection,
  openSectionRequest,
  onOpenBrowserDock,
  disabled = false,
}: AdaptiveWorkspaceIslandProps) {
  const { t } = useTranslation();
  const shellRef = useRef<HTMLElement>(null);
  const layoutRef = useRef<HTMLElement | null>(null);
  const lastConsumedNonceRef = useRef<number | null>(null);
  const [activeSection, setActiveSection] = useState<WorkspaceSectionId | null>(null);

  // The <aside> only mounts once sections are available, so the surrounding
  // layout may not exist at first mount. Resolve it lazily on cleanup instead
  // of capturing a possibly-null reference here.
  useEffect(() => {
    return () => {
      const layout = layoutRef.current;
      if (!layout) return;
      delete layout.dataset.workspaceIslandOpen;
      layout.style.removeProperty("--workspace-island-panel-width");
      layoutRef.current = null;
    };
  }, []);

  // Resolve the layout at runtime (not from a stale mount-time ref) so the
  // mutual-exclusion dataset flag is written even when the island mounts after
  // the layout already exists. Fall back to the cached layout when the <aside>
  // is unmounted (disabled or no sections): shellRef is detached then, and the
  // flag must still be reset to "false" or the computer dock stays hidden.
  useEffect(() => {
    const layout =
      (shellRef.current?.closest(".active-task-layout") as HTMLElement | null) ?? layoutRef.current;
    if (!layout) return;
    layoutRef.current = layout;
    layout.dataset.workspaceIslandOpen = !disabled && activeSection ? "true" : "false";
  }, [activeSection, disabled]);

  useEffect(() => {
    setActiveSection(null);
  }, [threadId]);

  useEffect(() => {
    if (activeSection && !sections.some((section) => section.id === activeSection)) {
      setActiveSection(null);
    }
  }, [activeSection, sections]);

  // Consume each open-section request exactly once per nonce. `sections` can
  // change identity every render, so without the nonce guard this effect would
  // keep re-opening the requested section and override a manual close.
  useEffect(() => {
    if (
      openSectionRequest?.nonce
      && openSectionRequest.nonce !== lastConsumedNonceRef.current
      && sections.some((section) => section.id === openSectionRequest.section)
    ) {
      lastConsumedNonceRef.current = openSectionRequest.nonce;
      setActiveSection(openSectionRequest.section);
    }
  }, [openSectionRequest?.nonce, openSectionRequest?.section, sections]);

  const setPanelWidth = (width: number) => {
    const boundedWidth = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, width));
    shellRef.current?.style.setProperty(
      "--workspace-island-panel-width",
      `${boundedWidth}px`,
    );
    layoutRef.current?.style.setProperty("--workspace-island-panel-width", `${boundedWidth}px`);
  };

  const beginResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    const shell = shellRef.current;
    if (!shell) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = shell.getBoundingClientRect().width - 40;
    const onMove = (moveEvent: PointerEvent) => {
      setPanelWidth(startWidth + startX - moveEvent.clientX);
    };
    const onEnd = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd, { once: true });
  };

  if (disabled || sections.length === 0) return null;

  const active = sections.find((section) => section.id === activeSection) ?? null;

  return (
    <aside
      ref={shellRef}
      className={`adaptive-workspace-island${active ? " is-open" : ""}`}
      data-open={active ? "true" : "false"}
      aria-label={t("chat.panel")}
    >
      {active ? (
        <section
          id="workspace-island-panel"
          className="workspace-island-content"
          role="region"
          aria-labelledby="workspace-island-title"
        >
          <button
            type="button"
            className="workspace-island-resizer"
            aria-label={t("chat.resizePanel")}
            onPointerDown={beginResize}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const currentWidth = shellRef.current?.getBoundingClientRect().width ?? 360;
              setPanelWidth(
                currentWidth - 40 + (event.key === "ArrowLeft" ? RESIZE_STEP : -RESIZE_STEP),
              );
            }}
          />
          <header className="workspace-island-header">
            <span id="workspace-island-title">{t(active.labelKey)}</span>
            <button
              type="button"
              className="workspace-island-close"
              aria-label={t("chat.closePanel")}
              onClick={() => setActiveSection(null)}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </header>
          <div className="workspace-island-sections">
            {sections.map((section) => (
              <div key={section.id} hidden={activeSection !== section.id}>
                {renderSection(section.id)}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <nav className="workspace-island-rail" aria-label={t("chat.panel")}>
        {sections.map((section) => {
          const Icon = SECTION_ICONS[section.id];
          return (
            <button
              key={section.id}
              type="button"
              className={`workspace-island-rail-button status-${section.status}`}
              aria-label={t(section.labelKey)}
              aria-controls="workspace-island-panel"
              aria-pressed={activeSection === section.id}
              title={t(section.labelKey)}
              onClick={() => {
                const selection = workspaceSectionSelection(activeSection, section.id);
                setActiveSection(selection.activeSection);
                if (selection.browserDockRequested) onOpenBrowserDock?.();
              }}
            >
              <Icon size={10} aria-hidden="true" />
              {section.badge ? (
                <span className="workspace-island-badge" aria-hidden="true">
                  {section.badge > 99 ? "99+" : section.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
