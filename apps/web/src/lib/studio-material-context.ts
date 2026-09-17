import { createContext } from "react";
import type { SharedDocument } from "../components/builder/StudioDocuments";
import type { TodayProject } from "../components/builder/StudioToday";
export type MaterialLink = { id: string; version: number; title: string };
export const StudioMaterialContext = createContext<{
  documents: SharedDocument[];
  projects: TodayProject[];
  members: string[];
}>({ documents: [], projects: [], members: [] });
