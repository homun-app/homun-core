import type { PluginState } from "./coreBridge";
import type { NavItem } from "../types";
import type { PluginManifest } from "../plugins/registry";

// @ts-expect-error JavaScript sibling intentionally has no declaration file.
import * as implementation from "./appPluginNavigation.mjs";

export const enabledRegistryPlugins = implementation.enabledRegistryPlugins as (
  registry: PluginManifest[],
  states: PluginState[],
) => PluginManifest[];

export const composePluginNavItems = implementation.composePluginNavItems as (
  staticNavItems: NavItem[],
  plugins: PluginManifest[],
) => NavItem[];
