# Changelog

Tutte le modifiche degne di nota a Homun sono documentate qui. Il formato segue
[Keep a Changelog](https://keepachangelog.com/it/1.1.0/). Questa è la fonte di verità unica:
la sezione della versione rilasciata finisce nel corpo della release GitHub (da cui l'app mostra
il "cosa c'è di nuovo" nell'aggiornamento) e nella pagina changelog del sito.

## [Non rilasciato]

## [0.1.2] — 2026-07-24

Prima release con il nuovo motore del browser e il controllo a metà attività ("steering").

### Novità
- **Controllo a metà attività (steering).** Puoi correggere o reindirizzare Homun mentre sta
  già lavorando, senza ricominciare da capo: il messaggio viene interpretato e applicato al
  compito in corso.
- **Recupero automatico se il modello non risponde un attimo.** Se il modello diventa
  momentaneamente non disponibile durante un'attività, il turno **attende e riprende** da dove
  era invece di fallire — una sola risposta, nessun lavoro perso, nessun doppione.

### Migliorato
- **Browser più capace nel compilare i form.** Selezione affidabile delle voci dai campi con
  suggerimenti (tendine tipo il selettore di stazione), così non resta bloccato a ridigitare.
- **Il browser insiste finché fa progressi.** Il tempo a disposizione si **ripristina a ogni
  passo riuscito**, con un tetto di sicurezza complessivo: su modelli più lenti non abbandona
  più a metà di un modulo, ma si ferma solo se è davvero bloccato.
- **Ricerche web più robuste.** Migliore lettura delle pagine, meno tentativi a vuoto, risultati
  restituiti in modo più fedele.

### Sicurezza
- **Le azioni che impegnano denaro richiedono conferma esplicita.** Login, prenotazioni e
  compilazione moduli restano liberi se richiesti; solo il pagamento finale richiede
  un'autorizzazione esplicita, decisa da ciò che l'azione fa davvero sulla pagina (non dalle
  parole del pulsante).

[Non rilasciato]: https://github.com/homun-app/homun-releases/releases
[0.1.2]: https://github.com/homun-app/homun-releases/releases/tag/v0.1.2
