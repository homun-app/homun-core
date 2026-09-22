# Gap analysis — template originale vs prodotto attuale (2026-09-22)

> Domanda: «cosa manca realmente rispetto al progetto finale?»
> Metodo: inventario componente-per-componente di `prototypes/reference` (il template)
> vs `apps/web`, verifica del collegamento al motore (Fonte) di ogni superficie,
> incrocio con i comandi effettivamente registrati nel motore (`domain/service.py`)
> e con la roadmap. Firma, cifratura e identità sono **rinviati per decisione
> del titolare** e non compaiono nel perimetro di questa analisi.

## Trovata principale

**Tutti i componenti del template esistono già nell'app attuale** (il reference
è allineato componente-per-componente). Il gap quindi non è «manca il codice»,
è di tre nature diverse:

1. **superfici vissute solo dalla simulazione** (o del tutto irraggiungibili),
2. **comandi del motore già pronti ma senza UI** che li esponga,
3. **funzionalità che non esistono da nessuna parte** (da progettare).

## 1. Superfici del template non collegate al motore (o irraggiungibili)

| Superficie (template) | Stato attuale | Supporto motore | Gap |
|---|---|---|---|
| **Squadra + Team** (StudioSquad, StudioTeamMembers: composizione team, coordinatore) | In modalità motore si vede solo `EngineWorkspaceAgents`: schede in sola lettura. Le UI di composizione team esistono nel codice ma non sono montate sul percorso motore | `team.create/update/archive` ✓ **già pronti e testati** | UI team + modifica agenti (categoria 2 sotto) |
| **Persone e accessi** (StudioAccess: persone, inviti, ruoli) | Non raggiungibile dal nav; in impostazioni esiste solo «Invita una persona… simulato» | `grant.issue/revoke` ✓ con UI impostazioni; identità esterne = rinviate | Sezione persone «lite» (gestione attori locali) |
| **Automazioni** (StudioProcedures, StudioAutomation*, routine ricorrenti) | Spazio «Automazioni» in nav ma **solo simulazione**: nessuna persistenza motore | **Nessuno** (voce roadmap «loop multi-tool» aperta) | Motore delle ricorrenze + UI |
| **Plugin / MCP** (StudioMarketplace, ConversationPlugins) | Catalogo plugin solo demo | **Nessuno**: il motore non ha concetto di plugin/MCP/skill | Design + motore (i «plugin» oggi sono le capability del registro) |
| **Documenti** (StudioDocuments: raccolta, ricerca, condivisione; StudioArtifactPreview) | Non raggiungibile | Artefatti per lavoro ✓; nessuna libreria trasversale | Libreria risultati/artefatti del motore |
| **Oggi / Agenda** (StudioToday, StudioSchedule: bacheca, avanzamento, scadenze) | Non raggiungibile; «Compiti» (elenco/kanban/calendario) esiste ed è collegato ai lavori motore | Lavori/fasi ✓ (scadenze: campo `due` solo simulazione) | Vista «Oggi» motore + scadenze vere |
| **Formazione/autonomia** (StudioTraining), **mappa strumenti** (FlowMap), **hub Studio** (StudioWorkbench) | Codice presente, irraggiungibile dal percorso attuale | Parziale (autonomia esiste come campo lavoro) | Da riposizionare o ritirare |
| **Percorsi prototipo** (FirstWorkJourney, ChatWorkJourney) | Sotto `/prototypes` | — | Volontariamente fuori prodotto |

## 2. Comandi motore pronti ma senza UI (recupero a basso rischio)

| Comando | Stato motore | UI attuale |
|---|---|---|
| `agent.update` / `agent.rename` | ✓ (istruzioni, connessione preferita, stato; revisione) | Nessuna modifica agente dall'app (solo creazione da intake) |
| `team.create/update/archive` | ✓ (membri, coordinatore) | Nessuna |
| `plan.revise` | ✓ (inserisci/togli passi, mai riscrivi i completati) | Nessuna (già segnalato nel piano multi-fase) |
| `work.set_budget` | ✓ (budget per lavoro, riserve atomiche) | Le preferenze in Impostazioni NON lo usano: sono solo indicative |
| `grant.issue/revoke` | ✓ | UI impostazioni presente ✓ (progetti) |

## 3. Funzionalità da progettare (non esistono da nessuna parte)

1. **Suggerimento modelli per attività** (richiesta del titolare): il registro
   modelli conosce provider/modello/verifica, ma non esiste mappa
   attività→modello. Servono: metadati di suggerimento (per capability/fase:
   confronto, lettura, sintesi; per dimensione lavoro), una sezione
   «Modelli consigliati» in Impostazioni e la scelta per-lavoro al momento
   dell'affidamento, sempre revocabile.
   **Avanzamento 22/9**: `GET /v1/models/recommendations` (motore) +
   sezione «Consigliati per attività» in Impostazioni → Modelli: euristiche
   deterministiche sul catalogo Ollama reale (taglia e dove gira), ordinate
   per attività (interpretazione → piccoli e veloci; sintesi → grandi),
   con motivo visibile, «Attivo ora» e azione «Usa per lo spazio». Ogni
   suggerimento dichiara cosa è: catalogo, non benchmark.
   **Legame agente↔modello (verificato il 22/9)**: `AgentProfile.preferred_connection_id`
   esiste ed è validato da `agent.update`; `registry.complete` accetta
   `connection_id`; ma interpret/intake **non lo usano mai** (chiamano il
   provider attivo del workspace) e dall'app non si può impostare. Il legame
   è quindi: dati ✓, esecuzione ✗, UI ✗, suggerimento ✗. Ogni agente con il
   suo modello diventa il perno della sezione Modelli nella scheda agente.
2. **Ristrutturazione Impostazioni**: sezioni mancanti rispetto al prodotto
   finale — Persone (lite), Plugin/MCP (anche solo onesta «non ancora»),
   Automazioni, Squadra/team; la sezione Modelli va divisa in
   « Collegamento » (provider attivo, verifica) e « Preferenze » (routing,
   budget) che oggi convivono confusamente.
3. **MCP/skill a motore**: oggi l'unica estensione è il registro capability;
   MCP richiede design (connessioni, permessi per agente, sandbox).
4. **Automazioni a motore**: routine ricorrenti = piano + trigger temporale;
   il motore ha i piani versionati ma nessuno scheduler (il follow-up
   «retry_scheduled» non è un scheduler).
5. **Liberia documenti** motore (raccolta artefatti con ricerca/filtri).
6. **Vista Oggi motore** con scadenze vere sul lavoro/fase.

## Avanzamento punti 4 e 5 (22/9, fatto)

- **4 — `work.set_budget` esposto**: il pannello del lavoro ha «Budget del lavoro»
  con contatori onesti («tentativi usati X di Y; il limite si alza solo da qui»)
  e aggiornamento esplicito del limite. La lista lavori espone il budget.
  Verificato dal vivo (limite 40→12, persistito a revisione 8).
- **5 — `plan.revise` da UI**: nella scala fasi, «+ Aggiungi una fase» (titolo,
  assegnatario reale della squadra, tipo) e «Rimuovi l'ultima fase in attesa»
  con conferma; le fasi completate restano storia. Verificato dal vivo
  (aggiunta «Rileggere la sintesi con Aurora» → revisione 3 → rimozione).
  Nascosti sui lavori completati o senza piano.

## Avanzamento punto 7a (22/9, fatto) — Documenti

- Motore: `GET /v1/workspaces/{id}/artifacts` — la libreria actor-scoped di
  tutti i risultati verificati (con titolo del lavoro e progetto), test di
  route incluso.
- Web: nuovo spazio **Documenti** nella sidebar (contatore = risultati
  verificati): ricerca per titolo/lavoro/contenuto, filtro per progetto,
  apertura con contenuto e **Scarica** in Markdown. Verificato dal vivo
  (ricerca «sintesi», apertura e download del documento listini).

## Avanzamento punto 7b (22/9, fatto) — Scadenze e Oggi

- Motore: `Work.due_date` (data ISO o null) + comando `work.set_due`
  validato; la lista lavori la espone (test di route: set, formato rifiutato,
  cancellazione).
- Web: sezione **Scadenza** nel pannello del lavoro (input data, salvataggio
  esplicito, avviso «Scaduto il …» per lavori attivi oltre termine); la vista
  **Compiti** somma la giornata: «N attendono te · M risultati da verificare ·
  X scaduti · Y in scadenza oggi», e le righe/kanban/calendario usano la
  scadenza reale del motore. Verificato dal vivo (scadenza 30/09 sul rinnovo,
  scadenza di oggi sull'altro lavoro con conteggio «1 in scadenza oggi»).

## Cosa NON manca (verificato, per non inseguire fantasmi)

- Componentistica del template: tutta presente (`comm` componente-per-componente = 0 file solo-template).
- Impostazioni: l'app attuale ha MENO sezioni del template in apparenza, ma le
  sezioni Agenti/Progetti/Memoria sono aggiunte recenti collegate al motore;
  il template è più povero, non più ricco.
- Squadra/Progetti/Compiti/Materiali: spazi già raggiungibili; Squadra e
  Progetti hanno percorso motore (sola lettura); Compiti elenca lavori motore.
- Confronto CSV, lettura materiale, piani multi-fase, chiusura con esito:
  verificati end-to-end il 22 settembre (§9–11 della proposta di design).

## Proposta di ordine (valore/rischio)

1. **Gestione agenti e team su motore** — comandi già pronti e testati: è UI
   pura (modifica profilo, autonomia, connessione preferita; team con
   coordinatore). Riempie il buco più visibile del prodotto.
   **Avanzamento 22/9 (punto 1a fatto)**: la scheda agente in Squadra è ora
   modificabile (ruolo, istruzioni, identità professionale, autonomia,
   capacità) con il **selettore «Modello per questo collaboratore»** sulle
   connessioni reali del motore (`preferred_connection_id`, persistito e
   revisionato). Verificato dal vivo su Aurora.
   **Punto 1b fatto (22/9)**: nello spazio Squadra ora si creano, modificano
   (membri e coordinatore, regola onesta «coordinatore fra i membri») e
   archiviano team sui comandi versionati esistenti. Verificato dal vivo
   (team «Analisi listini», coordinatore Aurora→Bruno, archiviazione a
   revisione 3). **Il punto 1 della proposta è completato.**
   Nota di onestà: il collegamento per agente è **dormiente nell'esecuzione**
   perché oggi tutto il lavoro col modello è del coordinatore (interpret,
   intake); le fasi eseguibili sono deterministiche. Diventa operativo con la
   fetta «sintesi a motore» (il modello dell'agente fa la sua fase di sintesi).
2. **Ristrutturazione Impostazioni** con le sezioni mancanti (anche oneste
   «non ancora disponibili») e la scissione Collegamento/Preferenze modelli.
3. **Suggerimento modelli per attività** — dipende da (2) per la casa giusta;
   parte engine: metadati di raccomandazione + default per capability.
4. **`work.set_budget` esposto** (piccolo, chiude il cerchio del budget).
5. **`plan.revise` da UI** (già in coda dal piano multi-fase).
6. **Automazioni a motore** (design prima: trigger, ricorrenza, supervisione).
7. **Liberia documenti** e **vista Oggi** (su artefatti e scadenze esistenti).
8. MCP/skill: design a parte, dopo le automazioni (stessa famiglia di problemi).
