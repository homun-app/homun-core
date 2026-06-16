import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Monitor, Bell, Download } from "lucide-react";
import { coreBridge, type SystemStatus, type UpdateInfo } from "../lib/coreBridge";
import {
  IS_DESKTOP,
  checkDesktopUpdate,
  installDesktopUpdate,
} from "../lib/gatewayConfig";

/**
 * Notifications inbox (behind the sidebar bell). Surfaces actionable system
 * state — for now the contained "Local computer": off → Enable, or unavailable
 * when Docker isn't present (e.g. a PaaS deploy without the socket). Designed to
 * grow (update-available, proactivity check-ins can feed the same list).
 */
export function NotificationsView() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [enableMsg, setEnableMsg] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [desktopUpdate, setDesktopUpdate] = useState<{ version: string | null } | null>(null);

  const refresh = async () => {
    try {
      setStatus(await coreBridge.systemStatus());
    } catch {
      /* ignore — keep last known */
    }
    if (IS_DESKTOP) {
      // Desktop updates come from electron-updater (the public releases feed),
      // not the redeploy webhook — ask the Electron shell directly.
      const result = await checkDesktopUpdate();
      setDesktopUpdate(result?.available ? { version: result.version } : null);
    } else {
      try {
        setUpdate(await coreBridge.updateInfo());
      } catch {
        /* ignore */
      }
    }
  };

  // Cloud path: ask the orchestrator to redeploy the latest image via webhook.
  const runUpdate = async () => {
    setUpdating(true);
    setUpdateMsg(null);
    try {
      const result = await coreBridge.triggerUpdate();
      setUpdateMsg(result.ok ? t("notifications.updateStarted") : (result.message ?? ""));
    } catch (error) {
      setUpdateMsg(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdating(false);
    }
  };

  // Desktop path: download the pending release in-app and restart into it.
  const runDesktopUpdate = async () => {
    setUpdating(true);
    setUpdateMsg(null);
    try {
      const result = await installDesktopUpdate();
      if (!result.ok) setUpdateMsg(result.error ?? "");
      // On success the app quits and relaunches — nothing more to render.
    } catch (error) {
      setUpdateMsg(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdating(false);
    }
  };

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(id);
  }, []);

  const enableComputer = async () => {
    setEnabling(true);
    setEnableMsg(null);
    try {
      const result = await coreBridge.startLocalComputer();
      if (!result.ok) {
        setEnableMsg(result.message ?? t("settings.localComputerDockerOff"));
      }
    } catch (error) {
      setEnableMsg(error instanceof Error ? error.message : String(error));
    } finally {
      setEnabling(false);
      void refresh();
    }
  };

  const items: ReactNode[] = [];
  // Desktop: a newer release is published — download + restart in-app.
  if (IS_DESKTOP && desktopUpdate) {
    items.push(
      <NotifCard
        key="desktop-update"
        icon={<Download size={16} />}
        title={t("notifications.updateTitle")}
        body={
          updateMsg ??
          t("notifications.desktopUpdateBody", {
            version: desktopUpdate.version ?? "",
          })
        }
        action={
          <button
            type="button"
            className="notif-action"
            disabled={updating}
            onClick={() => void runDesktopUpdate()}
          >
            {updating ? t("notifications.updating") : t("notifications.update")}
          </button>
        }
      />,
    );
  }
  // Cloud: a one-click redeploy to the latest image (the container can't replace
  // itself — it asks the orchestrator via the configured webhook).
  if (!IS_DESKTOP && update?.webhook_configured) {
    items.push(
      <NotifCard
        key="update"
        icon={<Download size={16} />}
        title={t("notifications.updateTitle")}
        body={updateMsg ?? t("notifications.updateBody")}
        action={
          <button
            type="button"
            className="notif-action"
            disabled={updating}
            onClick={() => void runUpdate()}
          >
            {updating ? t("notifications.updating") : t("notifications.update")}
          </button>
        }
      />,
    );
  }
  if (status) {
    if (!status.docker.running) {
      items.push(
        <NotifCard
          key="cc-nodocker"
          icon={<Monitor size={16} />}
          title={t("notifications.computerUnavailableTitle")}
          body={t("settings.localComputerDockerOff")}
        />,
      );
    } else if (!status.docker.container_up) {
      items.push(
        <NotifCard
          key="cc-off"
          icon={<Monitor size={16} />}
          title={t("notifications.computerOffTitle")}
          body={enableMsg ?? t("notifications.computerOffBody")}
          action={
            <button
              type="button"
              className="notif-action"
              disabled={enabling}
              onClick={() => void enableComputer()}
            >
              {enabling ? t("settings.starting") : t("notifications.enable")}
            </button>
          }
        />,
      );
    }
  }

  return (
    <div className="notif-view">
      <header className="notif-head">
        <h1 className="notif-title">{t("notifications.title")}</h1>
        <p className="notif-sub">{t("notifications.subtitle")}</p>
      </header>
      {items.length === 0 ? (
        <div className="notif-empty">
          <Bell size={20} />
          <span>{t("notifications.empty")}</span>
        </div>
      ) : (
        <ul className="notif-list">{items}</ul>
      )}
    </div>
  );
}

function NotifCard({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <li className="notif-card">
      <span className="notif-icon">{icon}</span>
      <div className="notif-text">
        <div className="notif-card-title">{title}</div>
        <div className="notif-card-body">{body}</div>
      </div>
      {action && <div className="notif-card-action">{action}</div>}
    </li>
  );
}
