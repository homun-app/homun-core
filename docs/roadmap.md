# Homun roadmap operativa

## Obiettivo attivo

Chiudere WS6 6.1b: un’approvazione Telegram deve eseguire l’azione pending e
far riprendere il thread, anche dopo restart o update del desktop gateway.

## Fase corrente

Implementazione del rebind autenticato del bridge Telegram. Il piano dettagliato
è [2026-06-22-telegram-bridge-rebind.md](superpowers/plans/2026-06-22-telegram-bridge-rebind.md).

## Milestone

1. Bridge: target gateway riconfigurabile e callback osservabile senza segreti.
2. Gateway: rebind di sidecar già in ascolto, fallback a restart per bridge legacy.
3. Gate Gemma: approve da Telegram → task `demo-piano` 5/5 + prove DB/filesystem.
4. Decisione successiva: WS6 6.1c UX oppure Path B per le scritture routine.

## Blocco noto

Il sidecar Telegram della build installata può sopravvivere al gateway e conservare
un token stale: card outbound sì, callback 401. Evidenza e design sono in
[DEVELOPMENT.md](DEVELOPMENT.md) e
[2026-06-22-telegram-bridge-rebind-design.md](superpowers/specs/2026-06-22-telegram-bridge-rebind-design.md).

## Prossima azione

Eseguire il piano test-first del rebind, poi rifare il gate in-app.
