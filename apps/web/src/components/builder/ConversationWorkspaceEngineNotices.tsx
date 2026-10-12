/**
 * Engine-path operational banner for the workspace shell.
 * Silent when healthy; never offers simulation fallback. Simulation mode is
 * declared here — the one stable label in the main interface (the banner's
 * own «Fonte: simulazione» hint) — so no single panel repeats it.
 */
import type { EngineWorkspaceState } from "@/hooks/useEngineWorkspace";
import { ConversationEngineBanner } from "./ConversationEngineBanner";

type Props = {
  engine: EngineWorkspaceState;
  onOpenModels: () => void;
};

export function ConversationWorkspaceEngineNotices({ engine, onOpenModels }: Props) {
  return (
    <ConversationEngineBanner
      backend={engine.backend}
      dataSourceSelected={engine.dataSource}
      gateError={engine.gateError}
      error={engine.error}
      busy={engine.busy}
      workCount={engine.works.length}
      followups={engine.followups}
      onRefresh={() => void engine.refresh()}
      onOpenModels={onOpenModels}
    />
  );
}
