import { createRoot } from "react-dom/client";
import { StudioWorkbench } from "./reference/src/components/builder/StudioWorkbench";
import "./reference/src/styles.css";

createRoot(document.getElementById("root")!).render(<StudioWorkbench />);
