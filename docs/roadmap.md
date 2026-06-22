# Homun roadmap operativa

## Obiettivo attivo

Path B: consentire scritture MCP filesystem di routine solo entro la root
esplicitamente configurata del workspace, senza ampliare l’autorità fuori scope.

## Fase corrente

Manifest dichiarativo + absolute jail completati (commit `447dc0f`, `c28cbf8`).
Resta l’enforcement nel loop MCP e la prova persistita della confirm-card per
l’endpoint. Piano: [2026-06-22-workspace-scoped-filesystem-writes.md](superpowers/plans/2026-06-22-workspace-scoped-filesystem-writes.md).

## Milestone

1. Applicare l’autorità workspace/confirm/remote-confirmed al dispatch MCP.
2. Verificare Gemma in-root senza card e fuori-root con card.
3. Decidere WS6.1c UX dopo il gate Path B.

## Blocco noto

Il direct MCP endpoint deve legare un write fuori root alla confirm-card
persistita; il design è in
[2026-06-22-workspace-scoped-filesystem-writes-design.md](superpowers/specs/2026-06-22-workspace-scoped-filesystem-writes-design.md).

## Prossima azione

Completare test-first l’autorità MCP, quindi eseguire il gate in-app.
