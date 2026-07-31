import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  computeMenuPlacement,
  createPlacementRefreshScheduler,
  enabledMenuItemIndexes,
  getMenuKeyboardAction,
  getRovingTabIndexes,
  initialMenuFocusTarget,
  menuPlacementChanged,
  menuPlacementEvents,
  observeGeometryChanges,
  observeSubtreeContentChanges,
  shouldAssignInitialMenuFocus,
  shouldDismissMenuPointer,
  shouldRenderMenu,
  shouldRestoreMenuFocus,
} from "../../lib/layeredMenuState";

const MENU_ITEM_SELECTOR =
  '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

interface MenuSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export interface MenuSurfaceProps {
  id: string;
  chainId: string;
  label: string;
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  parentId?: string;
  search?: MenuSearchProps;
  onCloseCurrent: () => void;
  onCloseAll: () => void;
  children: ReactNode;
}

interface MenuPlacement {
  top: number;
  left: number;
  maxHeight: number | string;
  visibility: CSSProperties["visibility"];
}

const hiddenPlacement: MenuPlacement = {
  top: 0,
  left: 0,
  maxHeight: "calc(100vh - 16px)",
  visibility: "hidden",
};

function chainPortals(chainId: string) {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-menu-chain]")).filter(
    (portal) => portal.dataset.menuChain === chainId,
  );
}

function menuItems(menu: HTMLElement) {
  return Array.from(menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR));
}

function enabledMenuItems(items: HTMLElement[]) {
  const enabledIndexes = enabledMenuItemIndexes(items.map((item) => ({
    disabled: item.matches(":disabled"),
    ariaDisabled: item.getAttribute("aria-disabled") === "true",
  })));
  return enabledIndexes.map((index) => items[index]);
}

function applyRovingTabIndexes(
  allItems: HTMLElement[],
  enabledItems: HTMLElement[],
  tabIndexes: number[],
) {
  allItems.forEach((item) => {
    item.tabIndex = -1;
  });
  enabledItems.forEach((item, index) => {
    item.tabIndex = tabIndexes[index] ?? -1;
  });
}

export function MenuSurface({
  id,
  chainId,
  label,
  open,
  anchorRef,
  parentId,
  search,
  onCloseCurrent,
  onCloseAll,
  children,
}: MenuSurfaceProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const initialFocusDoneRef = useRef(false);
  const [placement, setPlacement] = useState<MenuPlacement>(hiddenPlacement);

  const updatePlacement = useCallback(() => {
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;

    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const menuWidth = menuRect.width;
    const menuHeight = menu.scrollHeight;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const { top, left, maxHeight } = computeMenuPlacement({
      anchor: anchorRect,
      menuWidth,
      menuHeight,
      viewportWidth,
      viewportHeight,
      nested: Boolean(parentId),
    });
    const nextPlacement: MenuPlacement = { top, left, maxHeight, visibility: "visible" };
    setPlacement((current) => (
      menuPlacementChanged(current, nextPlacement) ? nextPlacement : current
    ));
  }, [anchorRef, parentId]);

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(hiddenPlacement);
      return;
    }

    const placementRefresh = createPlacementRefreshScheduler(
      updatePlacement,
      (callback) => window.requestAnimationFrame(callback),
      (frameId) => window.cancelAnimationFrame(frameId),
    );
    const parentMenu = parentId ? document.getElementById(parentId) : null;
    placementRefresh.refresh();
    menuPlacementEvents.forEach(({ type, capture }) => {
      window.addEventListener(type, placementRefresh.refresh, capture);
    });
    const stopObserving = observeGeometryChanges(
      typeof window.ResizeObserver === "function" ? window.ResizeObserver : undefined,
      [anchorRef.current, menuRef.current, parentMenu],
      placementRefresh.refresh,
    );
    const stopObservingParentContent = observeSubtreeContentChanges(
      typeof window.MutationObserver === "function" ? window.MutationObserver : undefined,
      parentMenu,
      placementRefresh.refresh,
    );
    return () => {
      menuPlacementEvents.forEach(({ type, capture }) => {
        window.removeEventListener(type, placementRefresh.refresh, capture);
      });
      stopObserving();
      stopObservingParentContent();
      placementRefresh.cancel();
    };
  }, [open, updatePlacement]);

  useLayoutEffect(() => {
    if (!open || placement.visibility !== "visible") return;
    const menu = menuRef.current;
    if (!menu) return;

    const allItems = menuItems(menu);
    const items = enabledMenuItems(allItems);
    const activeIndex = items.indexOf(document.activeElement as HTMLElement);
    const tabIndexes = getRovingTabIndexes(items.length, activeIndex, Boolean(search));
    applyRovingTabIndexes(allItems, items, tabIndexes);
  });

  useLayoutEffect(() => {
    if (!open) {
      initialFocusDoneRef.current = false;
      return;
    }
    if (!shouldAssignInitialMenuFocus(
      open,
      placement.visibility,
      initialFocusDoneRef.current,
    )) return;

    const menu = menuRef.current;
    if (!menu) return;
    initialFocusDoneRef.current = true;
    const items = enabledMenuItems(menuItems(menu));
    const target = initialMenuFocusTarget(Boolean(searchRef.current), items.length);
    if (target === "search") searchRef.current?.focus();
    else if (target === "first-item") items[0]?.focus();
    else menu.focus();
  }, [open, placement.visibility]);

  useEffect(() => {
    if (!open || parentId) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const targetInsideAnchor = anchorRef.current?.contains(target) ?? false;
      const targetInsideSameChain = chainPortals(chainId).some((portal) => portal.contains(target));
      if (shouldDismissMenuPointer(targetInsideAnchor, targetInsideSameChain)) onCloseAll();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [anchorRef, chainId, onCloseAll, open, parentId]);

  useEffect(() => {
    if (!open || parentId != null) return;

    return () => {
      window.requestAnimationFrame(() => {
        const portalIds = chainPortals(chainId).map((portal) => portal.id);
        if (shouldRestoreMenuFocus(null, portalIds)) {
          anchorRef.current?.focus();
        }
      });
    };
  }, [anchorRef, chainId, open, parentId]);

  const focusItem = (menu: HTMLElement, items: HTMLElement[], index: number) => {
    const tabIndexes = getRovingTabIndexes(items.length, index, false);
    applyRovingTabIndexes(menuItems(menu), items, tabIndexes);
    items[index]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const menu = menuRef.current;
    if (!menu) return;

    const items = enabledMenuItems(menuItems(menu));
    const activeIndex = items.indexOf(document.activeElement as HTMLElement);
    const targetIsSearch = event.target === searchRef.current;
    const action = getMenuKeyboardAction(event.key, items.length, activeIndex, targetIsSearch);
    if (action.type === "none") return;

    event.preventDefault();
    if (action.type === "focus") {
      focusItem(menu, items, action.index);
    } else if (action.type === "activate") {
      items[action.index]?.click();
    } else {
      event.stopPropagation();
      onCloseCurrent();
    }
  };

  if (!shouldRenderMenu(open)) return null;

  return createPortal(
    <div
      ref={menuRef}
      id={id}
      data-menu-chain={chainId}
      data-parent-menu={parentId}
      role="menu"
      aria-label={label}
      className="menu-surface"
      tabIndex={-1}
      style={placement}
      onKeyDown={handleKeyDown}
    >
      {search ? (
        <label className="menu-search">
          <span className="menu-search__label">{search.placeholder ?? label}</span>
          <input
            ref={searchRef}
            type="search"
            value={search.value}
            placeholder={search.placeholder}
            aria-label={search.placeholder ?? label}
            onChange={(event) => search.onChange(event.currentTarget.value)}
          />
        </label>
      ) : null}
      {children}
    </div>,
    document.body,
  );
}
