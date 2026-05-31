import { useCallback, useEffect, useState } from "react";

// Persistent UI settings (local-first): name, preferences and toggles survive
// reloads via localStorage under a single namespace. Backend-owned facts
// (model, runtime, connections, computer) are read live from coreBridge — this
// store is only for user-editable preferences.
const NS = "lfpa.settings.";

export type SettingsKey =
  | "displayName"
  | "workspaceName"
  | "email"
  | "theme"
  | "language"
  | "privacy.localFirst"
  | "privacy.managedCloud"
  | "privacy.approvalGate"
  | "general.streamResponses"
  | "general.soundOnComplete";

export function loadSetting<T>(key: SettingsKey, fallback: T): T {
  try {
    const raw = localStorage.getItem(NS + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveSetting<T>(key: SettingsKey, value: T): void {
  try {
    localStorage.setItem(NS + key, JSON.stringify(value));
    window.dispatchEvent(new CustomEvent("lfpa-setting", { detail: { key } }));
  } catch {
    // Best-effort: a private-mode storage failure must not break the UI.
  }
}

/** A persisted setting as React state: reads on mount, writes on change, and
 *  stays in sync across components via a lightweight custom event. */
export function useSetting<T>(key: SettingsKey, fallback: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => loadSetting(key, fallback));

  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent).detail as { key?: string } | undefined;
      if (detail?.key === key) setValue(loadSetting(key, fallback));
    };
    window.addEventListener("lfpa-setting", onChange);
    return () => window.removeEventListener("lfpa-setting", onChange);
  }, [key, fallback]);

  const update = useCallback(
    (next: T) => {
      setValue(next);
      saveSetting(key, next);
    },
    [key],
  );

  return [value, update];
}
