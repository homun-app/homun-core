import { navItems as staticNavItems } from "../data/navigationConfig";
import { pluginRegistry, type PluginHost } from "../plugins/registry";
import { composePluginNavItems, enabledRegistryPlugins } from "./appPluginNavigation";
import type { PluginState } from "./coreBridge";

export function usePluginHostController({
  pluginStates,
  openChat,
  startTemplateWorkflow,
}: {
  pluginStates: PluginState[];
  openChat: PluginHost["openChat"];
  startTemplateWorkflow: PluginHost["startTemplateWorkflow"];
}) {
  const enabledPlugins = enabledRegistryPlugins(pluginRegistry, pluginStates);
  const composedNavItems = composePluginNavItems(staticNavItems, enabledPlugins);
  const pluginHost: PluginHost = {
    openChat,
    startTemplateWorkflow,
  };

  return {
    enabledPlugins,
    composedNavItems,
    pluginHost,
  };
}
