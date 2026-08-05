import {
  BookMarked,
  Check,
  Copy,
  FileText,
  MoreHorizontal,
  Pencil,
  Play,
  Reply,
  RotateCcw,
  SquareTerminal,
  Target,
  ThumbsDown,
  ThumbsUp,
  WandSparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatMessage, ChatMessageMetrics } from "../types";

type MessageActionContentKind = "user" | "system" | "text" | "code" | "diagram";
type MessageFeedback = NonNullable<ChatMessage["feedback"]>;

function formatMetricSeconds(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  if (value < 0.01) return "<0,01s";
  if (value < 10) return `${value.toFixed(2).replace(".", ",")}s`;
  return `${value.toFixed(1).replace(".", ",")}s`;
}

function formatRuntimeStatus(status: string | undefined) {
  if (!status) return "-";
  const labels: Record<string, string> = {
    configured: "configurato",
    managed_running: "caldo",
    external_running: "esterno",
    ready: "pronto",
    unhealthy: "non sano",
    duplicate_conflict: "duplicato",
    stopped: "spento",
  };
  return labels[status] ?? status.replace(/_/g, " ");
}

export function MessageActionBar({
  canContinue,
  canExpand,
  canRegenerate,
  canReply,
  canEdit,
  canSaveToMemory,
  canSaveAsGoal,
  contentKind,
  copied,
  feedback,
  metrics,
  savedToMemory,
  onCopy,
  onEdit,
  onContinue,
  onExpand,
  onExplainCode,
  onExplainDiagram,
  onFeedback,
  onImproveCode,
  onReply,
  onRegenerate,
  onReviseDiagram,
  onSaveToMemory,
  onSaveAsGoal,
}: {
  canContinue: boolean;
  canExpand: boolean;
  canRegenerate: boolean;
  canReply: boolean;
  canEdit: boolean;
  canSaveToMemory: boolean;
  canSaveAsGoal: boolean;
  contentKind: MessageActionContentKind;
  copied: boolean;
  feedback: ChatMessage["feedback"];
  metrics?: ChatMessageMetrics;
  savedToMemory: boolean;
  onCopy: () => void;
  onEdit: () => void;
  onContinue: () => void;
  onExpand: () => void;
  onExplainCode: () => void;
  onExplainDiagram: () => void;
  onFeedback: (feedback: MessageFeedback) => void;
  onImproveCode: () => void;
  onReply: () => void;
  onRegenerate: () => void;
  onReviseDiagram: () => void;
  onSaveToMemory: () => void;
  onSaveAsGoal: () => void;
}) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPlacement, setMenuPlacement] =
    useState<MessageActionMenuPlacement>("below");
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const showMoreMenu =
    canExpand ||
    canRegenerate ||
    canSaveToMemory ||
    canSaveAsGoal ||
    contentKind === "code" ||
    contentKind === "diagram";

  useEffect(() => {
    if (!menuOpen) return undefined;

    function updatePlacement() {
      setMenuPlacement(resolveMessageActionMenuPlacement(menuButtonRef.current));
    }

    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [menuOpen]);

  function toggleMoreMenu() {
    setMenuOpen((current) => {
      const next = !current;
      if (next) {
        setMenuPlacement(resolveMessageActionMenuPlacement(menuButtonRef.current));
      }
      return next;
    });
  }

  function runMessageMenuAction(action: () => void) {
    setMenuOpen(false);
    action();
  }

  return (
    <div className="message-action-bar" aria-label={t("chat.messageActions")}>
      {canEdit && (
        <button type="button" onClick={onEdit} aria-label={t("chat.editMessage")} title={t("common.edit")}>
          <Pencil size={14} />
          <span>{t("common.edit")}</span>
        </button>
      )}
      {canReply && (
        <button type="button" onClick={onReply} aria-label={t("chat.replyToMessage")} title="Reply">
          <Reply size={14} />
          <span>{t("chat.action.reply")}</span>
        </button>
      )}
      <button
        type="button"
        onClick={onCopy}
        aria-label={t("chat.copyMessage")}
        title={copied ? t("common.copied") : t("common.copy")}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        <span>{copied ? t("common.copied") : t("common.copy")}</span>
      </button>
      {canContinue && (
        <button
          className="primary-continue-action"
          type="button"
          onClick={onContinue}
          aria-label={t("chat.action.continueResponse")}
        >
          <Play size={14} />
          <span>{t("chat.action.continue")}</span>
        </button>
      )}
      {showMoreMenu && (
        <div className="message-action-menu-wrap">
          <button
            ref={menuButtonRef}
            type="button"
            aria-expanded={menuOpen}
            aria-label={t("chat.moreActions")}
            onClick={toggleMoreMenu}
          >
            <MoreHorizontal size={14} />
          </button>
          {menuOpen && (
            <div className={`message-action-menu ${menuPlacement}`} role="menu">
              {canExpand && (
                <button type="button" role="menuitem" onClick={() => runMessageMenuAction(onExpand)}>
                  <Play size={14} />
                  <span>{t("chat.action.expand")}</span>
                </button>
              )}
              {contentKind === "code" && (
                <>
                  <button type="button" role="menuitem" onClick={() => runMessageMenuAction(onExplainCode)}>
                    <SquareTerminal size={14} />
                    <span>{t("chat.action.explainCode")}</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => runMessageMenuAction(onImproveCode)}>
                    <WandSparkles size={14} />
                    <span>{t("chat.action.improveCode")}</span>
                  </button>
                </>
              )}
              {contentKind === "diagram" && (
                <>
                  <button type="button" role="menuitem" onClick={() => runMessageMenuAction(onExplainDiagram)}>
                    <FileText size={14} />
                    <span>{t("chat.action.explainDiagram")}</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => runMessageMenuAction(onReviseDiagram)}>
                    <WandSparkles size={14} />
                    <span>{t("chat.action.editDiagram")}</span>
                  </button>
                </>
              )}
              {canRegenerate && (
                <button type="button" role="menuitem" onClick={() => runMessageMenuAction(onRegenerate)}>
                  <RotateCcw size={14} />
                  <span>{t("chat.action.regenerate")}</span>
                </button>
              )}
              {canSaveToMemory && (
                <button
                  className={savedToMemory ? "active" : ""}
                  type="button"
                  role="menuitem"
                  onClick={() => runMessageMenuAction(onSaveToMemory)}
                >
                  <BookMarked size={14} />
                  <span>{savedToMemory ? t("chat.savedToMemory") : t("chat.saveToMemory")}</span>
                </button>
              )}
              {canSaveAsGoal && (
                <button type="button" role="menuitem" onClick={() => runMessageMenuAction(onSaveAsGoal)}>
                  <Target size={14} />
                  <span>{t("chat.action.saveAsGoal")}</span>
                </button>
              )}
              <div className="message-action-menu-feedback" aria-label={t("chat.responseFeedback")}>
                <button
                  className={feedback === "useful" ? "active" : ""}
                  type="button"
                  onClick={() => onFeedback("useful")}
                  aria-label={t("chat.markHelpful")}
                >
                  <ThumbsUp size={14} />
                </button>
                <button
                  className={feedback === "not_useful" ? "active" : ""}
                  type="button"
                  onClick={() => onFeedback("not_useful")}
                  aria-label={t("chat.markNotHelpful")}
                >
                  <ThumbsDown size={14} />
                </button>
              </div>
              {metrics && (
                <div
                  className="message-latency-summary"
                  aria-label={t("chat.messageMetrics")}
                >
                  <strong>{t("chat.metrics")}</strong>
                  <span>
                    Time to first token
                    <b>{formatMetricSeconds(metrics.timeToFirstTokenSeconds)}</b>
                  </span>
                  <span>
                    {t("chat.generation")}
                    <b>{formatMetricSeconds(metrics.elapsedSeconds)}</b>
                  </span>
                  <span>
                    Totale
                    <b>{formatMetricSeconds(metrics.totalElapsedSeconds)}</b>
                  </span>
                  <span>
                    Prompt build
                    <b>{formatMetricSeconds(metrics.promptBuildSeconds)}</b>
                  </span>
                  <span>
                    Runtime prima
                    <b>{formatRuntimeStatus(metrics.runtimeStatusBefore)}</b>
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type MessageActionMenuPlacement = "above" | "below";

const MESSAGE_ACTION_MENU_MIN_BOTTOM_SPACE = 300;

function resolveMessageActionMenuPlacement(
  anchor: HTMLElement | null,
): MessageActionMenuPlacement {
  if (!anchor) return "below";

  const rect = anchor.getBoundingClientRect();
  const scrollContainer = anchor.closest(".thread-scroll");
  const visibleBottom =
    scrollContainer instanceof HTMLElement
      ? scrollContainer.getBoundingClientRect().bottom
      : window.innerHeight;
  const spaceBelow = visibleBottom - rect.bottom;
  const spaceAbove = rect.top;

  if (
    spaceBelow < MESSAGE_ACTION_MENU_MIN_BOTTOM_SPACE &&
    spaceAbove > spaceBelow
  ) {
    return "above";
  }

  return "below";
}
