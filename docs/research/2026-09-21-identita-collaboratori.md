# Identità professionale dei collaboratori — consegna e verifica

**Data:** 21 settembre 2026, dopo il fix dei nomi italiani (`9c2a2eb`). Risponde alla lacuna strutturale identificata confrontando il prototipo (modello `StudioMember` ricco) con l'`AgentProfile` del motore (nome + testo libero).
**Branch:** `fabio/production-foundations`. Commit precedenti: `5c0c065` → `303ebb4` → `26e1e82` → `51c20f3` → `9c2a2eb`.

## Cosa è stato costruito

1. **`AgentProfile` esteso nel dominio** (retrocompatibile, campi opzionali con default sicuri): `responsibility` (di cosa è responsabile, ≤500), `specializations` (2–12 voci brevi), `method` (come lavora, ≤500), `tone` (stile di comunicazione, ≤120), `autonomy_mode` (`supervised` | `autonomous`, validato). I campi sono versionati con il profilo e revisionabili con `agent.update`; le istruzioni libere restano il manuale operativo e non concedono permessi.

2. **`agent.create` e `agent.update` accettano i nuovi campi**: creazione con identità completa, aggiornamento selettivo (solo i campi presenti nel payload cambiano), validazione di autonomia e specializzazioni (tipo, lunghezza, deduplica).

3. **L'intake propone profili completi**: `NewAgent` nel brief ha gli stessi campi; il prompt (it+en) istruisce il modello a compilare responsibility, specializations (riferite alle capacità reali quando possibile), method e tone — descrivendo il collaboratore, mai gli strumenti autorizzati. La conferma passa l'identità del brief in `agent.create`.

4. **Vista Squadra riscritta** (`EngineWorkspaceAgents`): schede con avatar, nome, ruolo, tono in corsivo, responsabilità etichettata, specializzazioni come chip, badge di autonomia («Sotto supervisione» / «Consegna autonoma»), metodo e istruzioni nei dettagli espandibili. Nessun dato grezzo nel flusso principale.

5. **Riepilogo destro onesto**: «Responsabile» mostra sempre un nome — l'agente confermato oppure **«Homun»** con la nota «coordina finché non confermi un collaboratore» (via da «Da confermare»); quando l'obiettivo non c'è ancora, una riga spiega che arriva dalla proposta in chat (via al placeholder nudo «Obiettivo da concordare»).

## Prove eseguite

**Deterministici motore** (432 passati, 1 saltato; 5 nuovi in `test_agent_identity.py`): creazione con identità completa; default sicuri e vuoti; aggiornamento selettivo che tocca solo i campi presenti; autonomia/specializzazioni invalide rifiutate; **l'agente creato dall'intake confermato porta l'identità del brief** (responsibility, specializations, tone — test end-to-end con fake).

**Frontend** (166 passati): nessuna regressione; typecheck, build, architettura 0 errori/29 avvisi, `git diff --check` pulito, OpenAPI rigenerata e verificata.

**Modello reale (GLM 5.3 Flash):** richiesta CSV → proposta `new_agent` **Chiara** con nome proprio italiano, responsibility («È responsabile del confronto accurato dei listini e della qualità dei report»), 4 specializzazioni puntuali («Confronto di listini prezzi per SKU», «Rilevazione di variazioni, aggiunte e rimozioni»…), method («Lavora in modo deterministico, riga per riga…»), tone («Chiaro e sintetico»). Conferma → agente persistito con tutti i campi, autonomia `supervised`.

**Pacchetto:** bundle ricostruito, **8/8 test desktop**.

## Build di riferimento

- App: `dist/desktop/2026-09-21T08-01-10-928Z/Homun-darwin-arm64/Homun.app`
- ZIP: `dist/desktop/2026-09-21T08-01-10-928Z/Homun-0.1.0-macos-arm64.zip`
- SHA-256: `3112b88f6da4af7a805883bb00b5836d9b0e0ccaf581db0cd2fab6fa3092e82b`
- Non firmata e non notarizzata. Le build precedenti restano come prove storiche.

## Limiti rimasti

- Le specializzazioni sono testo libero: il collegamento strutturale al registro capacità (per interrogare «chi può eseguire compare_csv su questo progetto?») è il passo successivo naturale — i dati ci sono già da entrambe le parti.
- `autonomy_mode` è dichiarativo sul profilo: l'autonomia operativa effettiva per contesto (quale lavoro, quale progetto, con quali limiti) è la delega già costruita (D4) ma non ancora collegata a questo campo.
- Nessuna UI per modificare l'identità (solo via comando/API); la Squadra è in sola lettura.
- La vista Squadra del prototipo aveva anche drag-and-drop per comporre team e designazione del coordinatore: il dominio ha già `Team` con `coordinator`, ma la UI non lo espone ancora.

## Riproduzione della prova

Motore temporaneo con `glm-5.3-flash:cloud`: richiesta «Vorrei confrontare il listino di marzo con quello di aprile…» → proposta con nuovo profilo completo → verifica dei campi identity nella risposta JSON → conferma → `GET /agents` mostra l'agente persistito con tutti i campi. Il profilo reale non è stato toccato.
