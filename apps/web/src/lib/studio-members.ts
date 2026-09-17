import { createContext } from "react";
import type { AutonomyMode } from "./studio-supervision";
import type { TrainingActivity } from "../components/builder/StudioTraining";
export type StudioMember = {
  id: string;
  name: string;
  role?: string;
  responsibility?: string;
  specializations?: string[];
  tools?: string[];
  method?: string;
  tone?: string;
  activities?: TrainingActivity[];
  autonomy?: AutonomyMode;
  color?: string;
};
export const StudioMembersContext = createContext<StudioMember[]>([]);
export function matchesMember(m: StudioMember, query: string) {
  const normalize = (text: string) =>
    text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("it");
  const text = normalize(
    [
      m.name,
      m.role,
      m.responsibility,
      ...(m.specializations || []),
      ...(m.activities || []).map((a) => a.title),
    ].join(" "),
  );
  return normalize(query)
    .trim()
    .split(/\s+/)
    .every((word) => text.includes(word));
}
