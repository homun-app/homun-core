# Primo nucleo Homun derivato dalla logica Hermes

23 settembre 2026, successivo a `d264a5f6`. Implementazione nel motore Homun;
nessuna dipendenza runtime da Hermes o OpenHands. Non attesta parità completa.

## Comportamento consegnato

Le nuove proposte `agent_run` con connessione OpenAI-compatible fissano il
protocollo `native-tools-v1` e il prompt iniziale nel contenuto approvato.
La cronologia conserva messaggi system/user/assistant/tool e identificativi
per associare ogni chiamata al suo risultato. Il provider riceve veri strumenti,
con proiezioni separate per OpenAI-compatible e Ollama nativo.

Una risposta può richiedere più strumenti. Il motore salva l'intera risposta
prima dell'esecuzione, avanza di una chiamata per volta e consulta nuovamente
il modello soltanto dopo i risultati. Una domanda usa `request_user_input` e
il sistema esistente di contributi umani; la risposta completa quella chiamata.
Le altre letture pendenti restano da eseguire anche dopo la riapertura del contesto.

Autorizzazioni, versioni delle fonti, lease, budget e revisione degli artifact
rimangono nel percorso applicativo esistente. Una pausa invalida una risposta
in volo. Errori negli strumenti sono osservazioni; output del provider tronco,
solo ragionamento o con struttura invalida non può diventare un artifact finale.

I run precedenti e gli adattatori non nativi mantengono il protocollo JSON
precedente. La versione pubblica degli strumenti distingue `adaptive-materials-v1`
da `adaptive-materials-native-v2`. Non esiste downgrade automatico dopo un errore.
Un endpoint o modello OpenAI-compatible deve supportare tool calling per i nuovi run.

## Provenienza e adattamenti

Riferimento: NousResearch/hermes-agent commit
`c9dca726514b709cf6e677d236a79fc8d0627f37`.

| Riferimento Hermes | Homun | Tipo di riuso |
| --- | --- | --- |
| `agent/conversation_loop.py`, `agent/turn_tool_round.py` | `application/agent_native.py`, `agent_run_execution.py` | Reimplementazione del ciclo e della persistenza prima degli strumenti |
| `agent/turn_request_assembly.py` | `models/native_turn.py`, `native_transport.py` | Separazione fra storia canonica e payload del provider |
| `agent/prompt_builder.py` | `models/native_prompt.py` | Estratti adattati delle istruzioni su prerequisiti, fatti verificati, identificativi, informazioni mancanti e consegna |

Prompt adattato al catalogo realmente disponibile in Homun, senza istruzioni su
strumenti non presenti. Il prompt è fissato per run; non è una copia completa del
sistema di prompt dinamici, memoria e skill Hermes. La licenza MIT completa e
la mappa di provenienza sono in `engine/src/homun/notices/hermes-agent.txt`,
inclusa nella wheel verificata. Nessuna modifica alla licenza del resto del prodotto.

## Verifiche

- Suite motore completa finale: **625 passati, 1 saltato** (103,22 secondi).
- Suite nativa finale: **17 passati**, con recupero dopo interruzione fra
  persistenza ed esecuzione, invalidazione della risposta in volo dopo pausa
  e tre regressioni sugli output malformati emerse nella revisione indipendente.
- Regressione specifica: prima lettura, domanda umana, risposta, nuovo contesto,
  seconda lettura di un altro materiale, finale. Una sola richiesta al modello
  per l'intero gruppo di strumenti; entrambi i risultati presenti alla successiva.
- Trasporto: payload OpenAI-compatible e Ollama, identificativi, argomenti,
  consumi; errori e assenza di fallback. Provider remoto verificato con mock HTTP,
  non con chiamate cloud.
- Prova reale [script](evidence/2026-09-23-owned-core/live_ollama.py) e
  [traccia](evidence/2026-09-23-owned-core/live_ollama.json): Ollama locale,
  `qwen3.5:4b`, nessun mock del modello. Documento sintetico letto, contesto del
  motore chiuso/riaperto, destinatario Marta, scadenza 30 settembre 2026 e codice
  HX-73Q9 esatti; un artifact in revisione. Due chiamate: 907+1122 token input,
  39+36 output. Riavvio del contesto applicativo nello stesso processo, non
  riavvio del sistema operativo o prova di crash fisico.
- OpenAPI invariato; controllo architetturale con Python 3.13: **0 errori,
  35 avvisi dimensionali preesistenti**. Il Python di sistema più vecchio non
  analizza una f-string già presente; usare l'interprete del motore.
- Wheel costruita con `uv build --wheel`, presenza del copyright e della
  licenza verificata nell'archivio. App desktop non ricostruita o installata.

## Limiti e prossima tranche

Non sono implementati compattazione, memoria/skill Hermes, streaming nativo dei
round, shell/browser/rete liberi, retry sofisticati o cambio provider. Il catalogo
resta quello dei materiali e della squadra già autorizzati, con gli stessi limiti
numerici. Le letture possono essere rieseguite dopo un crash prima del salvataggio
del risultato; non è un contratto exactly-once per effetti esterni.

La ripresa verificata riguarda contributi richiesti dal motore e recupero del
round. Una correzione arbitraria dell'utente durante l'esecuzione, cancellazione
selettiva delle chiamate e ripianificazione sono ancora da realizzare. Un input
che revoca l'autorizzazione passa dai controlli di dominio, non dal solo prompt.

Prossimo passo: steering/interruzione espliciti e gestione del contesto lungo,
con confronti circoscritti rispetto allo stesso commit Hermes. Poi estendere
strumenti generali e misurare l'esperienza d'uso diretto e della squadra aziendale.
