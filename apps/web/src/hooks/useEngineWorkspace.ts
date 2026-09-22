/**
 * Engine-backed workspace list/create for ConversationWorkspace (F2.4).
 * Simulation IndexedDB state stays separate; this hook only serves Fonte=motore.
 */

import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import type { ConversationMessage, Work } from "@/components/builder/conversation-types";
import { resolveWorkspaceMode } from "@/lib/engine-client";
import {
  assistantFromPosted,
  applyEngineWorkPatch,
  createEngineConversationAndWork,
  engineWorkToUiWork,
  parseEngineWorkRecord,
  postEngineConversationMessage,
} from "@/lib/conversation-engine-bridge";
import {
  type EngineFollowupNotice,
  defaultLocalActor,
  listEngineConversations,
} from "@/lib/engine-domain-client";
import { addEngineMemory } from "@/lib/engine-memory-client";
import {
  type EngineProject,
  ensureEngineProjectForConversation,
  ingestEngineMaterial,
  provideEngineContribution,
} from "@/lib/engine-projects-client";
import { useEngineStatus } from "@/hooks/useEngineStatus";
import type { EngineDataSource } from "@/lib/engine-client";
import { isHomunClientError } from "@/lib/homun-errors";

import { currentTranscriptActions } from "@/lib/engine-transcript-client";
import { useEngineWorkspaceSnapshot } from "./useEngineWorkspaceSnapshot";
import { useEngineTranscript } from "./useEngineTranscript";
import { useWorkIntake, type WorkIntakeState } from "./useWorkIntake";
import type { EngineAgentProfile } from "@/lib/engine-agents-client";
import type { EngineTeam } from "@/lib/engine-projects-client";
import { renameEngineWork } from "@/lib/engine-work-naming";
import { closeEngineWork, reviseEnginePlan, setEngineWorkBudget, setEngineWorkDue, startEngineWork, submitEngineArtifact } from "@/lib/engine-work-lifecycle";
import { createIntakeConversation } from "@/lib/engine-intake-creation";
import { proposeWorkIntake } from "@/lib/engine-intake-client";
import { applyIntakePreview } from "@/lib/engine-intake-display";
import { routeEngineFirstMessage, type FirstMessageRoute } from "@/lib/engine-first-message-routing";
export type EngineWorkspaceState = {
  dataSource: EngineDataSource;
  backend: "simulation" | "engine";
  gateError: unknown;
  error: unknown;
  busy: boolean;
  loaded: boolean;
  historyLoading: boolean;
  works: Work[];
  intake: WorkIntakeState;
  projects: EngineProject[];
  agents: EngineAgentProfile[];
  teams: EngineTeam[];
  followups: Array<EngineFollowupNotice & { conversationTitle: string }>;
  refresh: () => Promise<void>;
  renameWork: (work: Work, title: string) => Promise<void>;
  closeWork: (work: Work) => Promise<void>;
  startWork: (work: Work) => Promise<void>;
  submitArtifact: (work: Work, title: string, content: string) => Promise<void>;
  setWorkBudget: (work: Work, modelAttempts: number) => Promise<void>;
  setDue: (work: Work, dueDate: string | null) => Promise<void>;
  revisePlan: (work: Work, action: { insertAfterStepId?: string | null; newStep?: { title: string; assigneeId: string; capability?: string; outputExpected?: string }; removeStepId?: string }) => Promise<void>;
  createWork: (title: string, objective: string, draftOnly?: boolean) => Promise<Work | null>;
  postMessage: (work: Work, text: string) => Promise<void>;
  confirmPatch: (work: Work, messageIndex: number) => Promise<void>;
  discardPatch: (work: Work, messageIndex: number) => void;
  applyObjectivePatch: (work: Work, nextObjective: string) => Promise<void>;
  saveMemoryFromMessage: (work: Work, messageIndex: number) => Promise<void>;
  fulfillContribution: (
    work: Work,
    text: string,
    files: File[],
    materialIds: string[],
  ) => Promise<void>;
  cancelInFlight: () => void;
  clearError: () => void;
};
export function useEngineWorkspace(activeWorkId: string | null = null): EngineWorkspaceState {
  const status = useEngineStatus();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [messageOverlay, setMessageOverlay] = useState<Record<string, ConversationMessage[]>>({});
  const abortRef = useRef<AbortController | null>(null);

  const mode = resolveWorkspaceMode(
    status.dataSource,
    status.connection === "connected",
    status.capabilities,
  );
  const backend = mode.backend;
  const gateError = mode.gateError;
  const engineReady = mode.engineReady;

  const {rawWorks, projects, agents, teams, followups, loaded, refresh: refreshSnapshot} = useEngineWorkspaceSnapshot(engineReady, () => setMessageOverlay({}), setError);

  // Explicit transcript reloads: actions that may have persisted messages bump
  // the sequence; a plain inventory refresh re-render never interrupts reading.
  const [transcriptSeq, bumpTranscriptSeq] = useReducer((count: number) => count + 1, 0);
  const refresh = useCallback(async () => {
    await refreshSnapshot();
    bumpTranscriptSeq();
  }, [refreshSnapshot]);

  const {history: transcript, loading: historyLoading} = useEngineTranscript(engineReady, activeWorkId, rawWorks, messageOverlay, setMessageOverlay, setError, transcriptSeq);

  const baseWorks = useMemo(
    () =>
      rawWorks.map((raw) => {
        const record = parseEngineWorkRecord(raw);
        const mapped = engineWorkToUiWork(record, currentTranscriptActions(messageOverlay[record.id] ?? (record.id === activeWorkId
          ? transcript?.workId === record.id ? transcript.messages : []
          : []), record.version));
        const owner = agents.find(agent => agent.id === raw["owner_id"]);
        if (owner) mapped.engineOwnerName = owner.name;
        return mapped;
      }),
    [rawWorks, agents, messageOverlay, transcript, activeWorkId],
  );

  // Single owner of the active work's brief: the chat card, the right panel
  // and the works projection below all read this instance.
  const [intakeSeq, bumpIntakeSeq] = useReducer((count: number) => count + 1, 0);
  const activeBaseWork = activeWorkId ? baseWorks.find((w) => w.id === activeWorkId) ?? null : null;
  const intake = useWorkIntake(backend === "engine" ? activeBaseWork : null, refresh, intakeSeq);

  // While a brief awaits confirmation its proposal drives what the person
  // sees — sidebar title, panel objective, proposed collaborator.
  const works = useMemo(() => {
    const proposal = intake.proposal;
    if (!proposal || proposal.work_id !== activeWorkId) return baseWorks;
    return baseWorks.map((w) => (w.id === proposal.work_id ? applyIntakePreview(w, proposal) : w));
  }, [baseWorks, intake.proposal, activeWorkId]);

  function beginRequest(): AbortSignal {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    return controller.signal;
  }

  function endRequest(signal: AbortSignal) {
    if (abortRef.current?.signal === signal) {
      abortRef.current = null;
      setBusy(false);
    }
  }

  function cancelInFlight() {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
  }

  async function createWork(_title: string, objective: string, draftOnly = false): Promise<Work | null> {
    if (backend !== "engine" || !engineReady) return null;
    const signal = beginRequest();
    try {
      // draftOnly hands the first message to postMessage instead: the
      // conversation opens immediately with the echoed message and the honest
      // staged wait, rather than staying on the hero through a mute interpret.
      const record = draftOnly
        ? parseEngineWorkRecord(
            (
              await createEngineConversationAndWork({
                title: "Nuova richiesta",
                objective: "Obiettivo da concordare",
                actor: defaultLocalActor(),
              })
            ).record as unknown as Record<string, unknown>,
          )
        : await createIntakeConversation(objective, signal, setError);
      await refresh();
      return engineWorkToUiWork(record, []);
    } catch (cause) {
      if (!(isHomunClientError(cause) && cause.code === "request_cancelled")) setError(cause);
      return null;
    } finally { endRequest(signal); }
  }

  async function postMessage(work: Work, text: string): Promise<void> {
    if (backend !== "engine" || work.source !== "engine" || !work.engineConversationId) {
      throw new Error("postMessage requires an engine-backed work");
    }
    const signal = beginRequest();
    const prior = messageOverlay[work.id] ?? work.messages;
    const startedAt = Date.now();
    setMessageOverlay((current) => ({
      ...current,
      [work.id]: [
        ...(current[work.id] ?? work.messages),
        { who: "you", sender: "Fabio", text },
        {
          who: "agent",
          sender: "Homun",
          text: "",
          partial: true,
          wait: { phase: "reading", startedAt },
        },
      ],
    }));
    try {
      // A question must be able to stay a question: the engine classifies the
      // message (and its language) before a work proposal is forced. Any
      // routing failure keeps today's durable propose path, which surfaces its
      // own typed errors.
      const routed = (await routeEngineFirstMessage(work, text, signal).catch((cause) => {
        if (isHomunClientError(cause) && cause.code === "request_cancelled") throw cause;
        return { route: "propose" as const };
      })) as FirstMessageRoute;
      if (routed.route === "propose") {
        // The wait stays visible through synthesis: an honest phase instead of
        // a mute gap between the message and the agreement card.
        setMessageOverlay((current) => ({
          ...current,
          [work.id]: (current[work.id] ?? work.messages).map((message) =>
            message.who === "agent" && message.partial && message.wait
              ? { ...message, wait: { phase: "preparing", startedAt } }
              : message,
          ),
        }));
        await proposeWorkIntake(work.id, text, work.revision, crypto.randomUUID(), signal, routed.language);
        bumpIntakeSeq();
        await refresh();
        // The request is durable (the engine posts it before synthesis) and
        // the agreement card owns the outcome: drop only the wait, let the
        // transcript reload replace the rest.
        setMessageOverlay((current) => ({
          ...current,
          [work.id]: (current[work.id] ?? work.messages).filter(
            (m) => !(m.who === "agent" && m.partial),
          ),
        }));
        return;
      }
      let streamed = "";
      const posted = await postEngineConversationMessage({
        conversationId: work.engineConversationId,
        text,
        actor: defaultLocalActor(),
        signal,
        onToken: (chunk) => {
          streamed += chunk;
          const live = streamed;
          setMessageOverlay((current) => {
            const base = current[work.id] ?? [...prior, { who: "you" as const, sender: "Fabio", text }];
            const withoutPartial = base.filter((m) => !(m.who === "agent" && m.partial));
            return {
              ...current,
              [work.id]: [
                ...withoutPartial,
                { who: "agent", sender: "Homun", text: live, partial: true },
              ],
            };
          });
        },
      });
      setMessageOverlay((current) => ({
        ...current,
        [work.id]: [...prior, { who: "you", sender: "Fabio", text }, assistantFromPosted(posted)],
      }));
    } catch (cause) {
      if (isHomunClientError(cause) && cause.code === "request_cancelled") {
        setMessageOverlay((current) => ({
          ...current,
          [work.id]: [
            ...prior,
            { who: "you", sender: "Fabio", text },
            {
              who: "agent",
              sender: "Homun",
              text: "Elaborazione annullata. Nessuna risposta applicata.",
            },
          ],
        }));
        return;
      }
      // The turn did not complete: keep the person's words visible with an
      // honest outcome note instead of letting the message vanish.
      setMessageOverlay((current) => ({
        ...current,
        [work.id]: [
          ...prior,
          { who: "you", sender: "Fabio", text },
          {
            who: "agent",
            sender: "Homun",
            text: "L'elaborazione non è andata a buon fine e nessuna risposta è stata applicata. Riprova quando vuoi.",
          },
        ],
      }));
      setError(cause);
      throw cause;
    } finally {
      endRequest(signal);
    }
  }

  async function confirmPatch(work: Work, messageIndex: number): Promise<void> {
    if (backend !== "engine" || work.source !== "engine") {
      throw new Error("confirmPatch requires an engine-backed work");
    }
    const messages = messageOverlay[work.id] ?? work.messages;
    const target = messages[messageIndex];
    const proposal = target?.patchProposal;
    if (!proposal || target.patchResolved) {
      return;
    }
    const signal = beginRequest();
    try {
      await applyEngineWorkPatch({
        workId: proposal.work_id || work.id,
        expectedVersion: proposal.base_version,
        changes: proposal.changes,
        actor: defaultLocalActor(),
        signal,
      });
      setMessageOverlay((current) => {
        const list = [...(current[work.id] ?? work.messages)];
        const msg = list[messageIndex];
        if (msg) {
          list[messageIndex] = {
            ...msg,
            patchResolved: "applied",
            text: `${msg.text}\n\nModifica applicata.`,
          };
        }
        list.push({
          who: "agent",
          sender: "Homun",
          text: "Modifica applicata. Obiettivo e assegnazioni aggiornati.",
        });
        return { ...current, [work.id]: list };
      });
      await refresh();
    } catch (cause) {
      if (!(isHomunClientError(cause) && cause.code === "request_cancelled")) {
        setError(cause);
        throw cause;
      }
    } finally {
      endRequest(signal);
    }
  }

  function discardPatch(work: Work, messageIndex: number): void {
    setMessageOverlay((current) => {
      const list = [...(current[work.id] ?? work.messages)];
      const msg = list[messageIndex];
      if (!msg?.patchProposal || msg.patchResolved) {
        return current;
      }
      list[messageIndex] = {
        ...msg,
        patchResolved: "discarded",
        text: `${msg.text}\n\nModifica annullata.`,
      };
      list.push({
        who: "agent",
        sender: "Homun",
        text: "Nessuna modifica applicata.",
      });
      return { ...current, [work.id]: list };
    });
  }

  async function applyObjectivePatch(work: Work, nextObjective: string): Promise<void> {
    if (backend !== "engine" || work.source !== "engine") {
      throw new Error("applyObjectivePatch requires an engine-backed work");
    }
    const signal = beginRequest();
    try {
      await applyEngineWorkPatch({
        workId: work.id,
        expectedVersion: work.revision,
        changes: [{ field: "objective", to_value: nextObjective }],
        actor: defaultLocalActor(),
        signal,
      });
      setMessageOverlay((current) => ({
        ...current,
        [work.id]: [
          ...(current[work.id] ?? work.messages),
          {
            who: "agent",
            sender: "Homun",
            text: `Obiettivo aggiornato dal pannello:\n«${nextObjective}»`,
          },
        ],
      }));
      await refresh();
    } catch (cause) {
      if (!(isHomunClientError(cause) && cause.code === "request_cancelled")) {
        setError(cause);
        throw cause;
      }
    } finally {
      endRequest(signal);
    }
  }

  async function saveMemoryFromMessage(work: Work, messageIndex: number): Promise<void> {
    if (backend !== "engine" || work.source !== "engine") {
      throw new Error("saveMemoryFromMessage requires an engine-backed work");
    }
    const messages = messageOverlay[work.id] ?? work.messages;
    const message = messages[messageIndex];
    if (!message || message.who !== "agent" || message.partial || message.memorySaved) {
      return;
    }
    const text = message.text.trim();
    if (!text) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const actor = defaultLocalActor();
      await addEngineMemory({
        text,
        actorId: actor.id,
        workId: work.id,
        ...(work.projectId ? { projectId: work.projectId } : {}),
      });
      setMessageOverlay((current) => {
        const list = [...(current[work.id] ?? work.messages)];
        const msg = list[messageIndex];
        if (msg) {
          list[messageIndex] = { ...msg, memorySaved: true };
        }
        return { ...current, [work.id]: list };
      });
    } catch (cause) {
      setError(cause);
      throw cause;
    } finally {
      setBusy(false);
    }
  }

  async function fulfillContribution(
    work: Work,
    text: string,
    files: File[],
    materialIds: string[],
  ): Promise<void> {
    if (backend !== "engine" || work.source !== "engine") {
      throw new Error("fulfillContribution requires an engine-backed work");
    }
    const requestId = work.engineContributionRequestId;
    if (!requestId || work.request?.status !== "pending") {
      throw new Error("No pending engine contribution request");
    }
    if (!text.trim() && !files.length && !materialIds.length) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const actor = defaultLocalActor();
      let projectId = work.projectId;
      if (!projectId && work.engineConversationId) {
        const conversations = await listEngineConversations();
        const conversation = conversations.find((c) => c.id === work.engineConversationId);
        if (conversation?.project_id) {
          projectId = conversation.project_id;
        } else if (conversation) {
          const ensured = await ensureEngineProjectForConversation({
            conversationId: conversation.id,
            expectedVersion: conversation.version,
            name: work.title,
            actor,
          });
          projectId = ensured.projectId;
        }
      }
      if (!projectId) {
        throw new Error("Work has no project for material ingest");
      }
      const ingestedIds: string[] = [...materialIds];
      for (const file of files) {
        const relativePath =
          "webkitRelativePath" in file && file.webkitRelativePath
            ? String(file.webkitRelativePath)
            : undefined;
        const ingested = await ingestEngineMaterial({
          projectId,
          file,
          ...(relativePath ? { relativePath } : {}),
          actor,
        });
        ingestedIds.push(ingested.materialId);
      }
      await provideEngineContribution({
        requestId,
        expectedVersion: work.revision,
        text,
        materialIds: ingestedIds,
        actor,
      });
      const label =
        text.trim() ||
        `Contributo: ${[...files.map((f) => f.name), ...ingestedIds].join(", ")}`;
      setMessageOverlay((current) => {
        const list = [...(current[work.id] ?? work.messages)];
        list.push(
          { who: "you", sender: "Fabio", text: label },
          {
            who: "agent",
            sender: "Homun",
            text: "Contributo ricevuto. I file sono in archivio materiali.",
          },
        );
        return { ...current, [work.id]: list };
      });
      await refresh();
    } catch (cause) {
      setError(cause);
      throw cause;
    } finally {
      setBusy(false);
    }
  }

  return {
    dataSource: status.dataSource,
    backend,
    gateError,
    error,
    followups,
    loaded,
    historyLoading,
    busy,
    works,
    intake,
    projects, agents, teams,
    refresh,
    renameWork: async (work, title) => { await renameEngineWork(work.id, title, work.revision); await refresh(); },
    closeWork: async (work) => { await closeEngineWork(work.id, work.revision); await refresh(); },
    startWork: async (work) => { await startEngineWork(work.id, work.revision); await refresh(); },
    submitArtifact: async (work, title, content) => {
      let version = work.revision;
      // The final human phase starts by being delivered: READY → RUNNING → REVIEW.
      if (work.engineStatus === "ready") version = (await startEngineWork(work.id, version)).version;
      await submitEngineArtifact(work.id, version, title, content);
      await refresh();
    },
    setWorkBudget: async (work, modelAttempts) => {
      await setEngineWorkBudget(work.id, work.engineBudget?.version ?? 1, modelAttempts);
      await refresh();
    },
    setDue: async (work, dueDate) => {
      await setEngineWorkDue(work.id, work.revision, dueDate);
      await refresh();
    },
    revisePlan: async (work, action) => {
      await reviseEnginePlan({ workId: work.id, expectedVersion: work.revision, ...action });
      await refresh();
    },
    createWork,
    postMessage,
    confirmPatch,
    discardPatch,
    applyObjectivePatch,
    saveMemoryFromMessage,
    fulfillContribution,
    cancelInFlight,
    clearError: () => setError(null),
  };
}
