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
2. **Ristrutturazione Impostazioni** con le sezioni mancanti (anche oneste
   «non ancora disponibili») e la scissione Collegamento/Preferenze modelli.
3. **Suggerimento modelli per attività** — dipende da (2) per la casa giusta;
   parte engine: metadati di raccomandazione + default per capability.
4. **`work.set_budget` esposto** (piccolo, chiude il cerchio del budget).
5. **`plan.revise` da UI** (già in coda dal piano multi-fase).
6. **Automazioni a motore** (design prima: trigger, ricorrenza, supervisione).
7. **Liberia documenti** e **vista Oggi** (su artefatti e scadenze esistenti).
8. MCP/skill: design a parte, dopo le automazioni (stessa famiglia di problemi).
