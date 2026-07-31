# Product Loop

Questo documento ha priorita' pratica su piani, roadmap e moduli interni quando
si lavora sulla UX. Il prodotto deve essere giudicato dal loop che vede
l'utente, non dalla quantita' di infrastruttura disponibile.

## Principio

Il loop base deve funzionare sempre:

```text
utente scrive -> l'assistente (modello attivo) risponde -> utente capisce la risposta
```

Task runtime, browser, approval, memoria, subagenti e computer locale sono
capacita' interne o progressive. Non devono diventare il comportamento base
della chat e non devono comparire prima di una risposta utile.

## Regole Di Prodotto

- La chat e' la superficie principale.
- Una richiesta semplice deve ricevere una risposta semplice, senza piano.
- Il sistema non deve mostrare parole interne come `prompt_plan`, `read model`,
  `runtime`, `approval gate`, `checkpoint`, `task queue` nella conversazione.
- Il dettaglio operativo deve essere collassato o disponibile on demand.
- L'utente non deve premere `Continua` per far avanzare step sicuri.
- L'approvazione serve solo quando il prossimo passo puo' cambiare stato
  esterno, usare credenziali, inviare contenuti, comprare, prenotare,
  cancellare o pubblicare.
- Ogni approval deve dire in linguaggio naturale:
  - cosa succede se approvo;
  - cosa non succedera' ancora;
  - quale rischio sto accettando.
- Il risultato finale deve essere piu' evidente della timeline.

## Flussi Obbligatori

### 1. Domanda semplice

Esempio: `chi sei?`, `spiegami cos'e' un mutuo`, `scrivi una mail breve`.

UX attesa:

- Mostra solo la risposta dell'assistente (modello attivo).
- Nessun computer locale visibile.
- Nessun piano.
- Nessuna approval.
- Eventuale stato massimo: `L'assistente sta rispondendo`.

### 2. Calcolo o risposta breve

Esempio: `quanto fa 6*3`, `che ore sono?`.

UX attesa:

- Risposta diretta.
- Se usa una funzione locale, non deve essere esposta come task.
- Nessun bottone `Continua`.
- Nessuna timeline.

### 3. Richiesta informativa senza azione

Esempio: `trova opzioni di treno Napoli-Milano per il 10 giugno verso le 9,
senza comprare`.

UX attesa:

- Il sistema puo' usare browser o strumenti locali.
- La chat mostra uno stato breve: `Sto cercando opzioni`.
- Il computer locale resta collassato.
- Nessuna approval se l'azione e' solo ricerca/lettura.
- La risposta finale contiene opzioni, fonti e limiti.
- La timeline e gli artifact sono secondari.

### 4. Richiesta con strumento visibile

Esempio: `apri il sito Trenitalia e confronta gli orari`.

UX attesa:

- Stato breve nella chat.
- Activity card collassabile con miniatura browser/shell.
- L'utente puo' aprire il dettaglio se vuole vedere cosa succede.
- Il sistema prosegue da solo finche' opera in read-only.
- La risposta finale resta il focus.

### 5. Richiesta rischiosa

Esempio: `prenota il treno`, `invia questa email`, `pubblica il post`,
`cancella questi file`.

UX attesa:

- Il sistema prepara il lavoro sicuro prima dell'approvazione.
- Quando arriva al punto rischioso, mostra una scheda chiara nella chat.
- La scheda contiene:
  - azione che verra' eseguita;
  - dati essenziali redatti;
  - cosa resta bloccato;
  - pulsanti `Rifiuta` e `Approva`.
- Dopo l'approvazione, il sistema continua senza chiedere altri click inutili.

## Cosa Non Fare

- Non costruire nuove viste prima che i cinque flussi siano usabili.
- Non esporre il task runtime come UX primaria.
- Non trasformare ogni richiesta in un piano visibile.
- Non chiedere approval per ricerca, lettura o confronto read-only.
- Non mettere il computer locale al centro quando non serve.
- Non considerare un modulo "production ready" se peggiora il loop base.

## Criterio Di Accettazione

Una modifica e' accettabile solo se almeno uno dei cinque flussi diventa piu'
chiaro, piu' veloce o piu' affidabile senza peggiorare gli altri.

La prossima fase del progetto deve quindi essere:

```text
Chat semplice e stabile prima, orchestrazione visibile dopo.
```

## Chat Experience Foundation

La chat e' il banco di prova di ogni modulo. Prima di cablare nuove funzioni
operative complesse, la superficie chat deve gestire bene contenuti e stati
reali, non solo testo semplice.

Riferimento architetturale: assistant-ui. Non importiamo automaticamente la CLI
o il tema shadcn/Tailwind, ma adottiamo i pattern che servono al nostro prodotto
Tauri custom.

Backlog obbligatorio:

- Thread viewport robusto:
  - auto-scroll affidabile;
  - scroll-to-bottom;
  - empty state sobrio;
  - composer sempre utilizzabile;
  - nessun overlap con Local Computer o timeline.
- Message renderer:
  - Markdown;
  - GitHub Flavored Markdown;
  - codice inline e blocchi codice;
  - copia codice;
  - tabelle;
  - diagrammi Mermaid;
  - link sicuri;
  - rendering streaming-aware per blocchi non completi.
- Composer avanzato:
  - invio e cancel streaming;
  - stato `canSend` separato da `isDisabled`;
  - allegati;
  - drag and drop;
  - quote/reply;
  - gestione focus e shortcut.
- Attachments:
  - preview in composer;
  - preview read-only nei messaggi;
  - immagini, documenti e file generici;
  - artifact locali del computer come allegati leggibili.
- Message actions:
  - copia risposta;
  - rigenera;
  - continua;
  - salva in memoria;
  - crea task/automazione;
  - feedback utile/non utile.
- Suggestions contestuali:
  - approfondisci;
  - crea automazione;
  - apri browser;
  - salva preferenza;
  - mostra dettagli.
- Tool activity e Local Computer:
  - stato breve nella risposta;
  - activity card collassabile;
  - tool calls e reasoning sempre progress disclosure;
  - nessun raw payload.
- External-store pattern:
  - React non possiede il dominio chat;
  - Tauri Core resta owner di thread, messaggi, streaming, task, approvazioni e
    artifact;
  - la UI si limita a renderizzare read model e inviare intent/comandi.

Gate prima di cablare nuove capacita' operative:

- un prompt con Markdown, codice, tabella e Mermaid si legge bene;
- una risposta lunga in streaming non rompe scroll e composer;
- una risposta con artifact/allegato resta comprensibile;
- una risposta con tool activity mantiene il risultato come focus principale;
- messaggi, code block, diagrammi e azioni restano usabili in desktop e viewport
  stretta.
