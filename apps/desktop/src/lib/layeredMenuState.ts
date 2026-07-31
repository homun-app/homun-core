// Node tests and the application share the same pure implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./layeredMenuState.mjs";

export interface LayeredMenuState {
  chain: string[];
  restoreFocusId: string | null;
}

export const openLayer = implementation.openLayer as (
  state: LayeredMenuState,
  id: string,
  restoreFocusId: string | null | undefined,
  nested?: boolean,
) => LayeredMenuState;

export const escapeLayer = implementation.escapeLayer as (
  state: LayeredMenuState,
) => LayeredMenuState;

export const closeAllLayers = implementation.closeAllLayers as (
  state: LayeredMenuState,
) => LayeredMenuState;

export const layerIsOpen = implementation.layerIsOpen as (
  state: LayeredMenuState,
  id: string,
) => boolean;

export const getRovingTabIndexes = implementation.getRovingTabIndexes as (
  itemCount: number,
  activeIndex: number,
  searchPresent: boolean,
) => number[];

export const shouldAssignInitialMenuFocus = implementation.shouldAssignInitialMenuFocus as (
  open: boolean,
  visibility: string | undefined,
  alreadyAssigned: boolean,
) => boolean;

export type InitialMenuFocusTarget = "search" | "first-item" | "menu";

export const initialMenuFocusTarget = implementation.initialMenuFocusTarget as (
  searchPresent: boolean,
  enabledItemCount: number,
) => InitialMenuFocusTarget;

export interface MenuItemAvailability {
  disabled: boolean;
  ariaDisabled: boolean;
}

export const enabledMenuItemIndexes = implementation.enabledMenuItemIndexes as (
  items: MenuItemAvailability[],
) => number[];

export type MenuKeyboardAction =
  | { type: "none" }
  | { type: "close-current" }
  | { type: "focus"; index: number }
  | { type: "activate"; index: number };

export const getMenuKeyboardAction = implementation.getMenuKeyboardAction as (
  key: string,
  itemCount: number,
  activeIndex: number,
  fromSearch: boolean,
) => MenuKeyboardAction;

export const shouldDismissMenuPointer = implementation.shouldDismissMenuPointer as (
  targetInsideAnchor: boolean,
  targetInsideSameChain: boolean,
) => boolean;

export const shouldRenderMenu = implementation.shouldRenderMenu as (open: boolean) => boolean;

export interface MenuAnchorRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface MenuPlacementInput {
  anchor: MenuAnchorRect;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  nested: boolean;
}

export interface ComputedMenuPlacement {
  top: number;
  left: number;
  maxHeight: number;
  vertical: "above" | "below";
  horizontal: "left" | "right";
}

export const computeMenuPlacement = implementation.computeMenuPlacement as (
  input: MenuPlacementInput,
) => ComputedMenuPlacement;

export const menuPlacementEvents = implementation.menuPlacementEvents as ReadonlyArray<{
  type: "resize" | "scroll";
  capture: boolean;
}>;

export interface PlacementRefreshScheduler {
  refresh: () => void;
  cancel: () => void;
}

export const createPlacementRefreshScheduler =
  implementation.createPlacementRefreshScheduler as (
    onRefresh: () => void,
    requestFrame: (callback: FrameRequestCallback) => number,
    cancelFrame: (frameId: number) => void,
  ) => PlacementRefreshScheduler;

export const observeGeometryChanges = implementation.observeGeometryChanges as (
  ResizeObserverCtor: typeof ResizeObserver | undefined,
  elements: Array<Element | null>,
  onChange: ResizeObserverCallback,
) => () => void;

export const observeSubtreeContentChanges = implementation.observeSubtreeContentChanges as (
  MutationObserverCtor: typeof MutationObserver | undefined,
  element: Node | null,
  onChange: () => void,
) => () => void;

export interface VisibleMenuPlacement {
  top: number;
  left: number;
  maxHeight: number | string;
  visibility: string | undefined;
}

export const menuPlacementChanged = implementation.menuPlacementChanged as (
  previous: VisibleMenuPlacement,
  next: VisibleMenuPlacement,
) => boolean;

export interface TooltipPlacementInput {
  anchor: MenuAnchorRect;
  tooltipWidth: number;
  tooltipHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface ComputedTooltipPlacement {
  top: number;
  left: number;
  maxWidth: number;
  maxHeight: number;
  vertical: "above" | "below";
}

export const computeTooltipPlacement = implementation.computeTooltipPlacement as (
  input: TooltipPlacementInput,
) => ComputedTooltipPlacement;

export const shouldRestoreMenuFocus = implementation.shouldRestoreMenuFocus as (
  parentId: string | null | undefined,
  openPortalIds: string[],
) => boolean;

export const optionalAriaPressed = implementation.optionalAriaPressed as (
  pressed: boolean | undefined,
) => boolean | undefined;

export const combineAriaDescribedBy = implementation.combineAriaDescribedBy as (
  ...values: Array<string | null | undefined>
) => string | undefined;
