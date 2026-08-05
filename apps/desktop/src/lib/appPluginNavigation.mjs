export function enabledRegistryPlugins(registry, states) {
  return registry.filter(
    (plugin) => states.find((state) => state.id === plugin.id)?.enabled !== false,
  );
}

export function composePluginNavItems(staticNavItems, plugins) {
  return [
    ...staticNavItems,
    ...plugins.map((plugin) => ({
      id: plugin.id,
      label: plugin.navLabel,
      icon: plugin.navIcon,
      navSection: plugin.navSection ?? "more",
      promoted: plugin.promoted === true,
      order: plugin.navOrder,
    })),
  ];
}
