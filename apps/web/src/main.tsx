import { createRoot } from "react-dom/client";
import { ConversationWorkspace } from "./components/builder/ConversationWorkspace";
import { EngineStatusBar } from "./components/EngineStatusBar";
import "./styles.css";
import "./components/builder/conversation-workspace.css";
import "./components/engine-status-bar.css";

// Product shell: thin engine status + workspace. Model setup lives in Settings.
createRoot(document.getElementById("root")!).render(
  <div className="app-shell">
    <EngineStatusBar />
    <ConversationWorkspace />
  </div>,
);
