import { useEffect, useState } from "react";
import type { ConnectionItem } from "../types";
import { coreBridge } from "./coreBridge";
import { mapCoreCapabilitySnapshot } from "./appCoreMappers";

export function useCapabilityController(): { connectionItems: ConnectionItem[] } {
  const [connectionItems, setConnectionItems] =
    useState<ConnectionItem[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function loadCapabilities() {
      try {
        const nextConnections = mapCoreCapabilitySnapshot(
          await coreBridge.capabilities(),
        );
        if (!cancelled) {
          setConnectionItems(nextConnections);
        }
      } catch (error) {
        console.warn("capability_snapshot unavailable", error);
      }
    }

    void loadCapabilities();
    return () => {
      cancelled = true;
    };
  }, []);

  return { connectionItems };
}
