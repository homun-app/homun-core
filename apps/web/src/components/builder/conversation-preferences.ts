export type AutonomyLevel = "autonomous" | "guarded" | "supervised";

export type ConversationPreferences = {
  spaceName: string;
  displayName: string;
  company: string;
  language?: "it" | "en";
  textSize: "standard" | "large";
  motion: boolean;
  resultNotifications: boolean;
  routing: "automatic" | "quality" | "fast";
  execution: "cloud" | "local";
  autonomyLevel?: AutonomyLevel | undefined;
  preferredModelConnectionId?: string | undefined;
  budget: number;
  perWorkBudget: number;
};
export const defaultPreferences: ConversationPreferences = {
  spaceName: "Il tuo spazio",
  displayName: "Tu",
  company: "",
  language: "it",
  textSize: "standard",
  motion: true,
  resultNotifications: true,
  routing: "automatic",
  execution: "local",
  autonomyLevel: "guarded",
  preferredModelConnectionId: "",
  budget: 100,
  perWorkBudget: 10,
};
