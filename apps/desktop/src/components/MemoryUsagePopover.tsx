import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RecallHitPayload } from "../lib/coreBridge";
import { MemoryPublicationDialog } from "./MemoryPublicationDialog";

type SourceGroup = {
  id: string;
  label: string;
  hits: RecallHitPayload[];
};

function groupHitsBySource(hits: RecallHitPayload[]): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const hit of hits) {
    // Old persisted messages can predate provenance. Keep them readable while
    // grouping every new payload by its canonical source workspace.
    const id = hit.source_workspace_id || "unknown";
    const label = hit.source_label || id;
    const group = groups.get(id) ?? { id, label, hits: [] };
    group.hits.push(hit);
    groups.set(id, group);
  }
  return [...groups.values()];
}

/**
 * Compact, message-scoped disclosure of the memories actually used for an answer.
 * It is deliberately a popover rather than a persistent transcript: provenance is
 * available on demand without leaking recalled text into hover tooltips.
 */
export function MemoryUsagePopover({
  hits,
  buttonLabel,
  consumerWorkspaceId,
  onPublicationApproved,
}: {
  hits: RecallHitPayload[];
  buttonLabel: string;
  consumerWorkspaceId: string | null | undefined;
  onPublicationApproved: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [publicationHit, setPublicationHit] = useState<RecallHitPayload | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const publicationOpenerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId().replace(/:/g, "");
  const groups = useMemo(() => groupHitsBySource(hits), [hits]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (hits.length === 0) return null;

  return (
    <span className="memory-usage-anchor" ref={rootRef}>
      <button
        type="button"
        className="memory-recall-badge"
        aria-expanded={open}
        aria-controls={popoverId}
        aria-label={buttonLabel}
        title={buttonLabel}
        onClick={() => setOpen((current) => !current)}
      >
        📝 {buttonLabel}
      </button>
      {open && (
        <section
          id={popoverId}
          className="memory-usage-popover"
          role="region"
          aria-label={buttonLabel}
        >
          <strong className="memory-usage-title">{buttonLabel}</strong>
          <div className="memory-usage-groups">
            {groups.map((group) => (
              <section className="memory-usage-source" key={group.id}>
                <header>
                  <strong>{group.label}</strong>
                  <span>{group.hits.length}</span>
                </header>
                <ul>
                  {group.hits.map((hit, index) => (
                    <li key={`${hit.ref || hit.text}-${index}`}>
                      <span>{hit.text}</span>
                      <small>
                        {t(`memoryCollections.${hit.collection}`, {
                          defaultValue: hit.collection,
                        })}
                        {hit.grant_id ? ` · ${t("chat.memoryLinked")}` : ""}
                        {hit.conflict ? ` · ${t("chat.memoryConflict")}` : ""}
                      </small>
                      {consumerWorkspaceId?.trim()
                        && consumerWorkspaceId !== "__personal__"
                        && hit.source_workspace_id === consumerWorkspaceId
                        && hit.grant_id === null ? (
                        <button
                          type="button"
                          className="memory-publication-trigger"
                          onClick={(event) => {
                            publicationOpenerRef.current = event.currentTarget;
                            setPublicationHit(hit);
                          }}
                        >
                          {t("memoryPublication.publish")}
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </section>
      )}
      {publicationHit ? (
        <MemoryPublicationDialog
          sourceRef={publicationHit.ref}
          sourceWorkspaceId={publicationHit.source_workspace_id}
          opener={publicationOpenerRef.current}
          onClose={() => setPublicationHit(null)}
          onPublished={() => {
            setOpen(false);
            setPublicationHit(null);
            return onPublicationApproved();
          }}
        />
      ) : null}
    </span>
  );
}
