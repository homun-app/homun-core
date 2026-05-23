import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import type { ViewId } from "../types";

interface ShellProps {
  activeView: ViewId;
  onNavigate: (view: ViewId) => void;
  children: ReactNode;
}

export function Shell({ activeView, onNavigate, children }: ShellProps) {
  return (
    <div className="app-shell">
      <Sidebar activeView={activeView} onNavigate={onNavigate} />
      {children}
    </div>
  );
}
