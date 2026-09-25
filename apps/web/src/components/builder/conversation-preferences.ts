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
  budget: 100,
  perWorkBudget: 10,
};
