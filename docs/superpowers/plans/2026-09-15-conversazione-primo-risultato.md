# Conversazione verso il primo risultato

Direzione approvata con «proviamo»: chat centrale, scelte nei messaggi che si
compattano dopo la risposta, dettagli apribili e progressivi. Nessun contatore
obbligatorio. Prova di un lavoro prima di proporre una routine; routine richiedibile
anche subito. Tre esempi dichiarati preservano l'agnosticità del collaboratore.

Implementare un prototipo senza servizi: selezione materiali, risultato illustrativo
solo per fixture esplicite, collegamento email simulato e scelta avvio. Testare nel
browser primo risultato, routine, ritorni, file propri e viewport mobile. Nessun
modello o account reale, nessun invio. Sessione volatile dichiarata.

## Verifica

Percorso browser: preventivi → file personale (nessun output generato) → materiali
dimostrativi → risultato → email simulata → intervallo (0 rifiutato, 15 accettato)
→ dettagli → risultato. Provato anche ingresso diretto nella routine senza fonte:
restano dichiarati fonte e lavoro da definire. Screenshot desktop/mobile ispezionati;
nessun overflow orizzontale a 390 px. Tipo e lint verificati; build app e preview.

Limiti: nessuna interpretazione del testo libero, nessuna connessione reale, file
selezionati solo per nome, nessuna persistenza al reload. Su mobile dettagli sotto
la chat; il singolo risultato può richiedere scorrimento. Verifica su preview del
componente condiviso, non sulla route autenticata completa.
