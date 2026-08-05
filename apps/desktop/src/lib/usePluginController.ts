import { useCallback, useEffect, useState } from "react";
import { coreBridge, type PluginState } from "./coreBridge";

export function usePluginController(): {
  pluginStates: PluginState[];
  reloadPlugins: () => Promise<void>;
} {
  const [pluginStates, setPluginStates] = useState<PluginState[]>([]);

  const reloadPlugins = useCallback(async () => {
    try {
      setPluginStates(await coreBridge.plugins());
    } catch (error) {
      console.warn("plugins unavailable", error);
    }
  }, []);

  useEffect(() => {
    void reloadPlugins();
  }, [reloadPlugins]);

  return { pluginStates, reloadPlugins };
}
