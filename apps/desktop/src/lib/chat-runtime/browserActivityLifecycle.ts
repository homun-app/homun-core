// Node tests and the application share the same pure implementation.
// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./browserActivityLifecycle.mjs";

export interface ComputerLiveStatusLike {
  active: boolean;
  activity: string | null;
}

export interface BrowserStatus {
  active: boolean;
  snapshotVerified: boolean;
  failed: boolean;
}

/**
 * Derive the browser status object for workspace sections from the live
 * computer session state. Pure function — no React, no side-effects.
 *
 * `active`      — the gateway reports the browser session as running.
 * `snapshotVerified` — a preview artifact has been loaded (non-null data URL).
 * `failed`      — the last control action returned an error.
 */
export const deriveBrowserStatus: (
  computerLiveStatus: ComputerLiveStatusLike,
  previewDataUrl: string | null,
  computerControlError: string | null,
) => BrowserStatus = implementation.deriveBrowserStatus as (
  computerLiveStatus: ComputerLiveStatusLike,
  previewDataUrl: string | null,
  computerControlError: string | null,
) => BrowserStatus;
