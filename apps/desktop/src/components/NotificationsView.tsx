import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Monitor, Bell } from "lucide-react";
import { coreBridge, type SystemStatus } from "../lib/coreBridge";

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

  const refresh = async () => {
    try {
      setStatus(await coreBridge.systemStatus());
    } catch {
      /* ignore — keep last known */
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
