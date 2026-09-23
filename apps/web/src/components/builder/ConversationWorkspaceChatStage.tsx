/**
 * Chat stage: history + composer for agent conversations.
 * Owns presentation; shell owns state and passes storageStatus / callbacks.
 */

import { EngineWorkIntake } from "./EngineWorkIntake";
import { Check, Sparkles, X } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { ConversationAgentWait } from "./ConversationAgentWait";
import { ConversationAvatar } from "./ConversationAvatar";
import type { CatalogPlan } from "./ConversationCatalogPlan";
import { isHumanMember, memberProfile } from "./conversation-members";
import type { ConversationScenario } from "./conversation-scenarios";
import type { SpaceData } from "./ConversationSpace";
import { ConversationWorkspaceWelcome } from "./ConversationWorkspaceWelcome";
import type { Work } from "./conversation-types";
import type { WorkIntakeState } from "@/hooks/useWorkIntake";
import { StudioChatInput } from "./StudioChatInput";
import { WorkPatchPreviewCard } from "./WorkPatchPreviewCard";
import type { EngineAgentProfile } from "@/lib/engine-agents-client";

type Props = {
  work: Work | undefined;
  scenario: ConversationScenario | null;
  panelOpen: boolean;
  spaceData: SpaceData;
  scenarios: (ConversationScenario & { custom?: boolean })[];
  assignee: string;
  active: string | null;
  viewer: string;
  notice: string;
  storageStatus: string;
  planEdit: { workId: string; plan: CatalogPlan } | null;
  contributionPanel: ReactNode;
  conversationActions: (w: Work) => ReactNode;
  historyRef: RefObject<HTMLDivElement | null>;
  details: ReactNode;
  onCreateExample: (index: number) => void;
  onOpenWork: (id: string | null) => void;
  onPreview: () => void;
  onApprovePlan: () => void;
  onApplyPlanEdit: (plan: CatalogPlan) => void;
  onCancelPlanEdit: () => void;
  onSend: (text: string, attachments: File[]) => void;
  onClearNotice: () => void;
  engineMode?: boolean;
  engineAgents?: EngineAgentProfile[] | undefined;
  engineIntake?: WorkIntakeState | undefined;
  onRefreshEngine: () => Promise<void>;
  engineBusy?: boolean;
  historyLoading?: boolean;
  onConfirmPatch?: (messageIndex: number) => void;
  onDiscardPatch?: (messageIndex: number) => void;
  onSaveMemory?: ((messageIndex: number) => void) | undefined;
  onSaveSkill?: ((messageIndex: number) => void) | undefined;
  onCancelInFlight?: () => void;
};

export function ConversationWorkspaceChatStage({
  work,
  scenario,
  panelOpen,
  spaceData,
  scenarios,
  assignee,
  active,
  viewer,
  notice,
  storageStatus,
  planEdit,
  contributionPanel,
  conversationActions,
  historyRef,
  details,
  onCreateExample,
  onOpenWork,
  onPreview,
  onApprovePlan,
  onApplyPlanEdit,
  onCancelPlanEdit,
  onSend,
  onClearNotice,
  engineIntake,
  onRefreshEngine,
  engineMode = false,
  engineAgents,
  engineBusy = false,
  historyLoading = false,
  onConfirmPatch,
  onDiscardPatch,
  onSaveMemory,
  onSaveSkill,
  onCancelInFlight,
}: Props) {
  const mentionRefs = [
    ...scenarios
      .filter(
        (s, i) =>
          memberProfile(s.agent, spaceData.profiles).invitation !== "pending" &&
          scenarios.findIndex((a) => a.agent === s.agent) === i &&
          !spaceData.removedPeople?.includes(s.agent),
      )
      .map((s) => ({
        id: s.agent,
        name: s.agent,
        kind: "member" as const,
        description: s.role,
      })),
    // Engine roster members are mentionable too: the squad the person built
    // with the motor must answer @ even when no demo scenario carries them.
    ...(engineAgents ?? [])
      .filter((agent) => agent.status === "active")
      .filter((agent) => !scenarios.some((s) => s.agent === agent.name))
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        kind: "member" as const,
        description: agent.role,
      })),
  ];

  return (
    <div className={`cw-stage ${work && panelOpen ? "with-panel" : ""}`}>
      <section className="cw-conversation">
        {work && scenario && spaceData.removedPeople?.includes(scenario.agent) && (
          <p role="status" className="cw-hint">
            Agente eliminato · conversazione conservata nello storico. Le nuove esecuzioni sono
            disabilitate.
          </p>
        )}
        {work && scenario && (
          <div className="cw-conversation-head">
            <ConversationAvatar
              name={scenario.agent}
              human={isHumanMember(scenario.agent, spaceData.profiles)}
              large
            />
            <div>
              <strong>{work.catalogPlan ? work.title : scenario.agent}</strong>
              <span>
                {work.catalogPlan ? "Conversazione del lavoro" : scenario.role} <i />{" "}
                {work.autonomy === "autonomous"
                  ? "Autonomo su questo lavoro"
                  : "Sotto supervisione"}
              </span>
            </div>
            <span className="cw-private">Conversazione di lavoro</span>
            {conversationActions(work)}
          </div>
        )}
        <div className="cw-history" ref={historyRef}>
          {!work ? (
            <ConversationWorkspaceWelcome
              assignee={assignee}
              scenarios={scenarios}
              spaceData={spaceData}
              onCreateExample={onCreateExample}
              engineMode={engineMode}
            />
          ) : (
            <>
              <div className="cw-date">OGGI · IL LAVORO COMINCIA QUI</div>
              {work.messages.map((m, i) => (
                <article
                  key={i}
                  data-message={`${work.id}:${i}`}
                  className={`cw-message ${m.who}`}
                >
                  <small>
                    {m.sender || (m.who === "you" ? work.requester || "Tu" : scenario!.agent)}
                  </small>
                  {m.wait ? (
                    <ConversationAgentWait phase={m.wait.phase} startedAt={m.wait.startedAt} />
                  ) : (
                    <p className={m.partial ? "cw-message-partial" : undefined}>{m.text}</p>
                  )}
                  {engineMode &&
                    m.who === "agent" &&
                    !m.partial &&
                    onSaveMemory &&
                    (m.memorySaved ? (
                      <p className="cw-hint cw-memory-saved">Salvato in memoria</p>
                    ) : (
                      <button
                        type="button"
                        className="cs-link cw-memory-promote"
                        disabled={engineBusy}
                        onClick={() => onSaveMemory(i)}
                      >
                        Salva in memoria
                      </button>
                    ))}
                  {engineMode && m.who === "agent" && !m.partial && onSaveSkill && (
                    <button
                      type="button"
                      className="cs-link cw-memory-promote"
                      disabled={engineBusy}
                      onClick={() => onSaveSkill(i)}
                    >
                      Salva come procedura
                    </button>
                  )}
                  {m.patchProposal && !m.patchResolved && onConfirmPatch && onDiscardPatch && (
                    <WorkPatchPreviewCard
                      summaryLines={m.patchProposal.summary_lines}
                      busy={engineBusy}
                      onConfirm={() => onConfirmPatch(i)}
                      onCancel={() => onDiscardPatch(i)}
                    />
                  )}
                </article>
              ))}
              {work.catalogPlan &&
                work.catalogPlan.steps.filter((step) => step.result).length > 0 && (
                  <div className="cc-chat-results">
                    {work.catalogPlan.steps
                      .filter((step) => step.result)
                      .map((step) => (
                        <details key={step.id}>
                          <summary>
                            <Check size={15} />
                            <span>
                              {step.title}
                              <small>{step.agent} · Concluso nella demo</small>
                            </span>
                          </summary>
                          <p>{step.result}</p>
                          {step.childId && (
                            <button className="cs-link" onClick={() => onOpenWork(step.childId!)}>
                              Apri il passaggio ↗
                            </button>
                          )}
                        </details>
                      ))}
                  </div>
                )}
              {work.catalogPlan && work.request?.status === "pending" && (
                <div data-chat-request>{contributionPanel}</div>
              )}
              {work.catalogPlan && (work.phase === "review" || work.phase === "approved") && (
                <div className="cc-chat-proposal" data-chat-delivery>
                  <strong>
                    {work.phase === "approved" ? "Risultato approvato" : "La consegna è pronta"} ·
                    v{work.revision}
                  </strong>
                  <p>{scenario!.result}</p>
                  <p className="cw-hint">
                    Anteprima dimostrativa.{" "}
                    {work.phase === "review"
                      ? "Apri il risultato, oppure scrivi in chat cosa vuoi cambiare."
                      : "Il risultato resta consultabile qui."}
                  </p>
                  <div className="cs-actions">
                    <button className="cw-secondary" onClick={onPreview}>
                      Apri risultato
                    </button>
                    {work.phase === "review" && (
                      <button
                        className="cw-primary"
                        disabled={viewer !== (work.reviewer || work.requester || "Fabio")}
                        onClick={onApprovePlan}
                      >
                        Approva bozza
                      </button>
                    )}
                  </div>
                </div>
              )}
              {planEdit?.workId === work.id && (
                <div className="cc-chat-proposal">
                  <strong>Modifica proposta</strong>
                  <ol>
                    {planEdit.plan.steps.map((s) => (
                      <li key={s.id}>
                        {s.title} · {s.agent || "Da assegnare"}
                      </li>
                    ))}
                  </ol>
                  <div className="cs-actions">
                    <button className="cw-primary" onClick={() => onApplyPlanEdit(planEdit.plan)}>
                      Applica al piano
                    </button>
                    <button className="cs-link" onClick={onCancelPlanEdit}>
                      Annulla
                    </button>
                  </div>
                </div>
              )}
              {work.phase === "approved" && (
                <div className="cw-closed">
                  <Check size={17} />{" "}
                  {work.source === "engine" && work.engineStatus === "cancelled"
                    ? "Lavoro chiuso senza eseguirlo."
                    : work.autoDelivered
                      ? "Risultato consegnato in autonomia."
                      : "Risultato approvato."}{" "}
                  Nessun invio esterno.
                </div>
              )}
            </>
          )}
          {engineMode && work?.source === "engine" && engineIntake && (
            <EngineWorkIntake key={work.id} work={work} intake={engineIntake} onChanged={onRefreshEngine} />
          )}
        </div>
        <div className="cw-composer">
          {assignee && (
            <p className="cw-hint">
              Nuovo incarico per <strong>{assignee}</strong> · descrivi il risultato che vuoi
              ottenere.
            </p>
          )}
          <StudioChatInput
            key={active || "new"}
            label="Messaggio alla squadra"
            disabled={engineMode && historyLoading}
            onSend={onSend}
            references={mentionRefs}
          />
          {historyLoading && <p className="cw-hint" role="status">Caricamento conversazione…</p>}
          {engineMode && engineBusy && onCancelInFlight && (
            <p className="cw-hint cw-engine-busy" role="status">
              Homun sta aspettando la risposta del modello: la conversazione mostra i passaggi
              e il tempo trascorso.{" "}
              <button type="button" className="cs-link" onClick={onCancelInFlight}>
                Annulla
              </button>
            </p>
          )}
          {notice && (
            <p className="cw-notice" role="status">
              {notice}
              <button aria-label="Chiudi avviso" onClick={onClearNotice}>
                <X size={14} />
              </button>
            </p>
          )}
          <div className="cw-composer-caption">
            <span>
              <Sparkles size={12} /> Scrivi naturalmente. Usa @ per un collaboratore.
            </span>
            <span title={engineMode ? "Conversazione salvata nell'archivio locale" : storageStatus}>
              {engineMode ? "Archivio locale" : `Simulazione · ${storageStatus}`}
            </span>
          </div>
        </div>
      </section>
      {details}
    </div>
  );
}
