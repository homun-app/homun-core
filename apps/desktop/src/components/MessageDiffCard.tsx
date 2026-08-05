import { DiffView } from "./CodeView";
import type { DiffEventPayload } from "../types";

// Renders the model's proposed change for a single file path with a unified diff.
export function DiffCard({ payload }: { payload: DiffEventPayload }) {
  return (
    <div className="diff-card">
      <div className="diff-card-header">
        <span className="diff-card-path">
          {"\u{1F4C4} "}
          {payload.path}
        </span>
        {payload.label && <span className="diff-card-label">{payload.label}</span>}
      </div>
      <DiffView oldText={payload.old ?? ""} newText={payload.new} />
    </div>
  );
}
