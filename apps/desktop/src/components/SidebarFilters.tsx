import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SlidersHorizontal, X } from "lucide-react";
import { useTags } from "../lib/useTags";
import {
  type DateFilter,
  type ThreadFilter,
  EMPTY_THREAD_FILTER,
  threadFilterCount,
} from "../lib/threadFilter";

const DATE_OPTIONS: DateFilter[] = ["all", "today", "7d", "30d"];

function sourceLabel(source: string): string {
  if (source === "chat") return "Chat";
  return source.charAt(0).toUpperCase() + source.slice(1);
}

/**
 * Compact filter control for the sidebar list: a funnel button (with an active-count badge) that
 * opens a small popover to filter by conversation type, recency, and tag. Minimal by default —
 * just an icon until the user opens it — matching the "essential, not cluttered" direction.
 */
export function SidebarFilters({
  filter,
  onChange,
  availableSources,
}: {
  filter: ThreadFilter;
  onChange: (next: ThreadFilter) => void;
  availableSources: string[];
}) {
  const { t } = useTranslation();
  const { tags } = useTags();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const count = threadFilterCount(filter);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggleSource = (source: string) => {
    const has = filter.sources.includes(source);
    onChange({
      ...filter,
      sources: has ? filter.sources.filter((s) => s !== source) : [...filter.sources, source],
    });
  };
  const toggleTag = (tagId: string) => {
    const has = filter.tagIds.includes(tagId);
    onChange({
      ...filter,
      tagIds: has ? filter.tagIds.filter((id) => id !== tagId) : [...filter.tagIds, tagId],
    });
  };
  const setDate = (date: DateFilter) => onChange({ ...filter, date });

  return (
    <div className="sidebar-filters" ref={ref}>
      <button
        type="button"
        className={`sidebar-filter-toggle ${count > 0 ? "active" : ""}`}
        aria-label={t("filters.label")}
        title={t("filters.label")}
        onClick={() => setOpen((v) => !v)}
      >
        <SlidersHorizontal size={14} />
        {count > 0 && <span className="sidebar-filter-count">{count}</span>}
      </button>

      {open && (
        <div className="sidebar-filter-panel" role="menu">
          {availableSources.length > 1 && (
            <div className="filter-group">
              <div className="filter-group-label">{t("filters.type")}</div>
              <div className="filter-chips">
                {availableSources.map((source) => (
                  <button
                    key={source}
                    type="button"
                    className={`filter-chip ${filter.sources.includes(source) ? "on" : ""}`}
                    onClick={() => toggleSource(source)}
                  >
                    {sourceLabel(source)}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="filter-group">
            <div className="filter-group-label">{t("filters.date")}</div>
            <div className="filter-segments">
              {DATE_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`filter-segment ${filter.date === option ? "on" : ""}`}
                  onClick={() => setDate(option)}
                >
                  {t(`filters.dateOption.${option}`)}
                </button>
              ))}
            </div>
          </div>

          {tags.length > 0 && (
            <div className="filter-group">
              <div className="filter-group-label">{t("filters.tags")}</div>
              <div className="filter-chips">
                {tags.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    className={`filter-chip ${filter.tagIds.includes(tag.id) ? "on" : ""}`}
                    onClick={() => toggleTag(tag.id)}
                  >
                    <span className="tag-dot" style={{ background: tag.color }} />
                    {tag.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {count > 0 && (
            <button
              type="button"
              className="filter-clear"
              onClick={() => onChange(EMPTY_THREAD_FILTER)}
            >
              <X size={13} />
              <span>{t("filters.clear")}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
