import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import { coreBridge, type UpdateInfo } from "../lib/coreBridge";
import {
  IS_DESKTOP,
  checkDesktopUpdate,
  installDesktopUpdate,
  onDesktopUpdateProgress,
} from "../lib/gatewayConfig";

/**
 * A single discreet "update available" pill at the top of the sidebar. Replaces the old
 * notification bell + full NotificationsView page: an app update is the only thing that inbox
 * really carried, and the design calls for a compact top indicator (OS notifications cover the
 * rest). Renders NOTHING until an update is actually available, so the sidebar stays minimal.
 *
 * Two backends, same affordance: desktop downloads the pending electron-updater release in-app
 * (live percent → restart), cloud asks the orchestrator to redeploy via the configured webhook.
 */
export function UpdatePill() {
  const { t } = useTranslation();
  const [desktopVersion, setDesktopVersion] = useState<string | null>(null);
  const [cloudUpdate, setCloudUpdate] = useState<UpdateInfo | null>(null);
  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      if (IS_DESKTOP) {
        const result = await checkDesktopUpdate();
        if (alive) setDesktopVersion(result?.available ? (result.version ?? null) : null);
      } else {
        try {
          const info = await coreBridge.updateInfo();
          if (alive) setCloudUpdate(info?.webhook_configured ? info : null);
        } catch {
          /* ignore — keep last known */
        }
      }
    };
    void check();
    // Desktop hits the GitHub releases feed, so poll gently (every 5 min), matching the old badge.
    const id = window.setInterval(() => void check(), 300_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const available = IS_DESKTOP ? desktopVersion !== null : cloudUpdate !== null;
  if (!available) return null;

  const runDesktopUpdate = async () => {
    setUpdating(true);
    setError(null);
    setProgress(0);
    const unsubscribe = onDesktopUpdateProgress((p) => setProgress(p.percent));
    try {
      const result = await installDesktopUpdate();
      // On success the app quits into the new build, so we never clear `updating`.
      if (!result.ok) {
        setError(result.error ?? "");
        setUpdating(false);
        setProgress(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setUpdating(false);
      setProgress(null);
    } finally {
      unsubscribe();
    }
  };

  const runCloudUpdate = async () => {
    setUpdating(true);
    setError(null);
    try {
      const result = await coreBridge.triggerUpdate();
      if (!result.ok) setError(result.message ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdating(false);
    }
  };

  const label = updating
    ? IS_DESKTOP && (progress ?? 0) < 100
      ? t("notifications.downloading", { percent: progress ?? 0 })
      : IS_DESKTOP
        ? t("notifications.restarting")
        : t("notifications.updating")
    : t("notifications.updateTitle");

  return (
    <button
      type="button"
      className="update-pill"
      disabled={updating}
      title={
        error ||
        (IS_DESKTOP && desktopVersion
          ? t("notifications.desktopUpdateBody", { version: desktopVersion })
          : t("notifications.updateBody"))
      }
      onClick={() => void (IS_DESKTOP ? runDesktopUpdate() : runCloudUpdate())}
    >
      <Download size={14} />
      <span className="update-pill-label">{label}</span>
    </button>
  );
}
