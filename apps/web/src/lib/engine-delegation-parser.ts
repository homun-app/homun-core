/** Parser and normalizer for subagent delegation observations (H21/H22). */

export type DelegationItem = {
  delegationId: string;
  status: "running" | "completed" | "cancelled" | "failed";
  task?: string | undefined;
  agentId?: string | undefined;
  result?: string | undefined;
  message?: string | undefined;
  structuredOutput?: Record<string, unknown> | null | undefined;
  schemaError?: string | null | undefined;
  turnsUsed?: number | undefined;
};

export function extractDelegations(
  observations?: Array<{ tool?: string; message?: string; result?: unknown }> | undefined
): DelegationItem[] {
  if (!observations || !Array.isArray(observations)) return [];

  const map = new Map<string, DelegationItem>();

  for (const obs of observations) {
    if (!obs || typeof obs !== "object") continue;
    const tool = obs.tool;
    if (tool !== "delegate_task" && tool !== "delegation_poll" && tool !== "delegation_cancel") {
      continue;
    }

    const res = (obs.result && typeof obs.result === "object" ? obs.result : {}) as Record<string, unknown>;
    const delId = (res["delegation_id"] || res["id"]) as string | undefined;
    if (!delId || typeof delId !== "string") continue;

    const existing = map.get(delId);
    const rawStatus = res["status"] || (tool === "delegation_cancel" ? "cancelled" : "completed");
    const normalizedStatus: DelegationItem["status"] =
      rawStatus === "running"
        ? "running"
        : rawStatus === "cancelled"
        ? "cancelled"
        : rawStatus === "failed"
        ? "failed"
        : "completed";

    const item: DelegationItem = {
      delegationId: delId,
      status: normalizedStatus,
      task: (res["task"] as string | undefined) ?? existing?.task,
      agentId: (res["agent_id"] as string | undefined) ?? existing?.agentId,
      result: res["result"] !== undefined ? String(res["result"]) : existing?.result,
      message: (res["message"] as string | undefined) ?? existing?.message,
      structuredOutput: (res["structured_output"] as Record<string, unknown> | null | undefined) ?? existing?.structuredOutput,
      schemaError: (res["schema_error"] as string | null | undefined) ?? existing?.schemaError,
      turnsUsed: (res["turns_used"] as number | undefined) ?? (res["turns"] as number | undefined) ?? existing?.turnsUsed ?? 1,
    };

    map.set(delId, item);
  }

  return Array.from(map.values());
}
