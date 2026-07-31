export function openLayer(state, id, restoreFocusId, nested = false) {
  const chain = nested
    ? state.chain.length === 2 && state.chain[1] === id
      ? state.chain
      : state.chain.length > 0
        ? [state.chain[0], id]
        : [id]
    : [id];
  const nextRestoreFocusId = restoreFocusId ?? state.restoreFocusId;
  if (chain === state.chain && nextRestoreFocusId === state.restoreFocusId) return state;
  return {
    chain,
    restoreFocusId: nextRestoreFocusId,
  };
}

export function escapeLayer(state) {
  return {
    ...state,
    chain: state.chain.slice(0, -1),
  };
}

export function closeAllLayers(state) {
  return {
    ...state,
    chain: [],
  };
}

export function layerIsOpen(state, id) {
  return state.chain.includes(id);
}

export function getRovingTabIndexes(itemCount, activeIndex, searchPresent) {
  const count = Math.max(0, itemCount);
  const validActiveIndex = activeIndex >= 0 && activeIndex < count ? activeIndex : -1;
  const tabStopIndex = validActiveIndex >= 0 ? validActiveIndex : searchPresent ? -1 : 0;
  return Array.from({ length: count }, (_, index) => (index === tabStopIndex ? 0 : -1));
}

export function shouldAssignInitialMenuFocus(open, visibility, alreadyAssigned) {
  return open && visibility === "visible" && !alreadyAssigned;
}

export function initialMenuFocusTarget(searchPresent, enabledItemCount) {
  if (searchPresent) return "search";
  return enabledItemCount > 0 ? "first-item" : "menu";
}

export function enabledMenuItemIndexes(items) {
  const indexes = [];
  items.forEach((item, index) => {
    if (!item.disabled && !item.ariaDisabled) indexes.push(index);
  });
  return indexes;
}

export function getMenuKeyboardAction(key, itemCount, activeIndex, fromSearch) {
  if (key === "Escape") return { type: "close-current" };
  if (itemCount <= 0) return { type: "none" };

  if (key === "ArrowDown") {
    return {
      type: "focus",
      index: activeIndex < 0 ? 0 : (activeIndex + 1) % itemCount,
    };
  }
  if (key === "ArrowUp") {
    return {
      type: "focus",
      index: activeIndex < 0 ? itemCount - 1 : (activeIndex - 1 + itemCount) % itemCount,
    };
  }
  if (!fromSearch && key === "Home") return { type: "focus", index: 0 };
  if (!fromSearch && key === "End") return { type: "focus", index: itemCount - 1 };
  if (!fromSearch && (key === "Enter" || key === " ") && activeIndex >= 0) {
    return { type: "activate", index: activeIndex };
  }
  return { type: "none" };
}

export function shouldDismissMenuPointer(targetInsideAnchor, targetInsideSameChain) {
  return !targetInsideAnchor && !targetInsideSameChain;
}

export function shouldRenderMenu(open) {
  return open === true;
}

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 4;

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function computeMenuPlacement({
  anchor,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  nested,
}) {
  const belowOrigin = nested ? anchor.top : anchor.bottom + ANCHOR_GAP;
  const aboveBoundary = nested ? anchor.bottom : anchor.top - ANCHOR_GAP;
  const availableBelow = viewportHeight - belowOrigin - VIEWPORT_MARGIN;
  const availableAbove = aboveBoundary - VIEWPORT_MARGIN;
  const placeBelow = availableBelow >= menuHeight || availableBelow >= availableAbove;
  const maxHeight = Math.max(0, placeBelow ? availableBelow : availableAbove);
  const renderedHeight = Math.min(menuHeight, maxHeight);
  const unclampedTop = placeBelow ? belowOrigin : aboveBoundary - renderedHeight;
  const top = clamp(
    unclampedTop,
    VIEWPORT_MARGIN,
    Math.max(VIEWPORT_MARGIN, viewportHeight - VIEWPORT_MARGIN - renderedHeight),
  );

  let unclampedLeft;
  let opensRight;
  if (nested) {
    const availableRight = viewportWidth - anchor.right - ANCHOR_GAP - VIEWPORT_MARGIN;
    const availableLeft = anchor.left - ANCHOR_GAP - VIEWPORT_MARGIN;
    opensRight = availableRight >= menuWidth || availableRight >= availableLeft;
    unclampedLeft = opensRight
      ? anchor.right + ANCHOR_GAP
      : anchor.left - ANCHOR_GAP - menuWidth;
  } else {
    const availableRight = viewportWidth - anchor.left - VIEWPORT_MARGIN;
    const availableLeft = anchor.right - VIEWPORT_MARGIN;
    opensRight = availableRight >= menuWidth || availableRight >= availableLeft;
    unclampedLeft = opensRight ? anchor.left : anchor.right - menuWidth;
  }

  const left = clamp(
    unclampedLeft,
    VIEWPORT_MARGIN,
    Math.max(VIEWPORT_MARGIN, viewportWidth - VIEWPORT_MARGIN - menuWidth),
  );

  return {
    top,
    left,
    maxHeight,
    vertical: placeBelow ? "below" : "above",
    horizontal: opensRight ? "right" : "left",
  };
}

export const menuPlacementEvents = Object.freeze([
  Object.freeze({ type: "resize", capture: false }),
  Object.freeze({ type: "scroll", capture: true }),
]);

export function createPlacementRefreshScheduler(onRefresh, requestFrame, cancelFrame) {
  let pendingFrame = null;
  let cancelled = false;

  const refresh = () => {
    if (cancelled) return;
    onRefresh();
    if (pendingFrame !== null) cancelFrame(pendingFrame);
    pendingFrame = requestFrame(() => {
      pendingFrame = null;
      if (!cancelled) onRefresh();
    });
  };

  const cancel = () => {
    cancelled = true;
    if (pendingFrame === null) return;
    cancelFrame(pendingFrame);
    pendingFrame = null;
  };

  return { refresh, cancel };
}

export function observeGeometryChanges(ResizeObserverCtor, elements, onChange) {
  if (typeof ResizeObserverCtor !== "function") return () => {};
  const observer = new ResizeObserverCtor(onChange);
  elements.filter(Boolean).forEach((element) => observer.observe(element));
  return () => observer.disconnect();
}

export function observeSubtreeContentChanges(MutationObserverCtor, element, onChange) {
  if (typeof MutationObserverCtor !== "function" || !element) return () => {};
  const observer = new MutationObserverCtor(() => onChange());
  observer.observe(element, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  return () => observer.disconnect();
}

export function menuPlacementChanged(previous, next) {
  return previous.top !== next.top
    || previous.left !== next.left
    || previous.maxHeight !== next.maxHeight
    || previous.visibility !== next.visibility;
}

export function computeTooltipPlacement({
  anchor,
  tooltipWidth,
  tooltipHeight,
  viewportWidth,
  viewportHeight,
}) {
  const margin = 8;
  const gap = 6;
  const maxWidth = Math.max(0, viewportWidth - (margin * 2));
  const maxHeight = Math.max(0, viewportHeight - (margin * 2));
  const renderedWidth = Math.min(tooltipWidth, maxWidth);
  const renderedHeight = Math.min(tooltipHeight, maxHeight);
  const availableBelow = viewportHeight - anchor.bottom - gap - margin;
  const availableAbove = anchor.top - gap - margin;
  const placeBelow = availableBelow >= tooltipHeight || availableBelow >= availableAbove;
  const unclampedTop = placeBelow
    ? anchor.bottom + gap
    : anchor.top - gap - renderedHeight;
  const top = clamp(
    unclampedTop,
    margin,
    Math.max(margin, viewportHeight - margin - renderedHeight),
  );
  const centeredLeft = ((anchor.left + anchor.right) / 2) - (renderedWidth / 2);
  const left = clamp(
    centeredLeft,
    margin,
    Math.max(margin, viewportWidth - margin - renderedWidth),
  );
  return {
    top,
    left,
    maxWidth,
    maxHeight,
    vertical: placeBelow ? "below" : "above",
  };
}

export function shouldRestoreMenuFocus(parentId, openPortalIds) {
  if (parentId != null) return openPortalIds[openPortalIds.length - 1] === parentId;
  return openPortalIds.length === 0;
}

export function optionalAriaPressed(pressed) {
  return pressed === undefined ? undefined : pressed;
}

export function combineAriaDescribedBy(...values) {
  const ids = [];
  values.forEach((value) => {
    if (typeof value !== "string") return;
    value.split(/\s+/).filter(Boolean).forEach((id) => {
      if (!ids.includes(id)) ids.push(id);
    });
  });
  return ids.length > 0 ? ids.join(" ") : undefined;
}
