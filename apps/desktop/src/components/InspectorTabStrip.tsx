import { ChevronDown, Plus, X } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";

import type { InspectorTab, InspectorTabKind } from "../lib/inspectorWorkspace";

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
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const draggedIdRef = useRef<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);

  useEffect(() => {
    if (!addOpen && !overflowOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setAddOpen(false);
        setOverflowOpen(false);
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setAddOpen(false);
        setOverflowOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [addOpen, overflowOpen]);

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      onMove(tabs[index].id, index + (event.key === "ArrowLeft" ? -1 : 1));
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

  function startDrag(event: DragEvent<HTMLDivElement>, tabId: string) {
    draggedIdRef.current = tabId;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", tabId);
  }

  function dropAt(event: DragEvent<HTMLDivElement>, targetIndex: number) {
    event.preventDefault();
    const tabId = draggedIdRef.current ?? event.dataTransfer.getData("text/plain");
    if (tabId) onMove(tabId, targetIndex);
    draggedIdRef.current = null;
  }

  return (
    <div className="inspector-tab-strip-shell" ref={rootRef}>
      <div className="inspector-tab-strip" role="tablist" aria-label={t("chat.workbench")}>
        {tabs.map((tab, index) => (
          <div
            className={`inspector-tab${tab.id === activeTabId ? " active" : ""}`}
            draggable
            key={tab.id}
            onDragStart={(event) => startDrag(event, tab.id)}
            onDragEnd={() => {
              draggedIdRef.current = null;
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => dropAt(event, index)}
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
              aria-label={`${t("chat.closePanel")}: ${tab.title}`}
              title={t("chat.closePanel")}
              onClick={() => onClose(tab.id)}
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>

      <div className="inspector-tab-menu-wrap">
        <button
          className="inspector-tab-action"
          type="button"
          aria-label={t("chat.panel")}
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
          <div className="inspector-tab-menu" role="menu">
            {addItems.map((item) => (
              <button
                key={item.kind}
                type="button"
                role="menuitem"
                onClick={() => {
                  onAdd(item.kind);
                  setAddOpen(false);
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
          className="inspector-tab-action"
          type="button"
          aria-label={t("chat.panel")}
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
          <div className="inspector-tab-menu inspector-tab-menu--overflow" role="menu">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                className={tab.id === activeTabId ? "active" : ""}
                type="button"
                role="menuitem"
                onClick={() => {
                  onActivate(tab.id);
                  setOverflowOpen(false);
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
