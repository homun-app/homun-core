import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Plus } from "lucide-react";
import type { TagEntityType } from "../lib/coreBridge";
import { useTags, tagsForEntity } from "../lib/useTags";
import { TAG_PALETTE, DEFAULT_TAG_COLOR } from "../lib/tagPalette";

/**
 * Popover to manage the tags on ONE entity (a thread or a project). Opened from the sidebar
 * context menu. Toggles existing tags on/off for the entity, and creates a new tag (free name +
 * a swatch from the curated palette) then assigns it. Shared `useTags` store, so a change here
 * updates the chips on every item immediately.
 */
export function TagMenu({
  entityType,
  entityId,
  x,
  y,
  onClose,
}: {
  entityType: TagEntityType;
  entityId: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { tags, assignments, assign, unassign, createTag } = useTags();
  const ref = useRef<HTMLDivElement>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(DEFAULT_TAG_COLOR);

  // Close on an outside click / Escape (the menu opened from a context menu that already closed).
  useEffect(() => {
    const onDown = (event: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const assignedIds = new Set(tagsForEntity(assignments, entityType, entityId).map((tag) => tag.id));

  const toggle = (tagId: string) =>
    assignedIds.has(tagId)
      ? void unassign(tagId, entityType, entityId)
      : void assign(tagId, entityType, entityId);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const tag = await createTag(trimmed, color);
    await assign(tag.id, entityType, entityId);
    setName("");
    setColor(DEFAULT_TAG_COLOR);
    setCreating(false);
  };

  return (
    <div
      ref={ref}
      className="tag-menu"
      style={{ left: x, top: y }}
      role="menu"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="tag-menu-list">
        {tags.length === 0 && <div className="tag-menu-empty">{t("tags.empty")}</div>}
        {tags.map((tag) => (
          <button
            key={tag.id}
            type="button"
            className="tag-menu-item"
            role="menuitemcheckbox"
            aria-checked={assignedIds.has(tag.id)}
            onClick={() => toggle(tag.id)}
          >
            <span className="tag-dot" style={{ background: tag.color }} />
            <span className="tag-menu-name">{tag.name}</span>
            {assignedIds.has(tag.id) && <Check size={13} />}
          </button>
        ))}
      </div>

      {creating ? (
        <div className="tag-menu-create">
          <input
            className="tag-menu-input"
            value={name}
            autoFocus
            placeholder={t("tags.newNamePlaceholder")}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void create();
            }}
          />
          <div className="tag-palette" role="radiogroup" aria-label={t("tags.color")}>
            {TAG_PALETTE.map((swatch) => (
              <button
                key={swatch}
                type="button"
                className={`tag-swatch ${swatch === color ? "selected" : ""}`}
                style={{ background: swatch }}
                aria-label={swatch}
                aria-checked={swatch === color}
                role="radio"
                onClick={() => setColor(swatch)}
              />
            ))}
          </div>
          <button
            type="button"
            className="tag-menu-create-confirm"
            disabled={!name.trim()}
            onClick={() => void create()}
          >
            {t("tags.create")}
          </button>
        </div>
      ) : (
        <button type="button" className="tag-menu-add" onClick={() => setCreating(true)}>
          <Plus size={14} />
          <span>{t("tags.new")}</span>
        </button>
      )}
    </div>
  );
}
