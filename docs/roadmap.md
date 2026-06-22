# Homun roadmap operativa

## Obiettivo attivo

Path B: consentire scritture MCP filesystem di routine solo entro la root
esplicitamente configurata del workspace, senza ampliare l’autorità fuori scope.

## Fase corrente

L’enforcement è nel loop MCP: le sole write dichiarate di `mcp:filesystem`
(`create`, `insert`, `str_replace`) entro la root del thread evitano la card;
fuori root resta obbligatoria una proof di conferma. Il connettore Filesystem è
globale, mentre la root è risolta automaticamente per chat/progetto.

Gate runtime Electron (2026-06-22, `kimi-k2.6:cloud`): il thread
`thread_1782138001_1782138001354628000` del progetto `test-homun` ha usato
`mcp__filesystem__create` per creare
`/Users/fabio/Desktop/test-homun/path-b-gate/note.md`, senza marker di
confirm-card. File e `chat_messages` verificati. Piano:
[2026-06-22-workspace-scoped-filesystem-writes.md](superpowers/plans/2026-06-22-workspace-scoped-filesystem-writes.md).

## Milestone

1. Ripetere in UI visibile e su Gemma il gate in-root senza card.
2. Verificare il ramo fuori-root: deve apparire la card e non deve eseguire.
3. Decidere WS6.1c UX dopo il gate completo Path B.

## Blocco noto

Il direct MCP endpoint lega un write fuori root alla confirm-card persistita;
il ramo ha test unitari, ma gli manca ancora la prova manuale in app. Il design è in
[2026-06-22-workspace-scoped-filesystem-writes-design.md](superpowers/specs/2026-06-22-workspace-scoped-filesystem-writes-design.md).

## Prossima azione

Eseguire il gate UI/Gemma in-root, poi quello fuori-root con card.
