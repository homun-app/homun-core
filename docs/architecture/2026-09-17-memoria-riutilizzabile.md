# Memoria iniziale riutilizzabile

> Specifica consolidata da analizzare: [pacchetto v0.1](../specifications/README.md). Chiarisce decisioni, proposte e scelta ancora aperta del backend memoria; prevale sulle ipotesi non confermate di questo documento.

17 settembre 2026. Fabio privilegia un prodotto funzionante con componenti esistenti e sostituzione progressiva con componenti Homun. Il recupero del vecchio sistema resta un'opportunità, non un prerequisito che blocca il primo rilascio.

## Raccomandazione

**Mem0 Open Source** per memoria semantica di lungo periodo, dietro un piccolo adattatore Homun. Usare la libreria Python locale, non obbligare all'API ospitata. Configurare esplicitamente modello di estrazione, embedding e archivio locali. La configurazione predefinita può usare provider remoti: installare la libreria non basta a ottenere località.

Per partire: Qdrant locale come archivio vettoriale candidato, Ollama per estrazione ed embedding locali. Verificare dimensioni degli embedding, qualità in italiano, packaging, accesso concorrente e cifratura prima di fissare le versioni. Non avviare un database a grafo nella prima versione.

## Confronto

| Componente | Vantaggio per noi | Scelta |
|---|---|---|
| Mem0 OSS | Livello memoria integrabile nel runtime scelto | Primo candidato da adottare |
| Letta | Agenti persistenti con gestione della memoria integrata | Alternativa di architettura, non libreria da aggiungere automaticamente a Pydantic/DBOS |
| Graphiti | Relazioni tra entità e fatti nel tempo | Successivo, se i casi reali richiedono grafo e storia temporale |

Licenze dei tre repository verificate: Apache-2.0. Non estendere questa conclusione ai servizi cloud, alle dipendenze o ai modelli. Conservare licenza/NOTICE e controllare la versione effettivamente distribuita.

Fonti: [Mem0 OSS](https://docs.mem0.ai/open-source/overview), [Mem0 Ollama](https://docs.mem0.ai/components/llms/models/ollama), [embedding](https://docs.mem0.ai/components/embedders/overview), [Letta](https://docs.letta.com/v1-sdk/concepts/stateful-agents), [Graphiti](https://github.com/getzep/graphiti). Licenze: [Mem0](https://github.com/mem0ai/mem0/blob/main/LICENSE), [Letta](https://github.com/letta-ai/letta/blob/main/LICENSE), [Graphiti](https://github.com/getzep/graphiti/blob/main/LICENSE).

## Tre responsabilità separate

- Cronologia chat e obiettivo corrente: database Homun; il piano non si ricostruisce con una ricerca probabilistica.
- Stato di esecuzione e attese: DBOS; nessuna memoria semantica può autorizzare o completare un passo.
- Fatti/preferenze/lezioni da recuperare in lavori successivi: Mem0 tramite adattatore e policy Homun.

Documenti originali e relative versioni restano nella raccolta materiali. Indicizzare un documento per ricerca non equivale a trasformare ogni frase in memoria dell'agente.

## Confine sostituibile

Definire MemoryPort con le operazioni canoniche della specifica: propose, approve, recall, revise, forget ed export (allineate a `docs/specifications/02-agenti-esecuzioni-memoria.md`). È un contratto Homun proposto, non un'API nativa dichiarata di Mem0. Parametri obbligatori: scope, attore autenticato, fonte/versione; risultato con ID Homun, testo, fonte e validità. La corrispondenza ID Homun/backend resta nell'adattatore. Nomi legacy remember/update corrispondono a propose/revise e non vanno usati nel codice nuovo.

Conservare un registro esportabile dei ricordi ammessi, delle fonti e delle revoche; Mem0 svolge estrazione/ricerca, non diventa l'unica copia delle decisioni aziendali. Sostituire il backend significa ricostruire l'indice dal registro, confrontare recuperi e commutare; niente riscrittura di UI e workflow.

Accessi verificati prima di inviare dati all'estrattore e prima della ricerca; usare partizioni/filtro compatibili con la versione OSS verificata. user_id o agent_id non sono autenticazione. Separare workspace/progetti anche quando lo stesso agente lavora per entrambi. Non mescolare ricordi di visibilità diversa in sintesi prive di provenienza.

Scrittura iniziale conservativa: lezioni aziendali riutilizzabili confermate dall'utente, inferenze trattate come proposte. Correzione/eliminazione deve aggiornare registro, indice e cache. Nessun aumento automatico dei permessi dell'agente.

## Primo test, prima della diffusione

1. Preferenza approvata ricordata in nuova chat dopo riavvio.
2. Informazione del progetto A assente nelle ricerche del progetto B.
3. Rettifica sostituisce il fatto precedente senza cancellarne la provenienza utile.
4. Eliminazione rimuove il ricordo da ricerca e cache.
5. Esportazione e reindicizzazione in un archivio vuoto conservano i fatti approvati.
6. Modello/embedding/telemetria e traffico verificati: modalità locale senza servizi esterni impliciti.
7. Database, indici, testo estratto, log e backup soddisfano la cifratura a riposo: località non implica cifratura.

Raccomandazione documentale, non benchmark già eseguito. Il vecchio Homun potrà implementare lo stesso MemoryPort quando il riuso sarà verificato; non si migra soltanto per avere un componente proprietario se la soluzione adottata continua a soddisfare i requisiti.
