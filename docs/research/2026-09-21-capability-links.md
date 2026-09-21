# Collegamento specializzazioni ↔ registro capacità — consegna e verifica

**Data:** 21 settembre 2026, dopo l'[identità professionale](2026-09-21-identita-collaboratori.md). Chiude il cerchio: le dichiarazioni del collaboratore ora fanno riferimento strutturale alle capacità reali del motore.
**Branch:** `fabio/production-foundations`. Commit precedenti: `bca9ce7`, `9c2a2eb`, `51c20f3`, `26e1e82`, `303ebb4`, `5c0c065`.

## Cosa è stato costruito

1. **`AgentProfile.capabilities`**: lista di id validati contro il registro (`compare_csv`, `read_material`, `general`); id sconosciuti rifiutati alla creazione e all'aggiornamento; dichiarare una capacità **non concede permessi** (i grant per progetto decidono l'accesso, come sempre).

2. **Roster arricchito per il modello**: l'intake include il campo `capabilities` di ogni agente nel catalogo passato al modello — la raccomandazione è basata su ciò che il motore sa eseguire realmente, non solo sul testo del ruolo.

3. **Correzione engine-side della raccomandazione**: se il modello suggerisce un agente **senza** il collegamento alla capacità richiesta mentre esiste un candidato **con** il collegamento, il motore corregge la scelta a favore del candidato collegato. Il modello propone; il backend valida — anche per la raccomandazione, non solo per l'esecuzione.

4. **`NewAgent` esteso**: il brief include `capabilities`; l'agente creato dalla conferma porta i collegamenti nel profilo persistito.

5. **Vista Squadra**: sezione «**Può eseguire**» con chip per capacità (etichette italiane dal registro, stile verde distinto dalle specializzazioni dichiarative). Il campo `tools` del prototipo è ora reale.

## Prove eseguite

**Deterministici motore** (437 passati, 1 saltato; 5 nuovi in `test_capability_links.py`): capabilities validate contro il registro (id sconosciuto rifiutato); aggiornamento selettivo; **correzione engine-side**: il modello raccomanda l'agente senza collegamento, il motore sceglie quello collegato; l'agente creato dall'intake porta `capabilities`; il roster inviato al modello include i collegamenti.

**Frontend** (166 passati): typecheck, build, architettura 0 errori/29 avvisi, `git diff --check` pulito, OpenAPI rigenerata.

**Modello reale (GLM 5.3 Flash):**
- Prima richiesta CSV → nuovo profilo **Bruno** con `capabilities: ['compare_csv']` → confermato e persistito con il collegamento.
- Seconda richiesta CSV con **due agenti** (Bruno collegato + Marco generico senza collegamento) → il modello raccomanda **Bruno** (quello con il collegamento — corretto).

**Pacchetto:** bundle ricostruito, **8/8 test desktop**.

## Build di riferimento

- App: `dist/desktop/2026-09-21T08-56-33-226Z/Homun-darwin-arm64/Homun.app`
- ZIP: `dist/desktop/2026-09-21T08-56-33-226Z/Homun-0.1.0-macos-arm64.zip`
- SHA-256: `4e8f2d9eed96b033abf1fafc09ca938cf5156206013ac54c381341cf5e8bc2a7`

## Limiti rimasti

- La correzione engine-side della raccomandazione **sostituisce** silenziosamente il suggerimento del modello quando esiste un candidato collegato: è la scelta giusta per la policy, ma la motivazione (rationale) resta quella del modello e può riferirsi all'agente scartato. Da raffinare: rigenerare la rationale o annotare la correzione.
- Le capabilities dichiarate non verificano l'**autorizzazione effettiva** su un progetto specifico (servono i grant): la Squadra dice «può eseguire confronti CSV», non «è autorizzato su questo progetto». Il passo successivo è interrogare grant + capabilities insieme.
- Nessuna validazione che impedisca di assegnare un lavoro `compare_csv` a un agente senza il collegamento (la policy attuale richiede solo un collaboratore, non che sia collegato).

## Riproduzione

Motore temporaneo con `glm-5.3-flash:cloud`: prima richiesta CSV → nuovo agente con `capabilities` nel payload JSON → conferma → `GET /agents` mostra il collegamento. Creare un secondo agente generico senza collegamenti → seconda richiesta CSV → il suggerito è quello collegato.
