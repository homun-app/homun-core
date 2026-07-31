import assert from "node:assert/strict";
import test from "node:test";

import {
  combineAriaDescribedBy,
  closeAllLayers,
  computeMenuPlacement,
  computeTooltipPlacement,
  createPlacementRefreshScheduler,
  enabledMenuItemIndexes,
  escapeLayer,
  getMenuKeyboardAction,
  getRovingTabIndexes,
  initialMenuFocusTarget,
  layerIsOpen,
  menuPlacementChanged,
  menuPlacementEvents,
  observeGeometryChanges,
  observeSubtreeContentChanges,
  openLayer,
  optionalAriaPressed,
  shouldAssignInitialMenuFocus,
  shouldDismissMenuPointer,
  shouldRenderMenu,
  shouldRestoreMenuFocus,
} from "./layeredMenuState.mjs";

const closedState = { chain: [], restoreFocusId: null };

test("opening a new root replaces the previous root and its restore target", () => {
  const addOpen = openLayer(closedState, "add", "composer-add");
  const modelsOpen = openLayer(addOpen, "models", "composer-model");

  assert.deepEqual(modelsOpen, {
    chain: ["models"],
    restoreFocusId: "composer-model",
  });
});

test("Escape unwinds nested layers before closing the root", () => {
  const addOpen = openLayer(closedState, "add", "composer-add");
  const modelsOpen = openLayer(addOpen, "models", "composer-add", true);

  assert.deepEqual(modelsOpen.chain, ["add", "models"]);
  assert.deepEqual(escapeLayer(modelsOpen).chain, ["add"]);
  assert.deepEqual(escapeLayer(escapeLayer(modelsOpen)).chain, []);
});

test("nested opening is idempotent and nullish restore targets preserve the existing target", () => {
  const addOpen = openLayer(closedState, "add", "composer-add");
  const modelsOpen = openLayer(addOpen, "models", null, true);
  const modelsOpenedAgain = openLayer(modelsOpen, "models", undefined, true);
  const rootReplacement = openLayer(modelsOpenedAgain, "settings", null);

  assert.deepEqual(modelsOpen, {
    chain: ["add", "models"],
    restoreFocusId: "composer-add",
  });
  assert.deepEqual(modelsOpenedAgain, modelsOpen);
  assert.deepEqual(rootReplacement, {
    chain: ["settings"],
    restoreFocusId: "composer-add",
  });
});

test("closing all layers retains the restore target", () => {
  const openState = {
    chain: ["add", "models"],
    restoreFocusId: "composer-add",
  };

  assert.deepEqual(closeAllLayers(openState), {
    chain: [],
    restoreFocusId: "composer-add",
  });
});

test("layerIsOpen reports chain membership", () => {
  const state = {
    chain: ["add", "models"],
    restoreFocusId: "composer-add",
  };

  assert.equal(layerIsOpen(state, "models"), true);
  assert.equal(layerIsOpen(state, "settings"), false);
});

test("search focus leaves every menu item outside the tab order", () => {
  assert.deepEqual(getRovingTabIndexes(3, -1, true), [-1, -1, -1]);
  assert.deepEqual(getRovingTabIndexes(2, 1, true), [-1, 0]);
  assert.deepEqual(getRovingTabIndexes(1, -1, true), [-1]);
  assert.deepEqual(getRovingTabIndexes(3, -1, false), [0, -1, -1]);
});

test("initial focus is assigned once per visible opening with an empty-menu fallback", () => {
  assert.equal(shouldAssignInitialMenuFocus(true, "visible", false), true);
  assert.equal(shouldAssignInitialMenuFocus(true, "visible", true), false);
  assert.equal(shouldAssignInitialMenuFocus(true, "hidden", false), false);
  assert.equal(shouldAssignInitialMenuFocus(false, "visible", false), false);
  assert.equal(initialMenuFocusTarget(true, 2), "search");
  assert.equal(initialMenuFocusTarget(false, 2), "first-item");
  assert.equal(initialMenuFocusTarget(false, 0), "menu");
});

test("enabled menu indexes skip native and aria-disabled items", () => {
  const items = [
    { disabled: false, ariaDisabled: false },
    { disabled: true, ariaDisabled: false },
    { disabled: false, ariaDisabled: true },
    { disabled: false, ariaDisabled: false },
  ];

  assert.deepEqual(enabledMenuItemIndexes(items), [0, 3]);
});

test("menu keyboard actions rove, wrap, activate, and close", () => {
  assert.deepEqual(getMenuKeyboardAction("ArrowDown", 3, -1, true), {
    type: "focus",
    index: 0,
  });
  assert.deepEqual(getMenuKeyboardAction("ArrowDown", 3, 2, false), {
    type: "focus",
    index: 0,
  });
  assert.deepEqual(getMenuKeyboardAction("ArrowUp", 3, 0, false), {
    type: "focus",
    index: 2,
  });
  assert.deepEqual(getMenuKeyboardAction("Home", 3, 2, false), {
    type: "focus",
    index: 0,
  });
  assert.deepEqual(getMenuKeyboardAction("End", 3, 0, false), {
    type: "focus",
    index: 2,
  });
  assert.deepEqual(getMenuKeyboardAction("Enter", 3, 1, false), {
    type: "activate",
    index: 1,
  });
  assert.deepEqual(getMenuKeyboardAction(" ", 3, 1, false), {
    type: "activate",
    index: 1,
  });
  assert.deepEqual(getMenuKeyboardAction("Escape", 3, 1, true), {
    type: "close-current",
  });
  assert.deepEqual(getMenuKeyboardAction("Home", 3, -1, true), { type: "none" });
});

test("pointer dismissal distinguishes anchors, same-chain portals, and outside targets", () => {
  assert.equal(shouldDismissMenuPointer(true, false), false);
  assert.equal(shouldDismissMenuPointer(false, true), false);
  assert.equal(shouldDismissMenuPointer(false, false), true);
});

test("closed menus do not render a portal", () => {
  assert.equal(shouldRenderMenu(false), false);
  assert.equal(shouldRenderMenu(true), true);
});

test("placement chooses available viewport sides and remains bounded", () => {
  const belowLeft = computeMenuPlacement({
    anchor: { top: 20, right: 50, bottom: 50, left: 20 },
    menuWidth: 100,
    menuHeight: 80,
    viewportWidth: 500,
    viewportHeight: 400,
    nested: false,
  });
  assert.deepEqual(belowLeft, {
    top: 54,
    left: 20,
    maxHeight: 338,
    vertical: "below",
    horizontal: "right",
  });

  const aboveRight = computeMenuPlacement({
    anchor: { top: 350, right: 490, bottom: 380, left: 460 },
    menuWidth: 200,
    menuHeight: 180,
    viewportWidth: 500,
    viewportHeight: 400,
    nested: false,
  });
  assert.deepEqual(aboveRight, {
    top: 166,
    left: 290,
    maxHeight: 338,
    vertical: "above",
    horizontal: "left",
  });
  assert.ok(aboveRight.top >= 8);
  assert.ok(aboveRight.left + 200 <= 492);
});

test("placement listeners include resize and capture scroll", () => {
  assert.deepEqual(menuPlacementEvents, [
    { type: "resize", capture: false },
    { type: "scroll", capture: true },
  ]);
});

test("placement refresh runs immediately and once on the next frame with cleanup", () => {
  let refreshCount = 0;
  let nextFrameId = 0;
  const frameCallbacks = new Map();
  const cancelledFrames = [];
  const requestFrame = (callback) => {
    const frameId = ++nextFrameId;
    frameCallbacks.set(frameId, callback);
    return frameId;
  };
  const cancelFrame = (frameId) => {
    cancelledFrames.push(frameId);
    frameCallbacks.delete(frameId);
  };
  const scheduler = createPlacementRefreshScheduler(
    () => { refreshCount += 1; },
    requestFrame,
    cancelFrame,
  );

  scheduler.refresh();
  assert.equal(refreshCount, 1);
  assert.deepEqual([...frameCallbacks.keys()], [1]);

  scheduler.refresh();
  assert.equal(refreshCount, 2);
  assert.deepEqual(cancelledFrames, [1]);
  assert.deepEqual([...frameCallbacks.keys()], [2]);

  const pendingCallback = frameCallbacks.get(2);
  frameCallbacks.delete(2);
  pendingCallback();
  assert.equal(refreshCount, 3);
  assert.deepEqual([...frameCallbacks.keys()], []);

  scheduler.refresh();
  const cancelledCallback = frameCallbacks.get(3);
  scheduler.cancel();
  assert.deepEqual(cancelledFrames, [1, 3]);
  cancelledCallback();
  scheduler.refresh();
  assert.equal(refreshCount, 4);
  assert.equal(nextFrameId, 3);
});

test("geometry observation watches each available element and disconnects cleanly", () => {
  const observed = [];
  let disconnected = false;
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
    }

    observe(element) {
      observed.push(element);
    }

    disconnect() {
      disconnected = true;
    }
  }
  const anchor = { id: "anchor" };
  const surface = { id: "surface" };

  const cleanup = observeGeometryChanges(FakeResizeObserver, [anchor, null, surface], () => {});
  assert.deepEqual(observed, [anchor, surface]);
  cleanup();
  assert.equal(disconnected, true);
  assert.doesNotThrow(observeGeometryChanges(undefined, [anchor], () => {}));
});

test("parent content observation forwards subtree changes and disconnects cleanly", () => {
  let observerCallback;
  let observedTarget;
  let observedOptions;
  let disconnected = false;
  let refreshCount = 0;
  class FakeMutationObserver {
    constructor(callback) {
      observerCallback = callback;
    }

    observe(target, options) {
      observedTarget = target;
      observedOptions = options;
    }

    disconnect() {
      disconnected = true;
    }
  }
  const parentMenu = { id: "parent-menu" };

  const cleanup = observeSubtreeContentChanges(
    FakeMutationObserver,
    parentMenu,
    () => { refreshCount += 1; },
  );
  assert.equal(observedTarget, parentMenu);
  assert.deepEqual(observedOptions, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  observerCallback([{ type: "childList" }]);
  assert.equal(refreshCount, 1);
  cleanup();
  assert.equal(disconnected, true);

  assert.doesNotThrow(observeSubtreeContentChanges(undefined, parentMenu, () => {}));
  assert.doesNotThrow(observeSubtreeContentChanges(FakeMutationObserver, null, () => {}));
});

test("equivalent menu placement does not request a redundant state update", () => {
  const placement = { top: 20, left: 30, maxHeight: 240, visibility: "visible" };
  assert.equal(menuPlacementChanged(placement, { ...placement }), false);
  assert.equal(menuPlacementChanged(placement, { ...placement, top: 21 }), true);
  assert.equal(menuPlacementChanged(placement, { ...placement, visibility: "hidden" }), true);
});

test("tooltip placement stays inside the viewport and flips above when needed", () => {
  assert.deepEqual(computeTooltipPlacement({
    anchor: { top: 20, right: 30, bottom: 50, left: 0 },
    tooltipWidth: 180,
    tooltipHeight: 30,
    viewportWidth: 320,
    viewportHeight: 240,
  }), {
    top: 56,
    left: 8,
    maxWidth: 304,
    maxHeight: 224,
    vertical: "below",
  });
  assert.deepEqual(computeTooltipPlacement({
    anchor: { top: 210, right: 315, bottom: 230, left: 285 },
    tooltipWidth: 180,
    tooltipHeight: 30,
    viewportWidth: 320,
    viewportHeight: 240,
  }), {
    top: 174,
    left: 132,
    maxWidth: 304,
    maxHeight: 224,
    vertical: "above",
  });
  assert.deepEqual(computeTooltipPlacement({
    anchor: { top: 100, right: 175, bottom: 130, left: 145 },
    tooltipWidth: 180,
    tooltipHeight: 500,
    viewportWidth: 320,
    viewportHeight: 240,
  }), {
    top: 8,
    left: 70,
    maxWidth: 304,
    maxHeight: 224,
    vertical: "below",
  });
});

test("nested selection followed by Escape restores the parent row before root Escape", () => {
  const firstEscape = getMenuKeyboardAction("Escape", 5, 0, false);
  assert.deepEqual(firstEscape, { type: "close-current" });
  assert.equal(shouldRestoreMenuFocus("sidebar-filters-menu", ["sidebar-filters-menu"]), true);

  const secondEscape = getMenuKeyboardAction("Escape", 8, 2, false);
  assert.deepEqual(secondEscape, { type: "close-current" });
  assert.equal(shouldRestoreMenuFocus(null, []), true);
});

test("closing a replaced sibling cannot steal focus from the deepest open submenu", () => {
  const root = "sidebar-filters-menu";
  const nextChild = "sidebar-filters-channels-menu";

  assert.equal(shouldRestoreMenuFocus(root, [root, nextChild]), false);
  assert.equal(shouldRestoreMenuFocus(root, [root]), true);
});

test("focus restoration requires the destination menu chain to remain available", () => {
  assert.equal(shouldRestoreMenuFocus("add-menu", []), false);
  assert.equal(shouldRestoreMenuFocus(null, ["add-menu"]), false);
  assert.equal(shouldRestoreMenuFocus(null, []), true);
});

test("aria-pressed is omitted unless the pressed prop is provided", () => {
  assert.equal(optionalAriaPressed(undefined), undefined);
  assert.equal(optionalAriaPressed(false), false);
  assert.equal(optionalAriaPressed(true), true);
});

test("aria descriptions combine caller, tooltip, and badge IDs without blanks or duplicates", () => {
  assert.equal(combineAriaDescribedBy("external", "tooltip", "badge"), "external tooltip badge");
  assert.equal(combineAriaDescribedBy("external tooltip", "tooltip", undefined), "external tooltip");
  assert.equal(combineAriaDescribedBy(undefined, null, ""), undefined);
});
