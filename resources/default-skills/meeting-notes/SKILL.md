---
name: meeting-notes
description: Use when the user provides a meeting recording, transcript, or raw notes and wants them turned into structured minutes — summary, decisions, and action items. Triggers on "note della riunione / verbale / riassumi questa call / action items / cosa abbiamo deciso".
---

# Meeting Notes

Turn a meeting (recording, transcript, or messy notes) into **structured minutes**:
a short summary, the decisions taken, and a clear action-item list with owners and
due dates — saved as an artifact, and optionally wired into Homun's tasks/automations.

## When to use

"Riassumi questa call", "fammi il verbale", "estrai gli action item", "cosa abbiamo
deciso nella riunione", after the user shares an audio file, a transcript, or notes.

## Input

- If the user shares **audio**, it is transcribed first (Homun's transcription); work
  from the resulting transcript.
- If the user shares a **transcript or notes**, work from that text directly.
- If neither is present, ask the user to paste the transcript or attach the recording.

## Process

1. **Read the whole transcript** before writing. Identify participants (if named), the
   purpose, and the threads of discussion.
2. **Produce the minutes** in this exact structure, in the meeting's language:
   - **Sintesi** — 3–6 sentences: what the meeting was about and the outcome.
   - **Decisioni** — bullet list of decisions actually taken (not topics discussed).
   - **Action items** — a table: `Cosa | Responsabile | Scadenza`. Only real, assignable
     actions. Infer owners/dates only when stated or strongly implied; otherwise leave
     blank rather than invent.
   - **Punti aperti** — unresolved questions / parked items.
3. **Save as an artifact.** Write the minutes to `$OUTPUT_DIR/<name>.md` and render a PDF
   (use the `create-documents` HTML→PDF approach) so the user can share it. Offer
   `save_artifact` to a folder.
4. **Offer to operationalise.** For each action item with a date, OFFER (don't auto-do)
   to create a Homun **task** or, if recurring, an **automation** — so follow-ups don't
   get lost. Create them only if the user confirms.

## Quality bar

- Decisions ≠ discussion: list only what was decided.
- Action items are specific and checkable; no vague "follow up on things".
- Never fabricate attendees, decisions, owners or dates not supported by the transcript.
- Keep the summary tight — the value is signal, not a re-transcription.
