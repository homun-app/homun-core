import { ChevronLeft, ChevronRight, Tag } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CoreBranchPoint } from "../lib/coreBridge";

interface ChatBranchPickerProps {
  point: CoreBranchPoint;
  busy: boolean;
  onSwitch: (direction: number) => void;
  onRename: (label: string | null) => void;
}

export function ChatBranchPicker({
  point,
  busy,
  onSwitch,
  onRename,
}: ChatBranchPickerProps) {
  const { t } = useTranslation();
  const active = point.options[point.active_index];
  const label = active?.label ?? null;

  return (
    <div className="branch-picker" aria-label={t("chat.responseVariants")}>
      <button
        type="button"
        aria-label={t("chat.prevVariant")}
        disabled={busy || point.active_index === 0}
        onClick={() => onSwitch(-1)}
      >
        <ChevronLeft size={14} />
      </button>
      <span>
        {point.active_index + 1} / {point.options.length}
      </span>
      <button
        type="button"
        aria-label={t("chat.nextVariant")}
        disabled={busy || point.active_index === point.options.length - 1}
        onClick={() => onSwitch(1)}
      >
        <ChevronRight size={14} />
      </button>
      {label && <span className="branch-label">{label}</span>}
      <button
        type="button"
        className="branch-rename"
        aria-label={t("chat.branchLabelAria")}
        title={t("chat.branchLabelAria")}
        onClick={() => onRename(label)}
      >
        <Tag size={13} />
      </button>
    </div>
  );
}
