# Conversational workspace alternative

Goal: preserve first-work and create a separate conversation-led prototype at prototypes/conversations.html.

Approved design: navigation on the left; conversation in the centre; current actionable work on the right. One canonical work state drives notification, contribution request, result and review. Settings/costs are secondary. No fake execution.

Implementation:
1. Separate Vite entry, React component and scoped CSS; reuse AI Elements StudioChatInput.
2. Three guided scenarios with editable requests and common lifecycle: proposal, awaiting contribution, ready, review, approved. Files/folders and text contributions resolve the same pending request shown in notifications.
3. Keep conversations accessible, disclose simulated results, provide result preview and approval/revision. No external actions or real inference.
4. Verify via browser full flow and responsive layout, typecheck and build both entries.

Limit: local in-memory alternative, not shared storage with old prototype. Freeform understanding limited and disclosed. User preferences for engine and local installation unchanged.

## Expansion 2026-09-17
Added compact Team/Projects/Automations collections using conversation + confirmation panel. Mixed human/agent teams have a coordinator without implicit permission changes. Projects reference teams, work references projects. Routines reference source work and produce separate simulated runs; no real scheduler. Freeform instructions are preserved but only guided setup is interpreted. Search uses a native modal, Cmd/Ctrl-K and text matching across work, messages, uploaded filenames, result templates, team/project/routine notes and collaborator profiles. Demo has a single shared local workspace, not real per-user authorization. Existing prototype remains separate.

Browser verification: team Commerciale with Marta/Vera/Giulia, linked project, catalog work, routine creation and separate simulated run; search finds team and linked project; team notes searchable. Build/typecheck pass. React fast-refresh warning for exported directory constant is non-blocking.
