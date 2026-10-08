# Optional organization onboarding

The direct Homun chat remains available. Welcome and Squadra expose the same optional context editor. The person describes the company, people and responsibilities, current tools and goals. Saving persists the actor-owned context in SQLite command records, with optimistic revisions; reopening either entry reads it back.

A configured model proposes at most six supervised agent profiles and a team. The strict schema rejects unknown capability IDs. The editor exposes instructions, declared capabilities, tools still needed, open questions and limitations. A profile never grants tool access or connects an integration. People described in the context are not impersonated or invited.

Model calls occur outside the storage transaction. Interrupted and failed proposals remain durable. Results are pinned to the saved context revision and superseded by later proposals. Explicit confirmation creates all profiles and team in one transaction; retries cannot create a duplicate team. Another actor cannot read or confirm this draft.

Validation: backend tests exercise persistence, actor isolation, revision conflict, command reuse, provider failure, unknown capabilities, absence of implicit creation, replay, atomic rollback, a context edit during generation and HTTP validation. Client tests verify authority headers and visible conflict errors. Draft saving is explicit, not automatic. Context retrieval for subsequent work is available via `application.organization.get_state(ctx, actor)`; consumption by the work loop is a separate integration.
