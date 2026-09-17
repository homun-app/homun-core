import { createRoot } from "react-dom/client";
import { ConversationWorkspace } from "./components/builder/ConversationWorkspace";
import "./styles.css";
import "./components/builder/conversation-workspace.css";
// Transitional UI: simulated until the Python API adapter is implemented.
createRoot(document.getElementById("root")!).render(<ConversationWorkspace />);
