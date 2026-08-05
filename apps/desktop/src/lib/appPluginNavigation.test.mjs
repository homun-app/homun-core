import assert from "node:assert/strict";
import test from "node:test";

import {
  composePluginNavItems,
  enabledRegistryPlugins,
} from "./appPluginNavigation.mjs";

const icon = () => null;

test("enabledRegistryPlugins keeps plugins enabled by default", () => {
  const plugins = [
    { id: "alpha", navLabel: "Alpha", navIcon: icon },
    { id: "beta", navLabel: "Beta", navIcon: icon },
  ];

  assert.deepEqual(enabledRegistryPlugins(plugins, [{ id: "alpha", enabled: true }]), plugins);
});

test("enabledRegistryPlugins removes only explicitly disabled plugins", () => {
  const plugins = [
    { id: "alpha", navLabel: "Alpha", navIcon: icon },
    { id: "beta", navLabel: "Beta", navIcon: icon },
  ];

  assert.deepEqual(
    enabledRegistryPlugins(plugins, [
      { id: "alpha", enabled: false },
      { id: "beta", enabled: true },
    ]),
    [plugins[1]],
  );
});

test("composePluginNavItems appends plugin nav entries without mutating static nav", () => {
  const staticNavItems = [{ id: "chat", label: "Chat", icon, navSection: "work" }];
  const plugins = [
    {
      id: "presentations",
      navLabel: "Presentations",
      navIcon: icon,
      navSection: "create",
      promoted: true,
      navOrder: 20,
    },
  ];

  const composed = composePluginNavItems(staticNavItems, plugins);

  assert.deepEqual(composed, [
    staticNavItems[0],
    {
      id: "presentations",
      label: "Presentations",
      icon,
      navSection: "create",
      promoted: true,
      order: 20,
    },
  ]);
  assert.equal(staticNavItems.length, 1);
});
