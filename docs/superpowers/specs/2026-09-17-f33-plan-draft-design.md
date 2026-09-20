# F3.3 — Plan draft from interpretation (testable slice)

**Status:** accepted (implemented testable slice)  
**Decision:** After F3.2 interpret, when `kind=command_proposal`, extract a typed `PlanDraft`, validate required fields, then either ask only for missing data or call `plan.propose` on the work linked to the conversation. Fake path is deterministic so UI can be tested without Ollama; live path uses Pydantic AI.

**Out of scope:** F3.4 unified chat/manual patch preview UI, streaming, memory.
