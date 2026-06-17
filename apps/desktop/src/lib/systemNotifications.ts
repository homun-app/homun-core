import { focusDesktopWindow } from "./gatewayConfig";

// Native system notifications via the Web Notifications API. Works in Electron's
// renderer (mapped to the macOS Notification Center) AND in a browser on the
// self-hosted web build — one path for both. Clicking brings the app forward and
// runs the supplied handler (e.g. open the relevant thread).

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationPermission(): NotificationPermission {
  return notificationsSupported() ? Notification.permission : "denied";
}

/** Asks the OS for permission (no-op if already decided). Returns the outcome. */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

/** Shows a system notification (no-op if unsupported or not granted). Repeats from
 *  the same `tag` collapse into one. Click → bring the app to the front + onClick. */
export function showSystemNotification(opts: {
  title: string;
  body?: string;
  tag?: string;
  onClick?: () => void;
}): void {
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  try {
    const notification = new Notification(opts.title, {
      body: opts.body,
      tag: opts.tag,
    });
    notification.onclick = () => {
      void focusDesktopWindow();
      try {
        window.focus();
      } catch {
        // ignore — best effort
      }
      opts.onClick?.();
      notification.close();
    };
  } catch {
    // Some platforms throw without a user gesture — degrade silently.
  }
}
