// @ts-expect-error — .mjs sibling, resolved at build by Vite.
import * as implementation from "./mcpConnection.mjs";

export type McpRemoteAuthMode = "none" | "bearer";

export interface McpRemoteForm {
  name: string;
  url: string;
  authMode: McpRemoteAuthMode;
  bearerToken: string;
}

export interface McpRemoteConnectInput {
  name: string;
  url: string;
  headers: Record<string, string>;
}

export function remoteMcpReady(form: McpRemoteForm): boolean {
  return implementation.remoteMcpReady(form);
}

export function buildRemoteMcpConnectInput(form: McpRemoteForm): McpRemoteConnectInput {
  return implementation.buildRemoteMcpConnectInput(form);
}
