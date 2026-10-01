/**
 * Chat stage: history + composer for agent conversations.
 * Owns presentation; shell owns state and passes storageStatus / callbacks.
 */

import { Markdown as ChatMarkdown } from "./ChatMarkdown";
import { ConversationAgentLive } from "./ConversationAgentLive";
import { useConversationEventStream } from "@/hooks/useConversationEventStream";
import { EngineWorkIntake } from "./EngineWorkIntake";
import { EnginePlanRelayTimeline } from "./EnginePlanRelayTimeline";
import { ConversationMarginaliaSpine } from "./ConversationMarginaliaSpine";
import { EngineAgentProfileModal } from "./EngineAgentProfileModal";
import { Check, Sparkles, X, Copy, Bookmark, BookmarkCheck } from "lucide-react";
import { useEffect, useState, type ReactNode, type RefObject } from "react";
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
import type { AutonomyLevel } from "./conversation-preferences";

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
  agentNames?: Record<string, string> | undefined;
  onStartWork?: (() => Promise<void>) | undefined;
  onOpenSpace?: (space: "Progetti" | "Squadra" | "Materiali", initial?: string, selected?: string) => void;
  autonomyLevel?: AutonomyLevel | undefined;
  onAutonomyLevelChange?: ((level: AutonomyLevel) => void) | undefined;
  modelConnectionId?: string | undefined;
  onModelConnectionIdChange?: ((connectionId: string) => void) | undefined;
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
  agentNames,
  onStartWork,
  onOpenSpace,
  autonomyLevel,
  onAutonomyLevelChange,
  modelConnectionId,
  onModelConnectionIdChange,
}: Props) {
  const [inspectedAgent, setInspectedAgent] = useState<EngineAgentProfile | null>(null);

  const handleInspectAgent = (agentOrIdOrName: string | EngineAgentProfile) => {
    if (!agentOrIdOrName) return;
    if (typeof agentOrIdOrName === "object" && "id" in agentOrIdOrName) {
      setInspectedAgent(agentOrIdOrName);
      return;
    }
    const idOrName = String(agentOrIdOrName).trim();
    if (idOrName === "person_fabio" || idOrName.toLowerCase() === "homun") {
      setInspectedAgent({
        id: "homun",
        workspace_id: "ws_local",
        revision: 1,
        name: "Homun",
        role: "Coordinatore del lavoro",
        responsibility: "Coordinamento della squadra, pianificazione e orchestrazione sicura dei flussi operativi.",
        specializations: ["Orchestrazione collaborativa", "Coordinamento agenti", "Supervisione umana"],
        status: "active",
        autonomy_mode: "supervised",
        capabilities: ["general"],
        instructions: "Coordina l'esecuzione del lavoro nel rispetto delle autorizzazioni dell'utente, supervisiona i passaggi critici e gestisce le staffette tra collaboratori.",
        method: "Collaborativo con supervisione umana.",
      });
      return;
    }
    const found = (engineAgents ?? []).find(
      (a) =>
        a.id === idOrName ||
        a.name.toLowerCase() === idOrName.toLowerCase() ||
        (agentNames?.[idOrName] && agentNames[idOrName].toLowerCase() === a.name.toLowerCase())
    );
    if (found) {
      setInspectedAgent(found);
      return;
    }
    const name = agentNames?.[idOrName] ?? idOrName;
    setInspectedAgent({
      id: idOrName,
      workspace_id: "ws_local",
      revision: 1,
      name,
      role: "Collaboratore Specializzato",
      responsibility: "Collaboratore operativo nel flusso di lavoro.",
      specializations: ["Attività operative", "Ricerca"],
      status: "active",
      autonomy_mode: "supervised",
      capabilities: ["general"],
      instructions: "Esegue le attività assegnate sotto la supervisione dell'utente.",
      method: "Coordinato da Homun.",
    });
  };

  useEffect(() => {
    const handler = (e: Event) => {
      const customEvent = e as CustomEvent<string | EngineAgentProfile>;
      if (customEvent.detail) {
        handleInspectAgent(customEvent.detail);
      }
    };
    window.addEventListener("homun:inspect-agent", handler);
    return () => window.removeEventListener("homun:inspect-agent", handler);
  }, [engineAgents, agentNames]);
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

  const agentStream = useConversationEventStream(
    engineMode ? work?.engineConversationId : undefined,
    { onNewMessage: onRefreshEngine },
  );

  useEffect(() => {
    if (historyRef.current && (work?.messages.length || engineIntake?.proposal)) {
      historyRef.current.scrollTo({
        top: historyRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [work?.messages.length, engineIntake?.proposal?.digest]);

  return (
    <div className={`cw-stage ${work && panelOpen ? "with-panel" : ""}`}>
      <section className="cw-conversation">
        {work && scenario && spaceData.removedPeople?.includes(scenario.agent) && (
          <p role="status" className="cw-hint">
            Agente eliminato · conversazione conservata nello storico. Le nuove esecuzioni sono
            disabilitate.
          </p>
        )}

        <div className="cw-history" ref={historyRef}>
          {!work ? (
            <ConversationWorkspaceWelcome
              assignee={assignee}
              scenarios={scenarios}
              spaceData={spaceData}
              onCreateExample={onCreateExample}
              engineMode={engineMode}
              onRefreshEngine={onRefreshEngine}
              onOpenSpace={onOpenSpace}
            />
          ) : (
            <>
              <div className="cw-date">OGGI · IL LAVORO COMINCIA QUI</div>
              {work.messages.map((m, i) => (
                <article
                  key={i}
                  className={`cw-message ${m.who}`}
                >
                  <small>
                    {m.sender || (m.who === "you" ? work.requester || "Tu" : scenario!.agent)}
                  </small>
                  {m.wait ? (
                    <ConversationAgentWait phase={m.wait.phase} startedAt={m.wait.startedAt} />
                  ) : m.who === "agent" ? (
                    <ChatMarkdown content={cleanMessageText(m.text)} streaming={m.partial} />
                  ) : (
                    <p className={m.partial ? "cw-message-partial" : undefined}>{cleanMessageText(m.text)}</p>
                  )}
                  {m.who === "agent" && !m.partial && (
                    <div className="cw-msg-actions">
                      <button
                        type="button"
                        className="cw-msg-action-btn"
                        title="Copia messaggio"
                        onClick={() => navigator.clipboard.writeText(cleanMessageText(m.text))}
                      >
                        <Copy size={13} />
                      </button>
                      {engineMode && onSaveMemory && (
                        m.memorySaved ? (
                          <span className="cw-msg-action-saved" title="Salvato in memoria">
                            <BookmarkCheck size={13} />
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="cw-msg-action-btn"
                            disabled={engineBusy}
                            title="Salva in memoria"
                            onClick={() => onSaveMemory(i)}
                          >
                            <Bookmark size={13} />
                          </button>
                        )
                      )}
                      {engineMode && onSaveSkill && (
                        <button
                          type="button"
                          className="cw-msg-action-btn"
                          disabled={engineBusy}
                          title="Salva come procedura"
                          onClick={() => onSaveSkill(i)}
                        >
                          <Sparkles size={13} />
                        </button>
                      )}
                    </div>
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
              {engineMode && <ConversationAgentLive stream={agentStream} />}
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
          {engineMode && work?.source === "engine" && work.enginePlan && work.enginePlan.length > 0 && (
            <EnginePlanRelayTimeline
              work={work}
              agentNames={agentNames}
              busy={engineBusy}
              onStartWork={onStartWork}
              onInspectAgent={handleInspectAgent}
            />
          )}
          {engineMode && work?.source === "engine" && engineIntake && (
            <EngineWorkIntake
              key={work.id}
              work={work}
              intake={engineIntake}
              onChanged={onRefreshEngine}
              onInspectAgent={handleInspectAgent}
            />
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
            autonomyLevel={autonomyLevel}
            onAutonomyLevelChange={onAutonomyLevelChange}
            modelConnectionId={modelConnectionId}
            onModelConnectionIdChange={onModelConnectionIdChange}
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

        </div>
      </section>
      {!panelOpen && <ConversationMarginaliaSpine work={work} intake={engineIntake} />}
      {panelOpen && details}
      {inspectedAgent && (
        <EngineAgentProfileModal
          agent={inspectedAgent}
          onClose={() => setInspectedAgent(null)}
        />
      )}
    </div>
  );
}

function cleanMessageText(text: string): string {
  return text
    .replace(/\.?\s*Fonte:\s*motore\.?/gi, "")
    .replace(/\.?\s*Fonte\s+motore\.?/gi, "")
    .replace(/\.?\s*Fonte:\s*simulazione\.?/gi, "")
    .trim();
}
