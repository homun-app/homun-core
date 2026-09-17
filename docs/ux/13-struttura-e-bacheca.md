# Struttura visiva e Kanban operativo
16 settembre 2026.

## Regole per la baseline
- Navigazione dello spazio in alto: Home, collaboratori, automazioni, documenti,
  plugin. Stesso peso visivo. Squadra e progetti sono contenuti espandibili sotto;
  profilo e impostazioni restano in fondo.
- Titoli descrittivi e scala tipografica compatta; niente headline promozionali
  nelle viste operative. La gerarchia è data da posizione, spazio e stato.
- Compito: prima responsabile, stato, scadenza, impedimento/risultato e azione.
  Metodo e moduli al secondo livello; massimo due livelli per questo percorso.
- Un solo stato del lavoro per Home, calendario, bacheca e procedure.
- Interazioni manipolabili: trascinamento fra colonne e ordinamento prima di
  un’altra scheda; comando Sposta alternativo per tastiera e touch.
- I cambiamenti di stato non aggirano dipendenze o approvazioni. Messaggio
  contestuale con Apri compito se occorre risolvere un vincolo.
- Una normale attività umana può finire senza produrre un file. Non imporre
  un documento a telefonate, verifiche o altri lavori senza artefatti.

Riferimenti:
[W3C, alternativa al trascinamento](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements)
e [NN/g, progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/).
Questi principi guidano le scelte; non costituiscono una certificazione di accessibilità.

## Modifiche
Sidebar riordinata; titoli compatti e nomi diretti per squadra/progetti.
Riepilogo generico per tutti i compiti non guidati, oltre alla demo assistita.
Bacheca con drag and drop e menu Sposta. Colonne con larghezza minima leggibile.
Regole comuni di transizione per bacheca, riepilogo e selettore di stato.
I cambiamenti riconciliano dipendenze sequenziali e consegne.

## Evidenza e limiti
Ispezionate screenshot e navigazione di Home, squadra, progetti, bacheca,
documenti, plugin, automazioni, impostazioni e compito. Non ogni configurazione
o combinazione di ruoli è stata provata.

Browser: trascinamento fisico da Completato a Da fare; comando Sposta;
tentativo di concludere compito bloccato rifiutato; riepilogo/dettaglio,
approvazione, ritorno a Home; comando a 390px senza overflow della pagina.
62 test passano, inclusi transizioni umane, vincoli, ordinamento e rilascio del
passaggio successivo di una procedura. TypeScript, lint mirato e build passano.

Il motore non esegue azioni esterne: le transizioni aggiornano soltanto il modello
locale. Le colonne descrivono stati del sistema; colonne personalizzate e corsie
non sono implementate. Non è stata provata una reale sessione multiutente.

## Chiusura della baseline: cosa rimane
La struttura navigabile è più coerente; non dichiarare l’intero prodotto definitivo.
Prima di fissare i contratti del motore, completare:
1. identità/versioni comuni degli allegati e anteprime di risultati diversi;
2. rappresentazione dell’autonomia per competenza e della formazione supervisionata;
3. fonti e connessioni disponibili, indisponibili o da autorizzare;
4. prova senza dati predefiniti e prova con molti progetti/collaboratori.

Questi punti devono entrare nella struttura esistente, senza nuove gerarchie
parallele o flussi obbligatori legati a un settore.
