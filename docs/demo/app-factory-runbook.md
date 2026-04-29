# App Factory Demo Runbook

Questo runbook serve per presentare App Factory in 5-7 minuti con un percorso live e un fallback controllato. La demo mostra Homun come sistema capace di trasformare una richiesta aziendale in una piccola applicazione interna isolata, accessibile via link e governabile anche dall'agente.

## Obiettivo

Creare e usare un'app interna per la gestione di ferie e permessi dei dipendenti:

- richiesta tramite prompt naturale;
- generazione di un blueprint App Factory;
- creazione dell'app con database per-app isolato;
- apertura dell'interfaccia interna;
- inserimento di una richiesta;
- approvazione tramite workflow;
- interrogazione dei dati dalla chat.

## Prerequisiti

- Eseguire una build recente del binario.
- Avviare il gateway.
- Entrare nella Web UI con un utente abilitato.
- Verificare che la skill `app-factory` sia caricata.
- Verificare che gli agent tools `create_internal_app`, `list_internal_apps`, `create_app_record`, `query_app_records` e `run_app_action` siano disponibili dopo il riavvio.
- Aprire in anticipo `/apps` e tenere pronta una tab con la chat.

## Prompt Live

Usare questo prompt nella chat:

```text
Crea un'app interna per gestire ferie e permessi dei dipendenti.
Serve registrare dipendenti, richieste ferie/permesso/malattia, date, note e stato approvativo.
Il responsabile deve poter approvare o rifiutare le richieste.
Genera l'app usando i componenti App Factory predefiniti.
```

Risultato atteso:

- l'agente riconosce il bisogno come App Factory;
- produce o usa un blueprint compatibile;
- chiama `create_internal_app`;
- restituisce un link interno simile a `/apps/ferie-permessi`.

## Fallback Blueprint

Se la generazione live non produce un blueprint valido o richiede troppo tempo, usare il blueprint pre-seed:

```text
Usa questo blueprint per creare l'app interna ferie-permessi con create_internal_app.

<incolla il contenuto di docs/demo/blueprints/ferie-permessi.json>
```

Il file di fallback e' [docs/demo/blueprints/ferie-permessi.json](blueprints/ferie-permessi.json).

## Script Demo

0:00 - Inquadrare il problema.

> "Molte aziende hanno bisogni interni piccoli ma urgenti: ferie, onboarding, ticket, inventari. App Factory permette di crearli con prompt, componenti predefiniti e isolamento dati."

1:00 - Mostrare il prompt live.

Aprire la chat, inviare il prompt e spiegare che Homun non genera codice arbitrario: compone un blueprint dichiarativo supportato dal runtime.

2:00 - Creare l'app.

Mostrare la risposta dell'agente e il link `/apps/ferie-permessi`.

3:00 - Aprire l'interfaccia.

Aprire `/apps`, entrare in "Ferie e Permessi", mostrare tabella, form e azioni. Sottolineare che l'app usa uno storage isolato per-app.

4:00 - Inserire una richiesta.

Creare una richiesta con questi dati:

- Dipendente: `Mario Rossi`
- Tipo: `ferie`
- Dal: `2026-05-10`
- Al: `2026-05-12`
- Note: `Vacanza famiglia`
- Stato: lasciare `pending`, se presente

5:00 - Approvare.

Selezionare la richiesta e usare l'azione `Approva`. Verificare che lo stato diventi `approved`.

6:00 - Interrogare dalla chat.

Usare:

```text
Quante richieste ferie approvate risultano per Mario Rossi?
```

Risultato atteso: l'agente usa gli strumenti App Factory per leggere i record dell'app e risponde sui dati appena creati.

## Schermate Attese

- `/apps`: elenco app interne con la card "Ferie e Permessi".
- `/apps/ferie-permessi`: runtime app con form e tabella.
- Dettaglio richiesta: record selezionato con stato e azioni `Approva` / `Rifiuta`.
- Chat: risposta dell'agente basata su `query_app_records`.

## Fallback Operativi

| Problema | Azione |
| --- | --- |
| La skill non viene caricata | Riavviare il gateway e controllare il log delle skill. |
| I tool App Factory non sono visibili | Riavviare il gateway e verificare la registrazione degli agent tools. |
| Il blueprint live non e' valido | Usare il blueprint pre-seed in `docs/demo/blueprints/ferie-permessi.json`. |
| L'app esiste gia' | Continuare con `/apps/ferie-permessi` oppure generare uno slug alternativo. |
| La UI non crea il record | Creare il record dalla chat con `create_app_record` tramite l'agente. |
| L'azione non aggiorna lo stato | Mostrare il record e proseguire spiegando il workflow dichiarativo previsto dal blueprint. |
| Email o WhatsApp non sono pronti | Presentare tutto dalla Web UI; i gateway esterni non sono necessari per questa demo. |

## Success Criteria

- L'app viene creata o recuperata.
- L'app e' raggiungibile da `/apps/ferie-permessi`.
- Un record di richiesta ferie viene salvato.
- Una transizione di workflow aggiorna lo stato a `approved`.
- La chat riesce a interrogare i dati dell'app.
- La demo resta comprensibile anche usando il blueprint fallback.
