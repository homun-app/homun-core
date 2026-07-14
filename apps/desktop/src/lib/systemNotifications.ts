import { IS_DESKTOP, focusDesktopWindow } from "./gatewayConfig";

// ONE entry point for system notifications, with two transports underneath.
//
// DESKTOP: the notification is posted by the Electron MAIN process (native `Notification`) through the
// `notify` bridge. Same call, same behaviour on macOS (Notification Center), Windows (toast) and Linux
// (libnotify), and — crucially — it does not depend on the renderer's permission state.
//
// WEB (self-hosted build): there is no main process, so we fall back to the browser's Web Notification
// API, which is where the permission dance actually belongs.
//
// This split exists because the old code used the Web API for BOTH, and in Electron that path failed
// in complete silence: the renderer read `Notification.permission === "granted"` (Electron's default
// permission CHECK) while the app's permission REQUEST handler denied notifications, `new
// Notification()` threw nothing, and the OS never displayed a thing. Every layer reported success. The
// fix is not a bigger try/catch — it is to stop asking the renderer to do a job the main process owns.

export type NotifyResult = { shown: boolean; reason?: string };

function bridge() {
  return typeof window === "undefined" ? undefined : window.localFirstDesktop;
}

/** Click routing: the main process hands back the notification's `tag`, we look up its handler here. */
const clickHandlers = new Map<string, () => void>();
let clickBridgeBound = false;

function bindClickBridge(): void {
  if (clickBridgeBound) return;
  const onClick = bridge()?.onNotificationClick;
  if (!onClick) return;
  clickBridgeBound = true;
  onClick((tag) => {
    const handler = clickHandlers.get(tag);
    clickHandlers.delete(tag);
    handler?.();
  });
}

export function notificationsSupported(): boolean {
  if (bridge()?.notify) return true;
  return typeof window !== "undefined" && "Notification" in window;
}

/** On the desktop the main process owns delivery, so there is no renderer permission to hold: report
 *  "granted" and let `showSystemNotification` tell the truth about what actually happened. */
export function notificationPermission(): NotificationPermission {
  if (IS_DESKTOP && bridge()?.notify) return "granted";
  return typeof window !== "undefined" && "Notification" in window
    ? Notification.permission
    : "denied";
}

/** Asks the OS for permission (web only — a no-op on the desktop). Returns the outcome. */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (IS_DESKTOP && bridge()?.notify) return "granted";
  if (typeof window === "undefined" || !("Notification" in window)) return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

/** Shows a system notification. Repeats from the same `tag` collapse into one. Click → bring the app
 *  forward + run `onClick`.
 *
 *  Returns whether the OS actually showed it: a refusal is something the user must be able to SEE
 *  (Settings → Test), not something we swallow — swallowing it is what let this stay broken. */
export async function showSystemNotification(opts: {
  title: string;
  body?: string;
  tag?: string;
  onClick?: () => void;
}): Promise<NotifyResult> {
  const notify = bridge()?.notify;
  if (notify) {
    bindClickBridge();
    if (opts.tag && opts.onClick) clickHandlers.set(opts.tag, opts.onClick);
    try {
      return await notify({ title: opts.title, body: opts.body, tag: opts.tag });
    } catch (error) {
      return { shown: false, reason: String(error) };
    }
  }

  // Web build.
  if (typeof window === "undefined" || !("Notification" in window)) {
    return { shown: false, reason: "unsupported" };
  }
  if (Notification.permission !== "granted") {
    return { shown: false, reason: "denied" };
  }
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
    return { shown: true };
  } catch (error) {
    return { shown: false, reason: String(error) };
  }
}
