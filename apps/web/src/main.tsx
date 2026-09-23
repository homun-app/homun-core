import { ContributionPortal } from "./components/ContributionPortal";
import { createRoot } from "react-dom/client";
import { ConversationWorkspace } from "./components/builder/ConversationWorkspace";
import "./styles.css";
import "./components/builder/conversation-workspace.css";

// Production shell: the workspace IS the app. Engine diagnostics live in Settings.
createRoot(document.getElementById("root")!).render(
  <div className="app-shell">
    <>{new URLSearchParams(window.location.hash.slice(1)).has("contribution") ? <ContributionPortal /> : <ConversationWorkspace />}</>
  </div>,
);
