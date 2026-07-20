import { ChevronDown, Plus, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type WheelEvent,
} from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  inspectorDropTarget,
  type InspectorDropTarget,
  type InspectorTab,
  type InspectorTabKind,
} from "../lib/inspectorWorkspace";

export interface InspectorAddItem {
  kind: InspectorTabKind;
  title: string;
}

interface InspectorTabStripProps {
  tabs: InspectorTab[];
  activeTabId: string | null;
  addItems: InspectorAddItem[];
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onMove: (tabId: string, targetIndex: number) => void;
  onAdd: (kind: InspectorTabKind) => void;
}

export function InspectorTabStrip({
  tabs,
  activeTabId,
  addItems,
  onActivate,
  onClose,
  onMove,
  onAdd,
}: InspectorTabStripProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const tabStripRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const overflowButtonRef = useRef<HTMLButtonElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const pointerDragRef = useRef<{
    tabId: string;
    x: number;
    y: number;
    pointerId: number;
    handle: HTMLDivElement;
    dragging: boolean;
  } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<InspectorDropTarget | null>(null);

  const clearPointerDrag = useCallback(() => {
    const drag = pointerDragRef.current;
    pointerDragRef.current = null;
    if (drag?.handle.isConnected && drag.handle.hasPointerCapture(drag.pointerId)) {
      drag.handle.releasePointerCapture(drag.pointerId);
    }
    document.body.classList.remove("dragging-inspector-tab");
    setDraggingTabId(null);
    setDropTarget(null);
  }, []);

  useEffect(() => {
    const menu = addOpen ? addMenuRef.current : overflowOpen ? overflowMenuRef.current : null;
    if (!menu) return;
    window.requestAnimationFrame(() => menu.querySelector<HTMLButtonElement>("button")?.focus());
  }, [addOpen, overflowOpen]);

  useEffect(() => {
    if (!activeTabId) return undefined;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`inspector-tab-${activeTabId}`)?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTabId, tabs]);

  useEffect(() => {
    if (!addOpen && !overflowOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        addOpen &&
        !addMenuRef.current?.contains(target) &&
        !addButtonRef.current?.contains(target)
      ) setAddOpen(false);
      if (
        overflowOpen &&
        !overflowMenuRef.current?.contains(target) &&
        !overflowButtonRef.current?.contains(target)
      ) setOverflowOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        const trigger = addOpen ? addButtonRef.current : overflowButtonRef.current;
        setAddOpen(false);
        setOverflowOpen(false);
        window.requestAnimationFrame(() => trigger?.focus());
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [addOpen, overflowOpen]);

  useEffect(() => {
    window.addEventListener("blur", clearPointerDrag);
    return () => {
      window.removeEventListener("blur", clearPointerDrag);
      clearPointerDrag();
    };
  }, [clearPointerDrag]);

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      onMove(tabs[index].id, index + (event.key === "ArrowLeft" ? -1 : 1));
      window.requestAnimationFrame(() => document.getElementById(`inspector-tab-${tabs[index].id}`)?.focus());
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const delta = event.key === "ArrowLeft" ? -1 : 1;
      const next = (index + delta + tabs.length) % tabs.length;
      onActivate(tabs[next].id);
      tabRefs.current[next]?.focus();
    }
  }

  function closeTab(tabId: string, index: number) {
    const fallbackId =
      tabId === activeTabId
        ? (tabs[index + 1]?.id ?? tabs[index - 1]?.id ?? null)
        : activeTabId;
    onClose(tabId);
    window.requestAnimationFrame(() => {
      if (fallbackId) document.getElementById(`inspector-tab-${fallbackId}`)?.focus();
      else addButtonRef.current?.focus();
    });
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
    event.preventDefault();
    items[next]?.focus();
  }

  function focusSelectedTabSoon(tabId?: string) {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const target = tabId
          ? document.getElementById(`inspector-tab-${tabId}`)
          : rootRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
        (target ?? addButtonRef.current)?.focus();
      });
    });
  }

  function onTabStripWheel(event: WheelEvent<HTMLDivElement>) {
    const strip = event.currentTarget;
    if (strip.scrollWidth <= strip.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
      return;
    }
    strip.scrollLeft += event.deltaY;
    event.preventDefault();
  }

  function startPointerDrag(event: ReactPointerEvent<HTMLDivElement>, tabId: string) {
    if (event.button !== 0 || (event.target as HTMLElement).closest(".inspector-tab-close")) return;
    clearPointerDrag();
    pointerDragRef.current = {
      tabId,
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      handle: event.currentTarget,
      dragging: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function currentDropTarget(pointerX: number, draggedId: string) {
    const bounds = [...(rootRef.current?.querySelectorAll<HTMLElement>(".inspector-tab") ?? [])]
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { id: node.dataset.tabId ?? "", left: rect.left, right: rect.right };
      })
      .filter((item) => item.id.length > 0);
    return inspectorDropTarget(bounds, pointerX, draggedId);
  }

  function trackPointerDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.dragging && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
    if (!drag.dragging) {
      drag.dragging = true;
      document.body.classList.add("dragging-inspector-tab");
      setDraggingTabId(drag.tabId);
    }
    const strip = tabStripRef.current;
    if (strip) {
      const bounds = strip.getBoundingClientRect();
      if (event.clientX < bounds.left + 28) strip.scrollLeft -= 12;
      else if (event.clientX > bounds.right - 28) strip.scrollLeft += 12;
    }
    setDropTarget(currentDropTarget(event.clientX, drag.tabId));
  }

  function finishPointerDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = pointerDragRef.current;
    const currentX = event.clientX;
    const currentY = event.clientY;
    if (!drag) return;
    const wasDragging = drag.dragging || Math.hypot(currentX - drag.x, currentY - drag.y) >= 6;
    if (!wasDragging) {
      clearPointerDrag();
      onActivate(drag.tabId);
      return;
    }
    const target = currentDropTarget(currentX, drag.tabId);
    clearPointerDrag();
    onMove(drag.tabId, target.index);
    window.requestAnimationFrame(() =>
      document.getElementById(`inspector-tab-${drag.tabId}`)?.focus(),
    );
  }

  return (
    <div className="inspector-tab-strip-shell" ref={rootRef}>
      <div
        ref={tabStripRef}
        className="inspector-tab-strip"
        role="tablist"
        aria-label={t("chat.workbench")}
        onWheel={onTabStripWheel}
      >
        {tabs.map((tab, index) => {
          const dropSide = dropTarget?.tabId === tab.id ? dropTarget.side : null;
          const dropClass =
            dropSide === "before" ? " drop-before" : dropSide === "after" ? " drop-after" : "";
          return (
            <div
              className={`inspector-tab${tab.id === activeTabId ? " active" : ""}${draggingTabId === tab.id ? " dragging" : ""}${dropClass}`}
              key={tab.id}
              data-tab-id={tab.id}
              aria-grabbed={draggingTabId === tab.id}
              onPointerDown={(event) => startPointerDrag(event, tab.id)}
              onPointerMove={trackPointerDrag}
              onPointerUp={finishPointerDrag}
              onPointerCancel={clearPointerDrag}
            >
              <button
                ref={(node) => {
                  tabRefs.current[index] = node;
                }}
                className="inspector-tab-title"
                type="button"
                role="tab"
                id={`inspector-tab-${tab.id}`}
                aria-controls={`inspector-panel-${tab.id}`}
                aria-selected={tab.id === activeTabId}
                tabIndex={tab.id === activeTabId ? 0 : -1}
                title={tab.title}
                onClick={() => onActivate(tab.id)}
                onKeyDown={(event) => onTabKeyDown(event, index)}
              >
                <span>{tab.title}</span>
              </button>
              <button
                className="inspector-tab-close"
                type="button"
                aria-label={t("chat.inspector.closeTab", { title: tab.title })}
                title={t("chat.inspector.closeTab", { title: tab.title })}
                onClick={() => closeTab(tab.id, index)}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="inspector-tab-menu-wrap">
        <button
          ref={addButtonRef}
          className="inspector-tab-action"
          type="button"
          aria-label={t("chat.inspector.addTab")}
          title={t("chat.inspector.addTab")}
          aria-haspopup="menu"
          aria-expanded={addOpen}
          onClick={() => {
            setOverflowOpen(false);
            setAddOpen((value) => !value);
          }}
        >
          <Plus size={15} />
        </button>
        {addOpen && (
          <div ref={addMenuRef} className="inspector-tab-menu" role="menu" onKeyDown={onMenuKeyDown}>
            {addItems.map((item) => (
              <button
                key={item.kind}
                type="button"
                role="menuitem"
                onClick={() => {
                  onAdd(item.kind);
                  setAddOpen(false);
                  focusSelectedTabSoon();
                }}
              >
                {item.title}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="inspector-tab-menu-wrap">
        <button
          ref={overflowButtonRef}
          className="inspector-tab-action"
          type="button"
          aria-label={t("chat.inspector.hiddenTabs")}
          title={t("chat.inspector.hiddenTabs")}
          aria-haspopup="menu"
          aria-expanded={overflowOpen}
          disabled={tabs.length === 0}
          onClick={() => {
            setAddOpen(false);
            setOverflowOpen((value) => !value);
          }}
        >
          <ChevronDown size={15} />
        </button>
        {overflowOpen && (
          <div
            ref={overflowMenuRef}
            className="inspector-tab-menu inspector-tab-menu--overflow"
            role="menu"
            onKeyDown={onMenuKeyDown}
          >
            {tabs.map((tab) => (
              <button
                key={tab.id}
                className={tab.id === activeTabId ? "active" : ""}
                type="button"
                role="menuitem"
                onClick={() => {
                  onActivate(tab.id);
                  setOverflowOpen(false);
                  focusSelectedTabSoon(tab.id);
                }}
              >
                {tab.title}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
