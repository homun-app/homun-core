import { ArrowLeft, Maximize2, Minimize2, PanelRightClose } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
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
  const [containerWidth, setContainerWidth] = useState(0);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const panelRefs = useRef(new Map<string, HTMLElement>());
  const scrollPositionsRef = useRef(new Map<string, number>());

  useEffect(() => setLiveRatio(ratio), [ratio]);
  useEffect(() => {
    const node = layoutRef.current;
    if (!node) return undefined;
    const update = () => setContainerWidth(node.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [layoutRef]);
  useEffect(() => {
    layoutRef.current?.style.setProperty("--inspector-ratio", String(liveRatio));
  }, [layoutRef, liveRatio]);
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  useLayoutEffect(() => {
    if (!state.activeTabId) return;
    const panel = panelRefs.current.get(state.activeTabId);
    if (!panel) return;
    panel.scrollTop = scrollPositionsRef.current.get(state.activeTabId) ?? 0;
  }, [state.activeTabId]);

  useEffect(() => {
    const openTabIds = new Set(state.tabs.map((tab) => tab.id));
    for (const tabId of scrollPositionsRef.current.keys()) {
      if (!openTabIds.has(tabId)) scrollPositionsRef.current.delete(tabId);
    }
  }, [state.tabs]);

  function ratioForPointer(clientX: number) {
    const bounds = layoutRef.current?.getBoundingClientRect();
    if (!bounds) return liveRatio;
    return clampInspectorRatio((bounds.right - clientX) / bounds.width, bounds.width);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    resizeCleanupRef.current?.();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    handle.setPointerCapture(pointerId);
    let lastRatio = liveRatio;
    let finished = false;
    const apply = (clientX: number) => {
      const next = ratioForPointer(clientX);
      setLiveRatio(next);
      lastRatio = next;
      return next;
    };
    const onMove = (moveEvent: globalThis.PointerEvent) => apply(moveEvent.clientX);
    const cleanup = () => {
      document.body.classList.remove("resizing-inspector");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("blur", onWindowBlur);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      if (resizeCleanupRef.current === cleanup) resizeCleanupRef.current = null;
    };
    const finish = (commit: boolean, clientX?: number) => {
      if (finished) return;
      finished = true;
      if (typeof clientX === "number") apply(clientX);
      if (commit) onRatioCommit(lastRatio);
      cleanup();
    };
    const onPointerUp = (finishEvent: globalThis.PointerEvent) => finish(true, finishEvent.clientX);
    const onPointerCancel = () => finish(true);
    const onWindowBlur = () => finish(true);
    document.body.classList.add("resizing-inspector");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("blur", onWindowBlur);
    resizeCleanupRef.current = cleanup;
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
  const minRatio = containerWidth >= 840 ? 420 / containerWidth : 0.5;
  const minPercent = Math.round(minRatio * 100);
  const maxPercent = Math.round((1 - minRatio) * 100);

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
          aria-label={t("chat.inspector.resize")}
          aria-orientation="vertical"
          aria-valuemin={minPercent}
          aria-valuemax={maxPercent}
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
            aria-label={t("chat.inspector.returnToChat")}
            title={t("chat.inspector.returnToChat")}
            onClick={onHide}
          >
            <ArrowLeft size={16} />
          </button>
          <button
            type="button"
            aria-label={state.focused ? t("chat.inspector.exitFocus") : t("chat.inspector.focus")}
            title={state.focused ? t("chat.inspector.exitFocus") : t("chat.inspector.focus")}
            onClick={onToggleFocus}
          >
            {state.focused ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button
            type="button"
            aria-label={t("chat.inspector.closeWorkspace")}
            title={t("chat.inspector.closeWorkspace")}
            onClick={onHide}
          >
            <PanelRightClose size={16} />
          </button>
        </span>
      </header>

      <div className="inspector-workspace-body">
        {state.tabs.length === 0 ? (
          <div className="workbench-empty">
            <p>{t("chat.inspector.empty")}</p>
          </div>
        ) : (
          state.tabs.map((tab) => (
            <section
              className="inspector-tab-panel"
              key={tab.id}
              ref={(node) => {
                if (node) panelRefs.current.set(tab.id, node);
                else panelRefs.current.delete(tab.id);
              }}
              id={`inspector-panel-${tab.id}`}
              role="tabpanel"
              aria-labelledby={`inspector-tab-${tab.id}`}
              hidden={tab.id !== state.activeTabId}
              onScroll={(event) => {
                if (tab.id === state.activeTabId) {
                  scrollPositionsRef.current.set(tab.id, event.currentTarget.scrollTop);
                }
              }}
            >
              {renderTab(tab)}
            </section>
          ))
        )}
      </div>
    </aside>
  );
}
