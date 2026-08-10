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
export function deriveBrowserStatus(
  computerLiveStatus: ComputerLiveStatusLike,
  previewDataUrl: string | null,
  computerControlError: string | null,
): BrowserStatus {
  return {
    active: computerLiveStatus.active,
    snapshotVerified: Boolean(previewDataUrl),
    failed: computerControlError !== null,
  };
}
