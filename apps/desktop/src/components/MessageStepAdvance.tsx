import { useTranslation } from "react-i18next";
import { stepAdvanceDisplay } from "../lib/chat-runtime/stepAdvanceDisplay";
import type { StepAdvancePayload } from "../lib/coreBridge";

/** Compact inline notice for a kernel plan-step state change
 *  (`step_advance` stream event), rendered in the transcript flow. */
export function StepAdvanceNote({ payload }: { payload: StepAdvancePayload }) {
  const { t } = useTranslation();
  const display = stepAdvanceDisplay(payload);
  return (
    <p className={`step-advance-note is-${display.kind}`} role="status">
      {t(display.i18nKey, display.params)}
    </p>
  );
}
