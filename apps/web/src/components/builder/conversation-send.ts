/**
 * Composer message router for the simulated conversation workspace:
 * navigation commands, engine delegation, plan commands and per-phase work
 * replies. Bodies moved verbatim from ConversationWorkspace, which stays the
 * composition shell (same schema as createSimulationActions).
 */
import type { Dispatch, SetStateAction } from "react";
import type { CatalogPlan } from "./ConversationCatalogPlan";
import type { ConversationScenario } from "./conversation-scenarios";
import { memberProfile } from "./conversation-members";
import { type SpaceData, type SpaceView, spacePeople } from "./ConversationSpace";
import type { ConversationPreferences } from "./conversation-preferences";
import type { Work } from "./conversation-types";
import type { EngineWorkspaceState } from "@/hooks/useEngineWorkspace";
import { parseConversationNavigation } from "@/lib/conversation-navigation";
import {
  parsePlanInsert,
  parsePlanReorder,
  reorderPlanSteps,
  stripTrailingMention,
} from "@/lib/conversation-plan-commands";
import { handleEngineSend } from "@/lib/engine-send-handler";

export type ConversationSendDeps = {
  engine: EngineWorkspaceState;
  work: Work | undefined;
  scenario: ConversationScenario | null;
  scenarios: ConversationScenario[];
  viewer: string;
  assignee: string;
  spaceData: SpaceData;
  preferences: ConversationPreferences;
  newChatProjectId: string | null;
  open: (id: string | null, selector?: string) => void;
  openSpace: (view: SpaceView, initial?: string, selected?: string) => void;
  openSettings: (nextSection?: string) => void;
  create: (
    index: number,
    text?: string,
    attachments?: File[],
    projectId?: string,
    override?: ConversationScenario,
  ) => string | undefined;
  createFreeWork: (
    name: string,
    text: string,
    attachments: File[],
    projectId?: string,
  ) => string | undefined;
  deliver: (text?: string, attachments?: File[]) => void;
  fulfillContribution: (text: string, attachments: File[], ids: string[]) => void;
  updatePlan: (next: CatalogPlan, starting?: boolean) => void;
  patch: (change: Partial<Work>) => void;
  setWorks: Dispatch<SetStateAction<Work[]>>;
  setNotice: Dispatch<SetStateAction<string>>;
  setPlanEdit: Dispatch<SetStateAction<{ workId: string; plan: CatalogPlan } | null>>;
  setPanel: Dispatch<SetStateAction<boolean>>;
  bumpOwnSend: () => void;
};

export function createConversationSend({
  engine,
  work,
  scenario,
  scenarios,
  viewer,
  assignee,
  spaceData,
  preferences,
  newChatProjectId,
  open,
  openSpace,
  openSettings,
  create,
  createFreeWork,
  deliver,
  fulfillContribution,
  updatePlan,
  patch,
  setWorks,
  setNotice,
  setPlanEdit,
  setPanel,
  bumpOwnSend,
}: ConversationSendDeps) {
  function send(text: string, attachments: File[]) {
    const navigation = !attachments.length ? parseConversationNavigation(text) : null;
    if (navigation) {
      if (navigation.target === "settings") openSettings();
      else openSpace(navigation.view);
      return;
    }

    if (
      handleEngineSend({
        engine,
        work: work ?? null,
        text,
        attachments,
        open,
        setNotice,
        bumpOwnSend,
        autonomyLevel: preferences.autonomyLevel,
        modelConnectionId: preferences.preferredModelConnectionId || undefined,
        projectId: newChatProjectId ?? undefined,
      })
    ) {
      return;
    }

    if (work?.catalogPlan && work.phase !== "approved" && /^sposta\s/i.test(text)) {
      const plan = work.catalogPlan;
      const reorder = parsePlanReorder(text);
      const steps = reorder ? reorderPlanSteps(plan.steps, plan.completed, reorder) : null;
      if (steps) {
        setPlanEdit({ workId: work.id, plan: { ...plan, steps } });
        patch({
          messages: [
            ...work.messages,
            { who: "you", text },
            {
              who: "agent",
              text: "Ti propongo questo ordine. I passaggi già conclusi rimangono invariati.",
            },
          ],
        });
        setPanel(true);
        return;
      }
      setNotice(
        "Per riordinare indica i titoli di due passaggi futuri: Sposta Tradurre il catalogo dopo Preparare la bozza.",
      );
      return;
    }

    if (
      work?.catalogPlan &&
      work.phase !== "approved" &&
      /^(aggiungi|inserisci)\b/i.test(text.trim())
    ) {
      const insert = parsePlanInsert(text);
      if (insert) {
        const names = [...new Set([...spacePeople, ...Object.keys(spaceData.profiles || {})])];
        const agent = names.find((n) => text.toLowerCase().includes("@" + n.toLowerCase())) || "";
        const title = stripTrailingMention(insert.rawTitle);
        const anchor = insert.rawAnchor ? stripTrailingMention(insert.rawAnchor).toLowerCase() : "";
        const index = anchor
          ? work.catalogPlan.steps.findIndex((s) => s.title.toLowerCase().includes(anchor))
          : work.catalogPlan.steps.length;
        const position = index + (insert.relation === "dopo" ? 1 : 0);
        if (index < 0 || position < work.catalogPlan.completed) {
          setNotice(
            "Indica un passaggio futuro usando il suo titolo, oppure inseriscilo con + nel piano.",
          );
          return;
        }
        const steps = [...work.catalogPlan.steps];
        steps.splice(position, 0, { id: crypto.randomUUID(), title, agent });
        setPlanEdit({ workId: work.id, plan: { ...work.catalogPlan, steps } });
        patch({
          messages: [
            ...work.messages,
            { who: "you", text },
            {
              who: "agent",
              text: "Ecco la modifica proposta al piano. Controlla la posizione e applicala; puoi scegliere il collaboratore dal passaggio.",
            },
          ],
        });
        setPanel(true);
        return;
      }
    }

    if (scenario && spaceData.removedPeople?.includes(scenario.agent)) {
      setNotice("Agente eliminato: conversazione in sola consultazione.");
      return;
    }
    if (/crea.*(agente|collaboratore)/i.test(text) && !work) {
      openSpace("Nuovo collaboratore", text);
      return;
    }
    if (
      !attachments.length &&
      /crea.*(team|squadra)|crea.*progett|ripet|ogni luned|automatizza/i.test(text)
    ) {
      openSpace(
        /team|squadra/i.test(text) ? "Squadra" : /progett/i.test(text) ? "Progetti" : "Automazioni",
        text,
      );
      return;
    }
    if (!work) {
      if (
        /catalog/i.test(text) &&
        /\bmarta\b/i.test(text) &&
        /\bvera\b/i.test(text) &&
        /prezz/i.test(text)
      ) {
        create(0, text, attachments);
        return;
      }
      const mentioned = scenarios.find(
        (s) =>
          memberProfile(s.agent, spaceData.profiles).invitation !== "pending" &&
          text.toLowerCase().includes("@" + s.agent.toLowerCase()) &&
          !spaceData.removedPeople?.includes(s.agent),
      );
      if (assignee || mentioned) {
        createFreeWork(assignee || mentioned!.agent, text, attachments);
        return;
      }
      const index = /catalog|listin/i.test(text)
        ? 0
        : /ricerca|mercato|concorrent/i.test(text)
          ? 1
          : /log|error/i.test(text)
            ? 2
            : -1;
      if (index < 0) {
        setNotice(
          "Scegli a chi affidarlo: scrivi @ e seleziona un collaboratore, oppure apri la sua scheda e premi Affida un lavoro.",
        );
        return;
      }
      create(index, text, attachments);
      return;
    }
    if (work.request?.status === "pending") {
      if (work.request.to === viewer && !work.request.childId)
        fulfillContribution(text, attachments, []);
      else
        setNotice(
          `La richiesta è assegnata a ${work.request.to}. Apri il contributo nel pannello.`,
        );
      return;
    }
    if (work.phase === "waiting") {
      deliver(text, attachments);
      return;
    }
    if (work.phase === "review" && work.catalogPlan && text.trim()) {
      const next = {
        ...work.catalogPlan,
        steps: [
          ...work.catalogPlan.steps,
          {
            id: crypto.randomUUID(),
            title: "Revisione: " + text.trim(),
            agent: work.catalogPlan.steps.at(-1)?.agent || scenario!.agent,
          },
        ],
      };
      updatePlan(next);
      setWorks((current) =>
        current.map((w) =>
          w.id === work.id
            ? {
                ...w,
                feedback: text,
                revision: w.revision + 1,
                files: [...w.files, ...attachments],
                messages: [
                  ...w.messages,
                  { who: "you", text },
                  {
                    who: "agent",
                    text: "Ho aggiunto un passaggio di revisione. Il risultato precedente è conservato; nella demo puoi simulare la nuova consegna.",
                  },
                ],
              }
            : w,
        ),
      );
      return;
    }
    if (work.phase === "review") {
      if (!text.trim()) {
        setNotice("Scrivi cosa vorresti cambiare nella bozza.");
        return;
      }
      patch({
        feedback: text,
        revision: work.revision + 1,
        files: [...work.files, ...attachments],
        messages: [
          ...work.messages,
          { who: "you", text },
          {
            who: "agent",
            text: "Ho registrato la correzione nella bozza, nella sezione Indicazioni di revisione. Puoi riaprirla per verificarla. Il contenuto non viene riscritto da un modello in questa prova.",
          },
        ],
      });
      return;
    }
    patch({
      ...(work.catalogPlan && work.phase === "proposal" && text.trim()
        ? { contribution: [work.contribution, text].filter(Boolean).join("\n") }
        : {}),
      files: [...work.files, ...attachments],
      messages: [
        ...work.messages,
        { who: "you", text: text || `${attachments.length} file allegati.` },
        {
          who: "agent",
          text:
            work.phase === "proposal"
              ? "Indicazione conservata per il lavoro. Controlla i passaggi nel piano a destra e avvia quando sei pronto."
              : "Messaggio conservato nel lavoro. Questa prova non interpreta ulteriori istruzioni: usa l’azione a destra per continuare.",
        },
      ],
    });
  }
  return send;
}
