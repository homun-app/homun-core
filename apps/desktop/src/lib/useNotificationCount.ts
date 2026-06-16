import { useEffect, useState } from "react";
import { coreBridge } from "./coreBridge";
import { IS_DESKTOP, checkDesktopUpdate } from "./gatewayConfig";

/**
 * Count of actionable notifications, for the sidebar bell badge. Mirrors the
 * cards shown in NotificationsView: the contained computer needing attention
 * (off / Docker absent) + an available update (desktop release or cloud webhook).
 *
 * System status is local + cheap (polled every 15s); the desktop update check
 * hits the GitHub releases feed, so it runs only on mount + every 5 minutes.
 */
export function useNotificationCount(): number {
  const [computer, setComputer] = useState(0);
  const [update, setUpdate] = useState(0);

  useEffect(() => {
    let alive = true;

    const tickStatus = async () => {
      try {
        const s = await coreBridge.systemStatus();
        if (alive) setComputer(s && !s.docker.container_up ? 1 : 0);
      } catch {
        // keep last known
      }
    };

    const tickUpdate = async () => {
      if (IS_DESKTOP) {
        const u = await checkDesktopUpdate();
        if (alive) setUpdate(u?.available ? 1 : 0);
      } else {
        try {
          const u = await coreBridge.updateInfo();
          if (alive) setUpdate(u?.webhook_configured ? 1 : 0);
        } catch {
          // ignore
        }
      }
    };

    void tickStatus();
    void tickUpdate();
    const statusId = window.setInterval(() => void tickStatus(), 15_000);
    const updateId = window.setInterval(() => void tickUpdate(), 300_000);
    return () => {
      alive = false;
      window.clearInterval(statusId);
      window.clearInterval(updateId);
    };
  }, []);

  return computer + update;
}
