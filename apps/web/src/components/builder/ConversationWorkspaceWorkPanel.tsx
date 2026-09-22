/**
 * Right-hand work details panel for an active simulated conversation.
 */

import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Clock3,
  FileText,
  FolderOpen,
  Paperclip,
  Play,
  X,
} from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { ConversationAvatar } from "./ConversationAvatar";
import { ConversationCatalogPlan, type CatalogPlan } from "./ConversationCatalogPlan";
import { ConversationSelectField } from "./ConversationSelect";
import { isHumanMember, memberProfile } from "./conversation-members";
import type { ConversationPreferences } from "./conversation-preferences";
import { initialScenarios, type ConversationScenario } from "./conversation-scenarios";
import type { ConversationMaterial } from "./ConversationMaterials";
import { spacePeople, type SpaceData, type SpaceView } from "./ConversationSpace";
import type { Work } from "./conversation-types";
import type { WorkIntakeState } from "@/hooks/useWorkIntake";
import { EngineWorkspaceWorkPanel } from "./EngineWorkspaceWorkPanel";

type Props = {
  work: Work;
  scenario: ConversationScenario;
  viewer: string;
  spaceData: SpaceData;
  preferences: ConversationPreferences;
  library: ConversationMaterial[];
  contribution: string;
  files: File[];
  contributionPanel: ReactNode;
  workStatus: (w: Work) => string;
  onPatch: (change: Partial<Work>) => void;
  onUpdatePlan: (next: CatalogPlan, starting?: boolean) => void;
  onOpenSpace: (view: SpaceView, initial?: string, selected?: string) => void;
  onOpenWork: (id: string | null) => void;
  onConfirm: () => void;
  onDeliver: () => void;
  onSimulate: () => void;
  onSimulateQuestion: () => void;
  onContributionChange: (value: string) => void;
  onFilesChange: (files: File[]) => void;
  onPreview: () => void;
  onRegisterAgent: (name: string, role: string) => boolean;
  uploadRef: RefObject<HTMLInputElement | null>;
  directoryRef: RefObject<HTMLInputElement | null>;
  engineBusy?: boolean;
  engineIntake?: WorkIntakeState | undefined;
  onRename?: ((title: string) => Promise<void>) | undefined;
  onApplyObjectivePatch?: ((nextObjective: string) => Promise<void>) | undefined;
  onCloseWork?: (() => Promise<void>) | undefined;
  onStartWork?: (() => Promise<void>) | undefined;
  onSubmitArtifact?: ((title: string, content: string) => Promise<void>) | undefined;
  onSetBudget?: ((modelAttempts: number) => Promise<void>) | undefined;
  onRevisePlan?: ((action: {
    insertAfterStepId?: string | null;
    newStep?: { title: string; assigneeId: string; capability?: string; outputExpected?: string };
    removeStepId?: string;
  }) => Promise<void>) | undefined;
  agents?: Array<{ id: string; name: string; status: string }> | undefined;
  agentNames?: Record<string, string> | undefined;
};

export function ConversationWorkspaceWorkPanel({
  work,
  scenario,
  viewer,
  spaceData,
  preferences,
  library,
  contribution,
  files,
  contributionPanel,
  workStatus,
  onPatch,
  onUpdatePlan,
  onOpenSpace,
  onOpenWork,
  onConfirm,
  onDeliver,
  onSimulate,
  onSimulateQuestion,
  onContributionChange,
  onFilesChange,
  onPreview,
  onRegisterAgent,
  uploadRef,
  directoryRef,
  engineBusy = false,
  engineIntake,
  onApplyObjectivePatch, onRename, onCloseWork, onStartWork, onSubmitArtifact,
  onSetBudget, onRevisePlan, agents, agentNames,
}: Props) {
  if (work.source === "engine")
    return (
      <EngineWorkspaceWorkPanel
        ownerName={work.engineOwnerName}
        onRename={onRename}
        work={work}
        spaceData={spaceData}
        busy={engineBusy}
        intake={
          engineIntake ?? {
            proposal: null,
            loaded: true,
            busy: false,
            error: null,
            confirm: async () => {},
            refine: async () => false,
          }
        }
        contributionPanel={contributionPanel}
        onOpenSpace={onOpenSpace}
        onApplyObjectivePatch={onApplyObjectivePatch}
        onCloseWork={onCloseWork}
        onStartWork={onStartWork}
        onSubmitArtifact={onSubmitArtifact}
        onSetBudget={onSetBudget}
        onRevisePlan={onRevisePlan}
        agents={agents}
        agentNames={agentNames}
      />
    );

  const humanSupervisors = [
    ...new Set(["Fabio", "Giulia", ...Object.keys(spaceData.profiles || {})]),
  ].filter(
    (name) =>
      isHumanMember(name, spaceData.profiles) &&
      !spaceData.removedPeople?.includes(name) &&
      memberProfile(name, spaceData.profiles).invitation !== "pending",
  );

  return (
    <aside className="cw-workspace" aria-label="Il lavoro adesso">
      <div className="cw-panel-top">
        <span className="cw-overline">IL LAVORO, ADESSO</span>
        <span className={`cw-status ${work.phase}`}>{workStatus(work)}</span>
      </div>
      <h2 className={work.catalogPlan ? "cc-work-title" : ""}>{work.title}</h2>
      {work.catalogPlan && (
        <ConversationCatalogPlan
          key={"plan:" + work.id}
          plan={work.catalogPlan}
          reviewer={work.requester || viewer}
          count={work.files.length}
          inputLabel={scenario.input}
          inputHelp={scenario.help}
          contribution={work.contribution}
          onContribution={(next) => onPatch({ contribution: next })}
          proposal={work.phase === "proposal"}
          approved={work.phase === "approved"}
          blocked={work.request?.status === "pending"}
          people={[...new Set([...spacePeople, ...Object.keys(spaceData.profiles || {})])].filter(
            (n) => !spaceData.removedPeople?.includes(n),
          )}
          profiles={spaceData.profiles}
          onChange={onUpdatePlan}
          onFiles={(added) => onPatch({ files: [...work.files, ...added] })}
          onLibrary={() => onOpenSpace("Materiali", work.id)}
          onChild={onOpenWork}
          onCreate={onRegisterAgent}
        />
      )}

      {work.routineId && (
        <button className="cs-link" onClick={() => onOpenSpace("Automazioni", "", work.routineId)}>
          Apri automazione ↗
        </button>
      )}
      {!work.catalogPlan && <p className="cw-outcome">{scenario.outcome}</p>}
      {work.projectId && (
        <button className="cs-link" onClick={() => onOpenSpace("Progetti", "", work.projectId)}>
          Progetto: {spaceData.projects.find((p) => p.id === work.projectId)?.name} ↗
        </button>
      )}
      <div className="cw-owner" hidden={!!work.catalogPlan}>
        <ConversationAvatar
          name={scenario.agent}
          human={isHumanMember(scenario.agent, spaceData.profiles)}
        />
        <span>
          {scenario.agent}
          <small>
            {work.autonomy === "autonomous"
              ? "Consegna autonoma"
              : `Verifica: ${work.reviewer || work.requester || "Fabio"}`}
          </small>
        </span>
      </div>
      <details className="cw-details cw-supervision" hidden={!!work.catalogPlan}>
        <summary>
          Supervisione del lavoro <ChevronDown size={14} />
        </summary>
        <label>
          Modalità
          <ConversationSelectField
            aria-label="Modalità del lavoro"
            value={work.autonomy || "supervised"}
            disabled={
              !!work.catalogPlan ||
              !!work.coordinatedBy ||
              work.phase === "approved" ||
              viewer !== (work.requester || "Fabio")
            }
            onChange={(e) =>
              onPatch({ autonomy: e.target.value as "supervised" | "autonomous" })
            }
          >
            <option value="supervised">Risultato da verificare</option>
            <option value="autonomous">Consegna autonoma</option>
          </ConversationSelectField>
        </label>
        <label>
          Chi verifica
          <ConversationSelectField
            aria-label="Supervisore del lavoro"
            value={work.reviewer || work.requester || "Fabio"}
            disabled={
              !!work.catalogPlan ||
              !!work.coordinatedBy ||
              work.phase === "approved" ||
              viewer !== (work.requester || "Fabio")
            }
            onChange={(e) => onPatch({ reviewer: e.target.value })}
          >
            {humanSupervisors.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </ConversationSelectField>
        </label>
        <p className="cw-hint">
          Vale solo per questo incarico. In autonomia il supervisore resta il riferimento per
          eventuali verifiche. Cambiare modalità non approva una bozza già in revisione.
        </p>
      </details>
      {work.coordinatedBy && (
        <div className="cw-hint">
          <p>Questo passaggio è gestito nel piano del lavoro.</p>
          <button className="cw-secondary" onClick={() => onOpenWork(work.coordinatedBy!)}>
            Apri il piano del lavoro ↗
          </button>
        </div>
      )}
      {!work.catalogPlan && contributionPanel}
      {work.catalogPlan && work.request?.status === "pending" && (
        <p className="cw-hint">
          Aspetta {work.request.to}. La richiesta e il campo per rispondere sono nella chat.
        </p>
      )}
      {work.coordinatedBy ? null : work.request?.status === "pending" ? null : work.phase ===
        "proposal" ? (
        <div className="cw-panel-body">
          {!work.catalogPlan && (
            <ol className="cw-plan">
              {scenario.steps.map((s, i) => (
                <li key={s}>
                  <span>{i + 1}</span>
                  {s}
                </li>
              ))}
            </ol>
          )}
          <details className="cw-details">
            <summary>
              Modifica accordo <ChevronDown size={14} />
            </summary>
            <label>
              Nome del lavoro
              <input value={work.title} onChange={(e) => onPatch({ title: e.target.value })} />
            </label>
            <label>
              Scadenza facoltativa
              <input
                aria-label="Scadenza"
                type="date"
                value={work.due}
                onChange={(e) => onPatch({ due: e.target.value })}
              />
            </label>
          </details>
          <p className="cw-hint">
            {work.catalogPlan
              ? ""
              : work.files.length
                ? `${work.files.length} allegati già collegati.`
                : `Ti chiederò ${scenario.input.toLowerCase()} per iniziare.`}
          </p>
          <button
            className="cw-primary"
            disabled={
              !work.title.trim() ||
              (!!work.catalogPlan &&
                ((!work.files.length && !work.contribution.trim()) ||
                  !work.catalogPlan.steps.length ||
                  work.catalogPlan.steps.some(
                    (s) => !s.agent || spaceData.removedPeople?.includes(s.agent),
                  )))
            }
            onClick={onConfirm}
          >
            {work.catalogPlan ? "Avvia il piano della squadra" : "Affida a " + scenario.agent}
            <ArrowUpRight size={16} />
          </button>
        </div>
      ) : work.phase === "waiting" ? (
        <div className="cw-request">
          <span className="cw-overline">TOCCA A TE</span>
          <h3>{scenario.input}</h3>
          <p>{scenario.help}</p>
          <textarea
            aria-label="Il tuo contributo"
            placeholder="Scrivi qui le informazioni o un link…"
            value={contribution}
            onChange={(e) => onContributionChange(e.target.value)}
          />
          <div className="cw-attach">
            <button onClick={() => uploadRef.current?.click()}>
              <Paperclip size={15} /> File
            </button>
            <button onClick={() => directoryRef.current?.click()}>
              <FolderOpen size={15} /> Cartella
            </button>
          </div>
          {files.map((f, i) => (
            <div className="cw-file" key={i}>
              <FileText size={14} />
              <span>{f.webkitRelativePath || f.name}</span>
              <button
                aria-label={`Rimuovi ${f.name}`}
                onClick={() => onFilesChange(files.filter((_, j) => j !== i))}
              >
                <X size={13} />
              </button>
            </div>
          ))}
          <button
            className="cw-primary"
            disabled={!contribution.trim() && !files.length}
            onClick={onDeliver}
          >
            Consegna a {scenario.agent}
            <ArrowUpRight size={16} />
          </button>
          <small>Puoi rispondere anche direttamente in chat.</small>
        </div>
      ) : work.phase === "ready" ? (
        <div className="cw-ready">
          <span className="cw-check">
            <Check size={24} />
          </span>
          <h3>{work.catalogPlan ? "Prossimo passaggio" : "Tutto pronto per cominciare."}</h3>
          <p>
            {work.catalogPlan ? (
              `${work.catalogPlan.steps[work.catalogPlan.completed]?.agent}: ${work.catalogPlan.steps[work.catalogPlan.completed]?.title}`
            ) : (
              <>
                Il tuo contributo è collegato. {scenario.agent} ha il necessario per il prossimo
                passaggio.
              </>
            )}
          </p>
          <div className="cw-simulation">
            <span>PROVA IL SEGUITO</span>
            <p>
              Il motore non è ancora collegato. Simula l’arrivo di una bozza per provare la
              revisione.
            </p>
            <button
              className="cw-primary"
              disabled={spaceData.removedPeople?.includes(scenario.agent)}
              onClick={onSimulate}
            >
              <Play size={14} />{" "}
              {work.catalogPlan
                ? "Simula passaggio " +
                  (work.catalogPlan.completed + 1) +
                  " di " +
                  work.catalogPlan.steps.length
                : "Simula risultato pronto"}
            </button>
            {work.catalogPlan && (
              <button className="cw-secondary" onClick={onSimulateQuestion}>
                Simula una domanda
              </button>
            )}
          </div>
        </div>
      ) : work.catalogPlan ? (
        <p className="cw-hint">
          {work.phase === "review"
            ? "Tocca a te: verifica la consegna nella chat."
            : "Consegna approvata. Puoi riaprire il risultato nella chat."}
        </p>
      ) : (
        <div className="cw-result">
          <div className="cw-document" onClick={onPreview}>
            <FileText size={30} />
            <span>DOCUMENTO · V{work.revision}</span>
            <h3>{scenario.result}</h3>
            <p>Anteprima dimostrativa</p>
            <button className="cw-secondary" onClick={onPreview}>
              Apri documento <ArrowUpRight size={15} />
            </button>
          </div>
          {work.phase === "review" ? (
            <>
              <p className="cw-hint">
                Verifica assegnata a {work.reviewer || work.requester || "Fabio"}. Apri la bozza;
                per proporre modifiche, scrivi nella chat.
              </p>
              <button
                className="cw-primary"
                disabled={viewer !== (work.reviewer || work.requester || "Fabio")}
                onClick={() => {
                  if (viewer !== (work.reviewer || work.requester || "Fabio")) return;
                  onPatch({
                    approvedBy: viewer,
                    autoDelivered: false,
                    phase: "approved",
                    messages: [
                      ...work.messages,
                      { who: "you", sender: viewer, text: "Approvo questa bozza." },
                      {
                        who: "agent",
                        text: "Approvazione registrata. Il risultato resta disponibile qui; non è stato pubblicato né inviato.",
                      },
                    ],
                  });
                }}
              >
                Approva bozza
                <Check size={16} />
              </button>
            </>
          ) : (
            <p className="cw-approved">
              <Check size={15} />{" "}
              {work.autoDelivered
                ? "Consegnato in autonomia"
                : `Approvata da ${work.approvedBy || work.requester || "Fabio"}`}
            </p>
          )}
        </div>
      )}
      {work.due && (
        <p className="cw-due">
          <Clock3 size={14} /> Entro{" "}
          {new Date(work.due + "T12:00:00").toLocaleDateString("it-IT")}
        </p>
      )}
      <button className="cs-link" onClick={() => onOpenSpace("Materiali", work.id)}>
        Collega materiali dalla raccolta ↗
      </button>
      {(work.materialIds || [])
        .map((id) => library.find((m) => m.id === id))
        .filter((m) => m && !m.file)
        .map((m) => (
          <button
            key={m!.id}
            className="cs-example"
            onClick={() => onOpenSpace("Materiali", "", m!.id)}
          >
            Nota: {m!.name} ↗
          </button>
        ))}
      {work.files.length > 0 && (
        <details className="cw-details">
          <summary>
            <span>Materiali · {work.files.length}</span>
            <ChevronDown size={14} />
          </summary>
          {work.files.map((f, i) => (
            <p className="cw-file" key={i}>
              <FileText size={13} />
              {f.name}
            </p>
          ))}
        </details>
      )}
      <details className="cw-details cw-cost">
        <summary>
          <span>Costi</span>
          <ChevronDown size={14} />
        </summary>
        <p>
          Nessun consumo AI reale. Limite indicativo per lavoro: €{preferences.perWorkBudget}.
          Budget mensile: €{preferences.budget}. Le soglie saranno applicate dal futuro motore.
        </p>
      </details>
    </aside>
  );
}

/** Shared helper for creating an agent from the catalog plan UI. */
export function registerPlanAgent(
  name: string,
  role: string,
  spaceData: SpaceData,
): { ok: false } | { ok: true; scenario: ConversationScenario & { custom: true }; profile: NonNullable<SpaceData["profiles"]>[string] } {
  if (
    [...spacePeople, ...Object.keys(spaceData.profiles || {})].some(
      (n) => n.toLowerCase() === name.toLowerCase(),
    )
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    scenario: {
      ...initialScenarios[0]!,
      custom: true,
      agent: name,
      role,
      title: role,
      initial: role,
      outcome: role,
      result: role,
      steps: [role],
    },
    profile: {
      kind: "agent",
      role,
      bio: role,
      skills: [role],
      tone: "Chiaro e sintetico",
      plugins: [],
    },
  };
}
