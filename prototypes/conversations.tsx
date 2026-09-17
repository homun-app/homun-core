import { createRoot } from "react-dom/client";
import { ConversationWorkspace } from "./reference/src/components/builder/ConversationWorkspace";
import "./reference/src/styles.css";
import "./reference/src/components/builder/conversation-workspace.css";
createRoot(document.getElementById("root")!).render(<ConversationWorkspace />);
