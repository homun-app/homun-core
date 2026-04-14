# Architecture Decision Records (ADR)

> **Cosa c'è qui**: documenti che catturano decisioni architetturali storiche, blueprint, e contesti di sessione di redesign. **Non sono lo stato attuale del codice**.
>
> **Quando consultarli**: per capire **perché** qualcosa è stato (o non è stato) fatto in un certo modo. Per capire **come** è fatto oggi, vedi [`../features/`](../features/) e [`../services/`](../services/).
>
> **Quando NON aggiornare**: questi doc sono storici. Se vuoi proporre un nuovo redesign, crea un nuovo file qui dentro con data, non modificare i vecchi.

---

## Indice

| File | Data | Cosa contiene | Stato |
|---|---|---|---|
| [`AGENT-REDESIGN-CONTEXT.md`](./AGENT-REDESIGN-CONTEXT.md) | 2026-04-02 | Context dump della session di debugging/optimization che ha rivelato i limiti del ReAct loop puro. Lista cose che funzionavano vs cose che non funzionavano, con log evidence | Storico |
| [`AGENT-ARCHITECTURE-V2.md`](./AGENT-ARCHITECTURE-V2.md) | 2026-04-02 | Blueprint completo (~137 KB, 17 sezioni) per un redesign architetturale "system-controlled tool dispatch". **NON implementato**: il sistema attuale ha cognition diversa | Blueprint storico, non implementato |

---

## Perché questi doc sono qui e non in `docs/` principale?

I doc in `docs/` principale (REALITY-AUDIT, PRODUCTION-ROADMAP, UNIFIED-ROADMAP, features/, services/) descrivono **cosa è** e **cosa fare**. Gli ADR descrivono **cosa è stato pensato a un certo momento storico**.

Tenere ADR in una cartella separata previene confusione: una nuova sessione Claude che legge `docs/` principale non rischia di credere che AGENT-ARCHITECTURE-V2 descriva il sistema attuale.

---

## Come si crea un nuovo ADR?

Quando devi proporre una decisione architetturale che impatta più componenti:

1. Crea un file `YYYY-MM-DD-titolo-decisione.md` qui in `adr/`
2. Usa la struttura:
   ```
   # ADR: Titolo della decisione

   Date: 2026-XX-XX
   Status: Proposed | Accepted | Rejected | Superseded
   Context: cosa stava succedendo che ha forzato la decisione
   Decision: cosa si è deciso
   Consequences: cosa cambia, trade-off
   Alternatives considered: cosa NON si è scelto e perché
   ```
3. Aggiorna l'indice in questo file
4. Se la decisione viene poi superata, marca status `Superseded` e linka il successore — **non eliminare il vecchio**
