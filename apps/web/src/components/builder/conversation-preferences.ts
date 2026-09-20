export type ConversationPreferences = {
  spaceName: string;
  displayName: string;
  company: string;
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
  displayName: "Fabio",
  company: "",
  textSize: "standard",
  motion: true,
  resultNotifications: true,
  routing: "automatic",
  execution: "local",
  budget: 100,
  perWorkBudget: 10,
};
