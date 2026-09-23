# Requisiti e implementazione — 23 settembre 2026

Mappa del sorgente con la tranche operativa del 23 settembre. Integra la specifica v1 senza riscriverne i
requisiti né approvare proposte rimaste aperte. “Presente” indica codice e prove
nel perimetro dei rapporti, non certificazione dell'intera visione.

| Area delle specifiche | Presente | Parziale o da verificare |
| --- | --- | --- |
| 01 — Prodotto e dati | Domanda/lavoro, accordo, piani, progetti, file, risultati revisionabili | Qualità semantica, accessibilità e comprensibilità su utenti del target |
| 02 — Agenti ed esecuzioni | Uso diretto, onboarding aziendale, profili/team, consultazioni AI, ciclo adattivo su materiali, sintesi, budget e procedure | Autonomia per competenza, apprendimento valutato, equivalenza di garanzie sui tool MCP |
| 03 — Impostazioni e permessi | Connessioni, impostazioni, grant progetto, cataloghi reali e gestione routine | Portale di contributo con identità dichiarata presente; account verificati, identità multiutente esterne, politica completa di retention e recupero chiavi |
| 04 — API e rete | Motore locale/API, sessione del launcher, contratto OpenAPI generato, Electron | Pairing, tunnel, trasferimenti e collaborazione fra installazioni; client Flutter |
| 05 — Accettazione | Suite e casi sintetici, prove GUI circoscritte, inventario packaging | Pilot 2–5 persone, benchmark UX, Mac pulito, upgrade/rollback completo |

## Decisioni che non vanno riaperte per errore

React + Electron + Python e runtime Pydantic AI + DBOS sono adottati.
Il confronto CSV è un caso di accettazione, non l'intero perimetro del prodotto.
La chat resta l'ingresso principale; le altre viste rappresentano lo stesso
stato. La nuova analisi riguarda semplificazione dell'uso, non sostituzione
automatica del runtime o autorizzazione di effetti più ampi.

## Decisioni che restano aperte

D-AUTH/NET/OWN/OFF: collaborazione distribuita e disponibilità.
D-CRYPTO/KEY: protezione di tutto il profilo e recupero; opt-in SQLCipher del
workspace non basta. D-MODEL: qualità sul pilot. D-TOOLS: integrazioni reali e
ricevute. D-RET/LIC/SIZE: policy e misure. D-DESK: packaging implementato,
accettazione della distribuzione da provare sulla build candidata.
La memoria SQLite e l'adattatore Mem0 esistono, ma non chiudono da soli la
valutazione qualitativa D-MEM.

Riferimenti: [STATO](../STATO.md), [verifica consolidamento](../research/2026-09-23-consolidamento-verifica.md),
[guida d'uso](../USO-HOMUN.md), [registro decisioni originale](05-accettazione-e-decisioni.md).
