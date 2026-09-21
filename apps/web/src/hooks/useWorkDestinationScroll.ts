/**
 * Deep-link landing on work open: instead of the raw bottom, focus the pending
 * contribution request, the delivery, or the newest message.
 */
import { useEffect, type RefObject } from "react";

export type WorkDestination = { id: string; selector: string; stamp: number } | null;

export function useWorkDestinationScroll(
  ref: RefObject<HTMLDivElement | null>,
  options: {
    destination: WorkDestination;
    active: string | null;
    spaceOpen: boolean;
    requestStatus?: string | undefined;
    phase?: string | undefined;
  },
): void {
  const { destination, active, spaceOpen, requestStatus, phase } = options;
  useEffect(() => {
    if (!destination || active !== destination.id || spaceOpen) return;
    const frame = requestAnimationFrame(() => {
      const selector =
        destination.selector ||
        (requestStatus === "pending"
          ? "[data-chat-request]"
          : phase === "review" || phase === "approved"
            ? "[data-chat-delivery]"
            : ".cw-message:last-of-type");
      const element = ref.current?.querySelector<HTMLElement>(selector);
      if (element) {
        element.scrollIntoView({ block: "start", behavior: "instant" });
        element.tabIndex = -1;
        element.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [destination, active, spaceOpen, requestStatus, phase, ref]);
}
