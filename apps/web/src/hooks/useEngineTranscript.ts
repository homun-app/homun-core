/** Load only the selected durable conversation; cancel stale requests on navigation. */
import { useEffect, useState, useRef, type Dispatch, type SetStateAction } from "react";
import type { ConversationMessage } from "@/components/builder/conversation-types";
import {
  loadEngineTranscript,
  mergeTranscriptAnnotations,
  type TranscriptAnnotation,
} from "@/lib/engine-transcript-client";
import { canDropOverlay, planTranscriptLoad, type TranscriptView } from "@/lib/engine-transcript-lifecycle";

type Overlay = Record<string, ConversationMessage[]>;
export function useEngineTranscript(
  enabled: boolean,
  activeId: string | null,
  rawWorks: Array<Record<string, unknown>>,
  overlay: Overlay,
  setOverlay: Dispatch<SetStateAction<Overlay>>,
  onError: (cause: unknown) => void,
  reloadSeq: number,
) {
  const [history, setHistory] = useState<{
    workId: string;
    messages: ConversationMessage[];
  } | null>(null);
  const annotationsRef = useRef<Record<string, TranscriptAnnotation[]>>({});
  const overlayRef = useRef(overlay);
  overlayRef.current = overlay;
  const viewRef = useRef<TranscriptView>({ activeId: null, conversationId: undefined, reloadSeq: -1 });
  const conversationId = rawWorks.find((work) => work["id"] === activeId)?.[
    "primary_conversation_id"
  ];
  useEffect(() => {
    // Inventory refreshes re-render with a new rawWorks array identity; the
    // value-based comparison below keeps them from interrupting the reader.
    const next: TranscriptView = {
      activeId,
      conversationId: typeof conversationId === "string" ? conversationId : undefined,
      reloadSeq,
    };
    const plan = planTranscriptLoad(viewRef.current, next);
    viewRef.current = next;
    if (!plan.load) return;
    const controller = new AbortController();
    const annotations = [
      ...(annotationsRef.current[activeId!] ?? []),
      ...(overlayRef.current[activeId!] ?? []),
    ];
    if (plan.clearFirst) {
      // Switching work must drop cached content immediately (permissions may differ).
      setHistory(null);
      setOverlay((current) => {
        const nextOverlay = { ...current };
        delete nextOverlay[activeId!];
        return nextOverlay;
      });
    }
    void loadEngineTranscript(conversationId as string, controller.signal)
      .then((messages) => {
        if (controller.signal.aborted) return;
        const merged = mergeTranscriptAnnotations(messages, annotations);
        // Keep only annotations, never cached transcript text or denied rows.
        annotationsRef.current[activeId!] = merged.map(
          ({ engineMessageId, memorySaved, patchResolved }) => ({
            ...(engineMessageId ? { engineMessageId } : {}),
            ...(memorySaved ? { memorySaved } : {}),
            ...(patchResolved ? { patchResolved } : {}),
          }),
        );
        setHistory({ workId: activeId!, messages: merged });
        if (canDropOverlay(overlayRef.current[activeId!])) {
          setOverlay((current) => {
            const nextOverlay = { ...current };
            delete nextOverlay[activeId!];
            return nextOverlay;
          });
        }
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        delete annotationsRef.current[activeId!];
        // Denied or failed reads must not leave previously visible content.
        setHistory({ workId: activeId!, messages: [] });
        setOverlay((current) => {
          const nextOverlay = { ...current };
          delete nextOverlay[activeId!];
          return nextOverlay;
        });
        onError(cause);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, activeId, conversationId, reloadSeq]);
  return {
    history,
    loading: !!(
      enabled &&
      activeId &&
      typeof conversationId === "string" &&
      history?.workId !== activeId
    ),
  };
}
