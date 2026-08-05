import { Clock3 } from "lucide-react";
import { useTranslation } from "react-i18next";

export function ChatSystemMessageHeader() {
  const { t } = useTranslation();

  return (
    <header className="assistant-label system-label">
      <Clock3 size={15} />
      <strong>{t("chat.status")}</strong>
      <span>{t("chat.roleSystem")}</span>
    </header>
  );
}
