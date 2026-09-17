# Percorso assistito — seconda prova UX

15 settembre 2026. Iterazione autorizzata con «procedi e ritenta».

## Cosa cambia

Il percorso ora è bisogno → proposta → collaboratore con primo lavoro → materiali
→ risultato illustrativo → revisione. Gli esempi propongono nome, responsabilità,
metodo e frequenza. La configurazione approfondita è facoltativa. Il bot resta
agnostico: preventivi, rassegna e manutenzione sono esempi esplicitamente scelti.

Il percorso libero non interpreta il testo: consente una configurazione manuale.
Non c'è un motore AI. I risultati sono precompilati e disponibili soltanto con
materiali, metodo, responsabilità e risultato atteso corrispondenti all'esempio.
Modificare questi dati impedisce di mostrare il risultato statico come elaborato.

## Prova effettuata

- Browser reale, componente condiviso con `/app/create`, preview senza login.
- Preventivi: quattro clic dalla scelta dell'esempio al risultato, senza digitare.
- Revisione, riprova, modifica dei materiali e ripristino dopo ricaricamento.
- Il listino modificato non consente di visualizzare il risultato precompilato.
- Metodo vuoto: il ritorno al lavoro è bloccato con indicazione del campo mancante.
- Aprire il metodo e tornare senza modifiche conserva la prova rivista, anche
  dopo ricaricamento. Corretto un azzeramento dello stato trovato in revisione.
- Richiesta libera con la parola «preventivi»: nessuna selezione automatica di
  un esempio, metodo da definire esplicitamente.
- Screenshot desktop 1366 e mobile 390 ispezionati. Nessun overflow orizzontale
  nello stato finale alle larghezze 320, 390 e 1366.
- Sette test di logica, TypeScript, lint dei componenti modificati e build app e
  preview. La route autenticata completa non è stata provata in questa verifica.

## Giudizio

Più convincente del primo modulo: rende visibili chi lavora, con quale metodo,
cosa aspetta e cosa consegna. La frequenza non si perde. Le impostazioni non
bloccano la prima esperienza. La richiesta dei materiali dà un seguito concreto.

Non è ancora una validazione dell'intera UX dell'azienda AI:

1. Il percorso libero resta manuale; dobbiamo ancora rappresentare il dialogo
   che chiarisce un bisogno e costruisce una proposta insieme all'utente.
2. «La tua squadra» mostra un solo collaboratore e un lavoro. Mancano la vista
   quotidiana, le attese tra bot e i passaggi di responsabilità.
3. Su mobile la scheda del collaboratore precede il lavoro ed è lunga. In una
   vista operativa il risultato e la richiesta di attenzione meritano priorità.
4. Su desktop la proposta è molto più compatta, ma la CTA resta vicino al limite
   inferiore a 768 px di altezza; possiamo ridurre lo spazio introduttivo.
5. Costi e ricorrenza sono dichiarati, non eseguiti: questa prova non valida
   contabilità, pianificazione, collegamenti ai servizi o autonomia reale.

## Prossima decisione proposta

Prima di aggiungere altri moduli, discutere se questo ingresso è credibile.
Poi prototipare la giornata con due collaboratori agnostici, un lavoro che passa
fra loro e una richiesta di intervento umano. È una proposta, non una decisione
già approvata né una scelta del motore.

Preview: `http://127.0.0.1:4182/prototypes/first-work.html`.
