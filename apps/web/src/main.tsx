import { ContributionPortal } from "./components/ContributionPortal";
import { createRoot } from "react-dom/client";
import { ConversationWorkspace } from "./components/builder/ConversationWorkspace";
import { getLanguage } from "./lib/i18n";
import { setEngineLanguage } from "./lib/engine-preferences-client.ts";
import "./styles.css";
import "./components/builder/conversation-workspace.css";

// La preferenza lingua della UI va al motore anche all'avvio: se era spento
// quando l'utente l'ha cambiata, ora la ritrova (best-effort, non blocca).
void setEngineLanguage(getLanguage());

// Production shell: the workspace IS the app. Engine diagnostics live in Settings.
createRoot(document.getElementById("root")!).render(
  <div className="app-shell">
    <>
      {new URLSearchParams(window.location.hash.slice(1)).has("contribution") ? (
        <ContributionPortal />
      ) : (
        <ConversationWorkspace />
      )}
    </>
  </div>,
);
