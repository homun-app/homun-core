# Homun roadmap operativa

## Obiettivo attivo

WS6.3 Scheduler / ricorrenza + proactive review: rendere affidabile il ciclo
ricorrente end-to-end, dal runtime task fino alla consegna delle schede/proposte
proattive.

## Fase corrente

WS6.2 Resource Governor è chiusa localmente: i task in `WaitingResource` vengono
reidratati quando torna capacità, la task queue espone pressione risorse, e il
gate cross-connection con due worker/store separati è verde.

WS6.3 è partita dal contratto più stretto: il gateway materializzava già la
prossima occorrenza dopo un task ricorrente completato, mentre il `TaskRuntime`
standalone no. Slice WS6.3a completata: runtime allineato al gateway con test
red/green.

Piano attivo:
[2026-06-22-scheduler-recurrence-ws6-3.md](superpowers/plans/2026-06-22-scheduler-recurrence-ws6-3.md).

## Milestone

1. WS6.3a — `TaskRuntime` materializza la prossima occorrenza dopo completion.
2. WS6.3b — verificare comportamento terminal failure/retry su ricorrenze tra
   runtime e gateway.
3. WS6.3c — gate in-app di una automazione ricorrente/proactive prompt visibile
   nel thread `scheduled`.
4. WS6.3d — proactive review: schede governate, dedup e superficie UI verificati.

## Blocco noto

Nessun blocco tecnico attivo. Il prossimo rischio è divergenza tra runtime
standalone e worker gateway sui casi non-happy-path delle ricorrenze.

## Prossima azione

Committare WS6.3a senza co-author, poi proseguire con WS6.3b: failure/retry
recurrence parity tra runtime standalone e gateway.
