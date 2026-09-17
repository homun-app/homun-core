# Valutazione del primo percorso UX

15 settembre 2026 — prova dell'assistente richiesta da Fabio.

## Perimetro e metodo

Percorso eseguito in una nuova sessione browser, nell'anteprima standalone
`/prototypes/first-work.html`, a 1366 × 768. Nessun codice modificato.
È una valutazione euristica: non sostituisce una prova con titolari d'azienda.
L'assenza della navigazione completa nell'anteprima limita il giudizio sul
contesto generale dell'app; i rilievi riguardano soprattutto il flusso creato.

Richiesta usata: «Ogni mattina controlla le richieste di preventivo, prepara le
risposte con il nostro listino e avvisami solo quando manca qualcosa».

## Evidenze osservate

1. Il bisogno viene riportato integralmente come responsabilità. Non emerge una
   proposta concreta con responsabilità, frequenza e informazioni mancanti.
2. Il nome è obbligatorio per procedere. La sua assenza blocca la navigazione
   anche quando l'attività è già descritta.
3. La seconda pagina richiede di considerare nome, responsabilità, conoscenze,
   strumenti, autonomia e politica AI. Lo screenshot completo occupa 1512 px
   di altezza; l'azione per proseguire richiede scorrimento a 768 px.
4. Il terzo passaggio presenta nuovamente campi vuoti per incarico e risultato.
   Distinzione tecnicamente corretta, ma scaricata sull'utente senza una proposta.
5. Il metodo è identico per tutti i casi, con passaggi come «Svolgere il lavoro
   richiesto». Non dimostra il metodo specifico che l'utente vuole insegnare.
6. Il bisogno quotidiano resta soltanto testo. La scheda finale rappresenta un
   incarico singolo e non spiega come arrivare alla routine richiesta.
7. Si arriva a «Da fare · Demo» anche senza indicare il listino o la posta.
   Il messaggio generico sui materiali non offre una scelta concreta per sbloccare
   la prova. Questo è un limite UX anche in assenza del motore.
8. La conclusione offre solo «Modifica l'incarico»: manca una continuazione verso
   squadra, lavori, prova della procedura o aggiunta dei materiali.
9. Il pannello laterale ripete contenuti già mostrati. Molto spazio è dedicato a
   metodo/modelli ancora da configurare, mentre le decisioni specifiche restano vaghe.
10. Le diciture di demo sono corrette, ma si ripetono nel corpo dei campi e
    interrompono la lettura. Serve un avviso di contesto con copy operativo più pulito.

## Giudizio

La resa visiva è coerente e leggibile. Il bisogno libero e la distinzione
collaboratore/incarico sono utili. La sequenza attuale è però un modulo di
configurazione: domanda all'utente di definire una parte consistente del sistema
prima di mostrare come Homun si occuperà del lavoro.

La verifica precedente di build, input, navigazione e persistenza era valida
tecnicamente, ma non dimostrava semplicità o efficacia per il pubblico scelto.

## Direzione proposta da discutere

- Dopo il bisogno, presentare una proposta concreta correggibile: responsabilità,
  risultato, frequenza ed eventuale momento di revisione.
- Chiedere solo il prossimo dato indispensabile; mostrare materiali mancanti
  con azioni concrete, ad esempio incollare una richiesta o fornire il listino.
- Lasciare nome modificabile ma proposto, politica dei modelli ereditata dalle
  impostazioni e budget leggibile senza costringere a scegliere subito la tecnologia.
- Presentare il metodo specifico come checklist proposta, con dettagli modificabili.
- Dopo la configurazione, far comparire il collaboratore nella squadra e una
  prova collegata nel lavoro. Rappresentare almeno una richiesta di informazioni
  e un risultato verificabile, anche usando uno scenario dichiaratamente simulato.
- Mantenere il bot agnostico nel modello di prodotto, adattando contenuti e
  percorso al bisogno. Agnosticismo non significa checklist generica identica.

Il prototipo futuro può usare esempi predefiniti esplicitamente etichettati per
valutare questa interazione prima di collegare un modello reale. Per richieste
libere non supportate deve dichiarare il limite e consentire configurazione manuale.
Non fingere interpretazione AI universale tramite semplici parole chiave.

## Artefatti locali

- `output/playwright/ux-review-collaborator.png`
- `output/playwright/ux-review-end.png`

Questo documento registra osservazioni e proposte, non un nuovo progetto approvato.
