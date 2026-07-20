import { ArrowLeft, Maximize2, Minimize2, PanelRightClose } from "lucide-react";
import {
  useEffect,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";

import {
  clampInspectorRatio,
  type InspectorTab,
  type InspectorTabKind,
  type InspectorWorkspaceState,
} from "../lib/inspectorWorkspace";
import { InspectorTabStrip, type InspectorAddItem } from "./InspectorTabStrip";

interface InspectorWorkspaceProps {
  layoutRef: RefObject<HTMLElement | null>;
  state: InspectorWorkspaceState;
  ratio: number;
  addItems: InspectorAddItem[];
  onActivate: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onMoveTab: (tabId: string, targetIndex: number) => void;
  onAdd: (kind: InspectorTabKind) => void;
  onHide: () => void;
  onToggleFocus: () => void;
  onRatioCommit: (ratio: number) => void;
  renderTab: (tab: InspectorTab) => ReactNode;
}

export function InspectorWorkspace({
  layoutRef,
  state,
  ratio,
  addItems,
  onActivate,
  onCloseTab,
  onMoveTab,
  onAdd,
  onHide,
  onToggleFocus,
  onRatioCommit,
  renderTab,
}: InspectorWorkspaceProps) {
  const { t } = useTranslation();
  const [liveRatio, setLiveRatio] = useState(ratio);

  useEffect(() => setLiveRatio(ratio), [ratio]);
  useEffect(() => {
    layoutRef.current?.style.setProperty("--inspector-ratio", String(liveRatio));
  }, [layoutRef, liveRatio]);

  function ratioForPointer(clientX: number) {
    const bounds = layoutRef.current?.getBoundingClientRect();
    if (!bounds) return liveRatio;
    return clampInspectorRatio((bounds.right - clientX) / bounds.width, bounds.width);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const apply = (clientX: number) => {
      const next = ratioForPointer(clientX);
      setLiveRatio(next);
      return next;
    };
    const onMove = (moveEvent: globalThis.PointerEvent) => apply(moveEvent.clientX);
    const finish = (finishEvent: globalThis.PointerEvent) => {
      const next = apply(finishEvent.clientX);
      onRatioCommit(next);
      document.body.classList.remove("resizing-inspector");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    document.body.classList.add("resizing-inspector");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }

  function resizeBy(next: number) {
    const width = layoutRef.current?.getBoundingClientRect().width ?? 0;
    const clamped = clampInspectorRatio(next, width);
    setLiveRatio(clamped);
    onRatioCommit(clamped);
  }

  function onSeparatorKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 0.1 : 0.025;
    if (event.key === "ArrowLeft") resizeBy(liveRatio + step);
    else if (event.key === "ArrowRight") resizeBy(liveRatio - step);
    else if (event.key === "Home") resizeBy(0);
    else if (event.key === "End") resizeBy(1);
    else return;
    event.preventDefault();
  }

  if (!state.open) return null;

  return (
    <aside
      className={`inspector-workspace${state.focused ? " focused" : ""}`}
      aria-label={t("chat.workbench")}
      style={{ "--inspector-ratio": liveRatio } as CSSProperties}
    >
      {!state.focused && (
        <div
          className="inspector-resize-handle"
          role="separator"
          aria-label={t("chat.resizePanel")}
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(liveRatio * 100)}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onKeyDown={onSeparatorKeyDown}
        />
      )}

      <header className="inspector-workspace-header">
        <InspectorTabStrip
          tabs={state.tabs}
          activeTabId={state.activeTabId}
          addItems={addItems}
          onActivate={onActivate}
          onClose={onCloseTab}
          onMove={onMoveTab}
          onAdd={onAdd}
        />
        <span className="inspector-workspace-actions">
          <button
            className="inspector-mobile-back"
            type="button"
            aria-label={t("common.back")}
            title={t("common.back")}
            onClick={onHide}
          >
            <ArrowLeft size={16} />
          </button>
          <button
            type="button"
            aria-label={state.focused ? t("chat.collapsePanel") : t("chat.fullscreen")}
            title={state.focused ? t("chat.collapse") : t("chat.fullscreen")}
            onClick={onToggleFocus}
          >
            {state.focused ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button
            type="button"
            aria-label={t("chat.closePanel")}
            title={t("chat.closePanel")}
            onClick={onHide}
          >
            <PanelRightClose size={16} />
          </button>
        </span>
      </header>

      <div className="inspector-workspace-body">
        {state.tabs.length === 0 ? (
          <div className="workbench-empty">
            <p>{t("chat.selectAFile")}</p>
          </div>
        ) : (
          state.tabs.map((tab) => (
            <section
              className="inspector-tab-panel"
              key={tab.id}
              id={`inspector-panel-${tab.id}`}
              role="tabpanel"
              aria-labelledby={`inspector-tab-${tab.id}`}
              hidden={tab.id !== state.activeTabId}
            >
              {renderTab(tab)}
            </section>
          ))
        )}
      </div>
    </aside>
  );
}
