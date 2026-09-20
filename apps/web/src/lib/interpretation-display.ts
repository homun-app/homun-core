/**
 * Format engine MessageInterpretation for chat display (F3.2 / F3.4).
 */

export type WorkPatchChange = {
  field: "objective" | "owner_id" | "step_assignee";
  from_value?: string | null;
  to_value?: string | null;
  step_id?: string | null;
};

export type WorkPatchProposal = {
  work_id: string;
  base_version: number;
  changes: WorkPatchChange[];
  summary_lines: string[];
  missing_or_ambiguous: string[];
};

export type MessageInterpretation = {
  kind: "reply" | "clarification" | "command_proposal" | "patch_proposal";
  text?: string | null;
  command?: { type: string; payload: Record<string, unknown>; summary: string } | null;
  mentions: Array<{
    raw: string;
    candidates: Array<{ id: string; display_name: string; kind: string }>;
  }>;
  ambiguity?: string | null;
};

export function formatInterpretationForUi(interp: MessageInterpretation): string {
  switch (interp.kind) {
    case "reply":
      return interp.text?.trim() || "(Risposta vuota)";
    case "clarification": {
      const bits = [interp.text?.trim() || "Serve un chiarimento."];
      for (const m of interp.mentions) {
        const opts = m.candidates.map((c) => `${c.display_name} (${c.id})`).join(", ");
        bits.push(`${m.raw}: ${opts || "nessun candidato"}`);
      }
      return bits.join("\n");
    }
    case "patch_proposal":
      return (
        (interp.text?.trim() || "Propongo una modifica al lavoro.") +
        "\n(Anteprima — usa Conferma o Annulla sulla card)"
      );
    case "command_proposal": {
      const summary = interp.command?.summary ?? interp.text ?? "Proposta comando";
      return `${summary}\n(Proposta in elaborazione verso bozza piano — F3.3)`;
    }
    default: {
      const _exhaustive: never = interp.kind;
      return _exhaustive;
    }
  }
}

export function parseInterpretation(raw: unknown): MessageInterpretation | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const kind = record["kind"];
  if (
    kind !== "reply" &&
    kind !== "clarification" &&
    kind !== "command_proposal" &&
    kind !== "patch_proposal"
  ) {
    return null;
  }
  const mentionsRaw = record["mentions"];
  const mentions = Array.isArray(mentionsRaw)
    ? mentionsRaw.map((item) => {
        const m = item as Record<string, unknown>;
        const candidatesRaw = m["candidates"];
        const candidates = Array.isArray(candidatesRaw)
          ? candidatesRaw.map((c) => {
              const cand = c as Record<string, unknown>;
              return {
                id: String(cand["id"] ?? ""),
                display_name: String(cand["display_name"] ?? ""),
                kind: String(cand["kind"] ?? "other"),
              };
            })
          : [];
        return { raw: String(m["raw"] ?? ""), candidates };
      })
    : [];
  const commandRaw = record["command"];
  let command: MessageInterpretation["command"] = null;
  if (commandRaw && typeof commandRaw === "object") {
    const c = commandRaw as Record<string, unknown>;
    command = {
      type: String(c["type"] ?? ""),
      payload: (c["payload"] as Record<string, unknown>) ?? {},
      summary: String(c["summary"] ?? ""),
    };
  }
  return {
    kind,
    text: record["text"] == null ? null : String(record["text"]),
    command,
    mentions,
    ambiguity: record["ambiguity"] == null ? null : String(record["ambiguity"]),
  };
}

export function parseWorkPatchProposal(raw: unknown): WorkPatchProposal | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const workId = String(record["work_id"] ?? "");
  const baseVersion = record["base_version"];
  if (!workId || typeof baseVersion !== "number") {
    return null;
  }
  const changesRaw = record["changes"];
  const changes: WorkPatchChange[] = Array.isArray(changesRaw)
    ? changesRaw.flatMap((item) => {
        if (!item || typeof item !== "object") {
          return [];
        }
        const c = item as Record<string, unknown>;
        const field = c["field"];
        if (field !== "objective" && field !== "owner_id" && field !== "step_assignee") {
          return [];
        }
        return [
          {
            field,
            from_value: c["from_value"] == null ? null : String(c["from_value"]),
            to_value: c["to_value"] == null ? null : String(c["to_value"]),
            step_id: c["step_id"] == null ? null : String(c["step_id"]),
          },
        ];
      })
    : [];
  const summaryRaw = record["summary_lines"];
  const summary_lines = Array.isArray(summaryRaw)
    ? summaryRaw.map((line) => String(line))
    : [];
  const missingRaw = record["missing_or_ambiguous"];
  const missing_or_ambiguous = Array.isArray(missingRaw)
    ? missingRaw.map((line) => String(line))
    : [];
  if (!changes.length || missing_or_ambiguous.length > 0) {
    return null;
  }
  return {
    work_id: workId,
    base_version: baseVersion,
    changes,
    summary_lines,
    missing_or_ambiguous,
  };
}
