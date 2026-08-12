// Pure mapping from a kernel `step_advance` payload to the localized inline
// notice rendered in the chat transcript. Shared by Node tests and the app.
// Contract payload: { step_id, title, from: string|null, to: string,
// verified: boolean|null, note: string|null }.

export function isValidStepAdvancePayload(payload) {
  return Boolean(
    payload
    && typeof payload === "object"
    && typeof payload.step_id === "string"
    && typeof payload.title === "string"
    && typeof payload.to === "string"
  );
}

export function stepAdvanceDisplay(payload) {
  const title = typeof payload?.title === "string" ? payload.title : "";
  // Verified completion: "✓ Step verificato: <title>"
  if (payload?.verified === true && payload?.to === "done") {
    return {
      kind: "verified",
      i18nKey: "chat.stepAdvance.verified",
      params: { title },
    };
  }
  // Failed verification: "✗ Step non verificato: <title> — <note>"
  if (payload?.verified === false) {
    const note = typeof payload?.note === "string" ? payload.note.trim() : "";
    if (note) {
      return {
        kind: "unverified",
        i18nKey: "chat.stepAdvance.unverified",
        params: { title, note },
      };
    }
    return {
      kind: "unverified",
      i18nKey: "chat.stepAdvance.unverifiedNoNote",
      params: { title },
    };
  }
  // Any other status change: "→ Step <title>: <from> → <to>"
  return {
    kind: "transition",
    i18nKey: "chat.stepAdvance.transition",
    params: { title, from: payload?.from ?? "\u2014", to: payload?.to ?? "" },
  };
}
