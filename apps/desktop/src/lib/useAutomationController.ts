import { useCallback, useEffect, useState } from "react";
import {
  coreBridge,
  type AutomationCreateteInput,
  type ManagedAutomation,
} from "./coreBridge";

export interface AutomationController {
  automationItems: ManagedAutomation[];
  handleCreateteAutomation: (input: AutomationCreateteInput) => Promise<void>;
  handleUpdateAutomation: (
    id: string,
    input: Partial<AutomationCreateteInput>,
  ) => Promise<void>;
  handleToggleAutomation: (id: string) => Promise<void>;
  handleDeleteAutomation: (id: string) => Promise<void>;
}

export function useAutomationController({
  workspaceId,
  enabled,
}: {
  workspaceId?: string;
  enabled: boolean;
}): AutomationController {
  const [automationItems, setAutomationItems] = useState<ManagedAutomation[]>([]);

  const loadAutomations = useCallback(async () => {
    try {
      setAutomationItems(await coreBridge.automations(workspaceId));
    } catch (error) {
      console.warn("automations unavailable", error);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (enabled) void loadAutomations();
  }, [enabled, loadAutomations]);

  const handleCreateteAutomation = useCallback(
    async (input: AutomationCreateteInput) => {
      try {
        await coreBridge.createAutomation({
          ...input,
          workspace_id: input.workspace_id ?? workspaceId,
        });
        await loadAutomations();
      } catch (error) {
        console.warn("create automation failed", error);
      }
    },
    [loadAutomations, workspaceId],
  );

  const handleUpdateAutomation = useCallback(
    async (id: string, input: Partial<AutomationCreateteInput>) => {
      try {
        await coreBridge.updateAutomation(id, input, workspaceId);
        await loadAutomations();
      } catch (error) {
        console.warn("update automation failed", error);
      }
    },
    [loadAutomations, workspaceId],
  );

  const handleToggleAutomation = useCallback(
    async (id: string) => {
      try {
        await coreBridge.toggleAutomation(id, workspaceId);
        await loadAutomations();
      } catch (error) {
        console.warn("toggle automation failed", error);
      }
    },
    [loadAutomations, workspaceId],
  );

  const handleDeleteAutomation = useCallback(
    async (id: string) => {
      try {
        await coreBridge.deleteAutomation(id, workspaceId);
        await loadAutomations();
      } catch (error) {
        console.warn("delete automation failed", error);
      }
    },
    [loadAutomations, workspaceId],
  );

  return {
    automationItems,
    handleCreateteAutomation,
    handleUpdateAutomation,
    handleToggleAutomation,
    handleDeleteAutomation,
  };
}
