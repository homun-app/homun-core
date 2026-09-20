/**
 * Simulation-era conversation types (IndexedDB prototype).
 * Engine domain types live in contracts / API responses — do not merge them silently.
 */

import type { CatalogPlan } from "./ConversationCatalogPlan";
import type { ConversationMaterial } from "./ConversationMaterials";
import type { ConversationPreferences } from "./conversation-preferences";
import type { ConversationScenario } from "./conversation-scenarios";
import type { SpaceData, SpaceView } from "./ConversationSpace";

export type Phase = "proposal" | "waiting" | "ready" | "review" | "approved";

export type ConversationMessage = {
  engineMessageId?: string;
  sender?: string;
  who: "you" | "agent";
  text: string;
  /** F3.5: in-flight / incomplete assistant turn (not yet final). */
  partial?: boolean;
  /** F3.5a: user explicitly promoted this turn to approved memory. */
  memorySaved?: boolean;
  /** F3.4: pending patch preview attached to an assistant turn (engine only). */
  patchProposal?: {
    work_id: string;
    base_version: number;
    changes: Array<{
      field: "objective" | "owner_id" | "step_assignee";
      from_value?: string | null;
      to_value?: string | null;
      step_id?: string | null;
    }>;
    summary_lines: string[];
  };
  patchResolved?: "applied" | "discarded";
};

/** @deprecated Prefer ConversationMessage — kept during modularization. */
export type Message = ConversationMessage;

export type Work = {
  archived?: boolean;
  catalogPlan?: CatalogPlan;
  coordinatedBy?: string;
  request?: { to: string; need: string; status: "pending" | "resolved"; childId?: string };
  routineId?: string;
  runNumber?: number;
  startedAt?: string;
  requester?: string;
  autonomy?: "supervised" | "autonomous";
  reviewer?: string;
  approvedBy?: string;
  autoDelivered?: boolean;
  humanDraft?: string;
  humanResult?: string;
  materialIds?: string[];
  projectId?: string;
  /** Explicit provenance — never infer from id shape. */
  source?: "simulation" | "engine";
  engineConversationId?: string;
  engineStatus?: string;
  engineOwnerName?: string;
  /** Engine plan/artifact revision counters (Fonte=motore); 0 = none yet. */
  enginePlanRevision?: number;
  engineArtifactVersion?: number;
  /** Pending contribution request id (Fonte=motore). */
  engineContributionRequestId?: string;
  /** Current objective from engine domain (Fonte=motore). */
  engineObjective?: string;
  id: string;
  scenario: number;
  title: string;
  phase: Phase;
  due: string;
  messages: ConversationMessage[];
  files: File[];
  contribution: string;
  revision: number;
  feedback: string;
};

export type PrototypeSnapshot = {
  version: 1;
  savedAt: string;
  scenarios: (ConversationScenario & { custom?: boolean })[];
  works: Work[];
  materials: ConversationMaterial[];
  spaceData: SpaceData;
  preferences: ConversationPreferences;
  seenResults: string[];
  attachmentMetadata: { file: File; id: string; date: string }[];
  view: {
    active: string | null;
    space: SpaceView | null;
    sidebarOpen: boolean;
    panel: boolean;
    viewer: string;
    selected?: string;
  };
};
