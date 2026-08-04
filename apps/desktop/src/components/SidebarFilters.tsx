import { useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, ListFilter, RotateCcw } from "lucide-react";
import {
  normalizeThreadFilter,
  threadFilterCount,
  type ThreadFilter,
  type ThreadGroup,
  type ThreadOrder,
  type ThreadPeriod,
  type ThreadState,
  type ThreadType,
} from "../lib/threadFilter";
import {
  SIDEBAR_FILTER_ROOT_ROWS,
  freshSidebarThreadFilter,
  sidebarChannelOptions,
  sidebarFilterBadgeModel,
  toggleAttentionFilterStates,
  type SidebarFilterRootRowId,
} from "../lib/sidebarFilterState";
import { IconButton } from "./ui/IconButton";
import { MenuSurface } from "./ui/MenuSurface";

interface FilterOption<T extends string> {
  value: T;
  label: string;
}

interface ProjectOption {
  id: string;
  name: string;
}

type Submenu = Exclude<SidebarFilterRootRowId, "showArchived">;

const GROUP_OPTIONS: ThreadGroup[] = ["none", "project", "channel", "period"];
const ORDER_OPTIONS: ThreadOrder[] = ["updated_desc", "updated_asc", "title_asc"];
const STATE_OPTIONS: ThreadState[] = ["working", "completed_unread", "waiting_user", "failed"];
const TYPE_OPTIONS: ThreadType[] = ["chat", "project"];
const PERIOD_OPTIONS: ThreadPeriod[] = ["all", "today", "7d", "30d"];

function sourceLabel(source: string): string {
  if (source === "chat") return "Chat";
  return source.charAt(0).toUpperCase() + source.slice(1);
}

function toggleValue<T extends string>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

function MenuLeading() {
  return <span className="menu-item__leading" aria-hidden="true" />;
}

function MenuCheck() {
  return (
    <span className="menu-check" aria-hidden="true">
      <Check size={14} />
    </span>
  );
}

function ScalarMenu<T extends string>({
  id,
  label,
  parentId,
  anchorRef,
  open,
  options,
  value,
  onSelect,
  onCloseCurrent,
  onCloseAll,
}: {
  id: string;
  label: string;
  parentId: string;
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  options: FilterOption<T>[];
  value: T;
  onSelect: (value: T) => void;
  onCloseCurrent: () => void;
  onCloseAll: () => void;
}) {
  return (
    <MenuSurface
      id={id}
      chainId="sidebar-filters"
      label={label}
      open={open}
      anchorRef={anchorRef}
      parentId={parentId}
      onCloseCurrent={onCloseCurrent}
      onCloseAll={onCloseAll}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="menuitemradio"
          className="menu-item"
          aria-checked={value === option.value}
          onClick={() => {
            onSelect(option.value);
            onCloseAll();
          }}
        >
          <MenuLeading />
          <span className="menu-item__label">{option.label}</span>
          <MenuCheck />
        </button>
      ))}
    </MenuSurface>
  );
}

function MultiMenu<T extends string>({
  id,
  label,
  parentId,
  anchorRef,
  open,
  options,
  values,
  onToggle,
  onCloseCurrent,
  onCloseAll,
  beforeOptions,
}: {
  id: string;
  label: string;
  parentId: string;
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  options: FilterOption<T>[];
  values: T[];
  onToggle: (value: T) => void;
  onCloseCurrent: () => void;
  onCloseAll: () => void;
  beforeOptions?: ReactNode;
}) {
  return (
    <MenuSurface
      id={id}
      chainId="sidebar-filters"
      label={label}
      open={open}
      anchorRef={anchorRef}
      parentId={parentId}
      onCloseCurrent={onCloseCurrent}
      onCloseAll={onCloseAll}
    >
      {beforeOptions}
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="menuitemcheckbox"
          className="menu-item"
          aria-checked={values.includes(option.value)}
          onClick={() => onToggle(option.value)}
        >
          <MenuLeading />
          <span className="menu-item__label">{option.label}</span>
          <MenuCheck />
        </button>
      ))}
    </MenuSurface>
  );
}

export function SidebarFilters({
  filter,
  onChange,
  availableProjects,
  availableChannels,
}: {
  filter: ThreadFilter;
  onChange: (next: ThreadFilter) => void;
  availableProjects: ProjectOption[];
  availableChannels: string[];
}) {
  const { t } = useTranslation();
  const triggerRef = useMemo<RefObject<HTMLElement | null>>(() => ({
    get current() {
      return typeof document === "undefined"
        ? null
        : document.getElementById("sidebar-filter-trigger");
    },
  }), []);
  const groupByRef = useRef<HTMLButtonElement>(null);
  const orderRef = useRef<HTMLButtonElement>(null);
  const statesRef = useRef<HTMLButtonElement>(null);
  const typesRef = useRef<HTMLButtonElement>(null);
  const periodRef = useRef<HTMLButtonElement>(null);
  const projectsRef = useRef<HTMLButtonElement>(null);
  const channelsRef = useRef<HTMLButtonElement>(null);
  const [rootOpen, setRootOpen] = useState(false);
  const [submenu, setSubmenu] = useState<Submenu | null>(null);
  const count = threadFilterCount(filter);
  const badgeModel = sidebarFilterBadgeModel(count, t("filters.activeCount", { count }));
  const rootId = "sidebar-filters-menu";

  const closeAll = () => {
    setSubmenu(null);
    setRootOpen(false);
  };
  const openSubmenu = (next: Submenu) => setSubmenu((current) => (current === next ? null : next));
  const update = (next: ThreadFilter) => onChange(normalizeThreadFilter(next));
  const submenuRow = (
    key: Submenu,
    label: string,
    ref: RefObject<HTMLButtonElement | null>,
  ) => (
    <button
      key={key}
      ref={ref}
      type="button"
      role="menuitem"
      className="menu-item sidebar-filter-menu__parent"
      aria-haspopup="menu"
      aria-expanded={submenu === key}
      aria-controls={`sidebar-filters-${key}-menu`}
      onClick={() => openSubmenu(key)}
    >
      <MenuLeading />
      <span className="menu-item__label">{label}</span>
      <span className="menu-item__trailing" aria-hidden="true">
        <ChevronRight size={14} />
      </span>
    </button>
  );

  const groupOptions = GROUP_OPTIONS.map((value) => ({
    value,
    label: t(`filters.groupByOption.${value}`),
  }));
  const orderOptions = ORDER_OPTIONS.map((value) => ({
    value,
    label: t(`filters.orderOption.${value}`),
  }));
  const stateOptions = STATE_OPTIONS.map((value) => ({
    value,
    label: t(`filters.stateOption.${value}`),
  }));
  const typeOptions = TYPE_OPTIONS.map((value) => ({
    value,
    label: t(`filters.typeOption.${value}`),
  }));
  const periodOptions = PERIOD_OPTIONS.map((value) => ({
    value,
    label: t(`filters.periodOption.${value}`),
  }));
  const projectOptions = availableProjects.map((project) => ({
    value: project.id,
    label: project.name,
  }));
  const channelOptions = sidebarChannelOptions(availableChannels, filter.channels).map(
    (channel) => ({
      value: channel,
      label: sourceLabel(channel),
    }),
  );
  const attentionSelected = filter.states.includes("waiting_user") && filter.states.includes("failed");
  const renderRootRow = (row: SidebarFilterRootRowId) => {
    switch (row) {
      case "groupBy":
        return submenuRow(row, t("filters.groupBy"), groupByRef);
      case "order":
        return submenuRow(row, t("filters.orderBy"), orderRef);
      case "states":
        return submenuRow(row, t("filters.state"), statesRef);
      case "types":
        return submenuRow(row, t("filters.type"), typesRef);
      case "period":
        return submenuRow(row, t("filters.period"), periodRef);
      case "projects":
        return submenuRow(row, t("filters.project"), projectsRef);
      case "channels":
        return submenuRow(row, t("filters.channel"), channelsRef);
      case "showArchived":
        return (
          <button
            key={row}
            type="button"
            role="menuitemcheckbox"
            className="menu-item"
            aria-checked={filter.showArchived}
            onClick={() => update({ ...filter, showArchived: !filter.showArchived })}
          >
            <MenuLeading />
            <span className="menu-item__label">{t("filters.showArchived")}</span>
            <MenuCheck />
          </button>
        );
    }
  };

  return (
    <div className="sidebar-filters">
      <IconButton
        id="sidebar-filter-trigger"
        className="sidebar-filter-trigger"
        size="sm"
        label={t("filters.label")}
        tooltip={t("filters.label")}
        pressed={rootOpen}
        badge={badgeModel.badge === "dot"
          ? <span className="sidebar-filter-badge-dot" />
          : badgeModel.badge ?? undefined}
        badgeLabel={badgeModel.badgeLabel}
        aria-haspopup="menu"
        aria-expanded={rootOpen}
        aria-controls={rootId}
        onClick={() => {
          setSubmenu(null);
          setRootOpen((current) => !current);
        }}
      >
        <ListFilter />
      </IconButton>

      <MenuSurface
        id={rootId}
        chainId="sidebar-filters"
        label={t("filters.label")}
        open={rootOpen}
        anchorRef={triggerRef}
        onCloseCurrent={closeAll}
        onCloseAll={closeAll}
      >
        <div className="sidebar-filter-menu">
          {SIDEBAR_FILTER_ROOT_ROWS.map(renderRootRow)}
          {count > 0 ? (
            <>
              <div className="menu-separator" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="menu-item sidebar-filter-clear"
                onClick={() => {
                  onChange(freshSidebarThreadFilter());
                  closeAll();
                }}
              >
                <span className="menu-item__leading" aria-hidden="true">
                  <RotateCcw size={14} />
                </span>
                <span className="menu-item__label">{t("filters.clear")}</span>
                <span className="menu-item__trailing" />
              </button>
            </>
          ) : null}
        </div>
      </MenuSurface>

      <ScalarMenu
        id="sidebar-filters-groupBy-menu"
        label={t("filters.groupBy")}
        parentId={rootId}
        anchorRef={groupByRef}
        open={rootOpen && submenu === "groupBy"}
        options={groupOptions}
        value={filter.groupBy}
        onSelect={(groupBy) => update({ ...filter, groupBy })}
        onCloseCurrent={() => setSubmenu(null)}
        onCloseAll={closeAll}
      />
      <ScalarMenu
        id="sidebar-filters-order-menu"
        label={t("filters.orderBy")}
        parentId={rootId}
        anchorRef={orderRef}
        open={rootOpen && submenu === "order"}
        options={orderOptions}
        value={filter.order}
        onSelect={(order) => update({ ...filter, order })}
        onCloseCurrent={() => setSubmenu(null)}
        onCloseAll={closeAll}
      />
      <MultiMenu
        id="sidebar-filters-states-menu"
        label={t("filters.state")}
        parentId={rootId}
        anchorRef={statesRef}
        open={rootOpen && submenu === "states"}
        options={stateOptions}
        values={filter.states}
        onToggle={(state) => update({ ...filter, states: toggleValue(filter.states, state) })}
        onCloseCurrent={() => setSubmenu(null)}
        onCloseAll={closeAll}
        beforeOptions={(
          <>
            <button
              type="button"
              role="menuitemcheckbox"
              className="menu-item"
              aria-checked={attentionSelected}
              onClick={() => update({
                ...filter,
                states: toggleAttentionFilterStates(filter.states),
              })}
            >
              <MenuLeading />
              <span className="menu-item__label">{t("filters.requiresAttention")}</span>
              <MenuCheck />
            </button>
            <div className="menu-separator" role="separator" />
          </>
        )}
      />
      <MultiMenu
        id="sidebar-filters-types-menu"
        label={t("filters.type")}
        parentId={rootId}
        anchorRef={typesRef}
        open={rootOpen && submenu === "types"}
        options={typeOptions}
        values={filter.types}
        onToggle={(type) => update({ ...filter, types: toggleValue(filter.types, type) })}
        onCloseCurrent={() => setSubmenu(null)}
        onCloseAll={closeAll}
      />
      <ScalarMenu
        id="sidebar-filters-period-menu"
        label={t("filters.period")}
        parentId={rootId}
        anchorRef={periodRef}
        open={rootOpen && submenu === "period"}
        options={periodOptions}
        value={filter.period}
        onSelect={(period) => update({ ...filter, period })}
        onCloseCurrent={() => setSubmenu(null)}
        onCloseAll={closeAll}
      />
      <MultiMenu
        id="sidebar-filters-projects-menu"
        label={t("filters.project")}
        parentId={rootId}
        anchorRef={projectsRef}
        open={rootOpen && submenu === "projects"}
        options={projectOptions}
        values={filter.projects}
        onToggle={(project) => update({ ...filter, projects: toggleValue(filter.projects, project) })}
        onCloseCurrent={() => setSubmenu(null)}
        onCloseAll={closeAll}
      />
      <MultiMenu
        id="sidebar-filters-channels-menu"
        label={t("filters.channel")}
        parentId={rootId}
        anchorRef={channelsRef}
        open={rootOpen && submenu === "channels"}
        options={channelOptions}
        values={filter.channels}
        onToggle={(channel) => update({ ...filter, channels: toggleValue(filter.channels, channel) })}
        onCloseCurrent={() => setSubmenu(null)}
        onCloseAll={closeAll}
      />
    </div>
  );
}
