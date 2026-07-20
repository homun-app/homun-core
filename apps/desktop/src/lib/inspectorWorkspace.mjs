export const INSPECTOR_WIDTH_RATIO_KEY = "homun.inspector.width-ratio.v1";
const STATE_PREFIX = "homun.inspector.thread.v1.";

export const EMPTY_INSPECTOR_STATE = Object.freeze({
  open: false,
  focused: false,
  activeTabId: null,
  tabs: [],
});

export function inspectorStateKey(threadId) {
  return `${STATE_PREFIX}${encodeURIComponent(threadId)}`;
}

export function inspectorWorkspaceReducer(state, action) {
  switch (action.type) {
    case "openTab": {
      const existing = state.tabs.find((item) => item.resourceKey === action.tab.resourceKey);
      if (existing) return { ...state, open: true, activeTabId: existing.id };
      return {
        ...state,
        open: true,
        activeTabId: action.tab.id,
        tabs: [...state.tabs, action.tab],
      };
    }
    case "activateTab":
      return state.tabs.some((item) => item.id === action.tabId)
        ? { ...state, open: true, activeTabId: action.tabId }
        : state;
    case "closeTab": {
      const index = state.tabs.findIndex((item) => item.id === action.tabId);
      if (index < 0) return state;
      const tabs = state.tabs.filter((item) => item.id !== action.tabId);
      if (state.activeTabId !== action.tabId) return { ...state, tabs };
      const next = tabs[index] ?? tabs[index - 1] ?? null;
      return { ...state, tabs, activeTabId: next?.id ?? null };
    }
    case "moveTab": {
      const from = state.tabs.findIndex((item) => item.id === action.tabId);
      if (from < 0) return state;
      const tabs = [...state.tabs];
      const [item] = tabs.splice(from, 1);
      tabs.splice(Math.max(0, Math.min(action.targetIndex, tabs.length)), 0, item);
      return { ...state, tabs };
    }
    case "showWorkspace":
      return { ...state, open: true };
    case "hideWorkspace":
      return { ...state, open: false };
    case "toggleFocus":
      return { ...state, open: true, focused: !state.focused };
    case "replaceState":
      return action.state;
    default:
      return state;
  }
}

export function restoreInspectorState(raw, isAllowed = () => true) {
  try {
    const parsed = JSON.parse(raw ?? "null");
    const tabs = Array.isArray(parsed?.tabs)
      ? parsed.tabs.filter(
          (item) =>
            item &&
            typeof item.id === "string" &&
            typeof item.kind === "string" &&
            typeof item.resourceKey === "string" &&
            typeof item.title === "string" &&
            item.payload &&
            typeof item.payload === "object" &&
            isAllowed(item),
        )
      : [];
    const activeTabId = tabs.some((item) => item.id === parsed?.activeTabId)
      ? parsed.activeTabId
      : (tabs[0]?.id ?? null);
    return {
      open: Boolean(parsed?.open),
      focused: Boolean(parsed?.focused),
      activeTabId,
      tabs,
    };
  } catch {
    return { ...EMPTY_INSPECTOR_STATE, tabs: [] };
  }
}

export function clampInspectorRatio(value, containerWidth, minPane = 420) {
  if (!Number.isFinite(value) || !Number.isFinite(containerWidth) || containerWidth <= 0) {
    return 0.5;
  }
  if (containerWidth < minPane * 2) return 0.5;
  const min = minPane / containerWidth;
  const clamped = Math.min(1 - min, Math.max(min, value));
  return Math.round(clamped * 1_000_000) / 1_000_000;
}

function defaultStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function loadInspectorState(threadId, isAllowed = () => true, storage = defaultStorage()) {
  if (!storage) return { ...EMPTY_INSPECTOR_STATE, tabs: [] };
  try {
    return restoreInspectorState(storage.getItem(inspectorStateKey(threadId)), isAllowed);
  } catch {
    return { ...EMPTY_INSPECTOR_STATE, tabs: [] };
  }
}

export function saveInspectorState(threadId, state, storage = defaultStorage()) {
  if (!storage) return;
  try {
    storage.setItem(
      inspectorStateKey(threadId),
      JSON.stringify({
        open: Boolean(state.open),
        focused: Boolean(state.focused),
        activeTabId: state.activeTabId,
        tabs: state.tabs,
      }),
    );
  } catch {
    // Storage is best-effort; the in-memory workspace remains usable.
  }
}

export function loadInspectorWidthRatio(storage = defaultStorage()) {
  if (!storage) return 0.5;
  try {
    const value = Number(storage.getItem(INSPECTOR_WIDTH_RATIO_KEY));
    return Number.isFinite(value) && value > 0 && value < 1 ? value : 0.5;
  } catch {
    return 0.5;
  }
}

export function saveInspectorWidthRatio(value, storage = defaultStorage()) {
  if (!storage || !Number.isFinite(value) || value <= 0 || value >= 1) return;
  try {
    storage.setItem(INSPECTOR_WIDTH_RATIO_KEY, String(value));
  } catch {
    // Storage is best-effort; the in-memory width remains usable.
  }
}
