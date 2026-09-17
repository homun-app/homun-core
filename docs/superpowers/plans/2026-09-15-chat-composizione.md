# Prova chat e composizione

Direzione approvata: chat con domande e controlli cliccabili a sinistra; bozza
modificabile a destra. Il prototipo resta privo di motore e servizi attivi.

Implementare un percorso agnostico con responsabilità, fonte, materiali, avvio,
metodo, risultato, autonomia e budget. Consentire risposte libere, omissioni e
modifiche dalla bozza. Mostrare selettore file nativo e opzioni di pianificazione
strutturate. Non fingere connessioni o comprensione del linguaggio naturale.
Verificare tipi, build e browser desktop/mobile prima di consegnare la preview.

## Esito

Implementato `ChatWorkJourney`, condiviso da preview e pagina Crea. Percorso libero,
scelte inline, bozza cliccabile, selettore file (solo metadati), giorni/orario/fuso,
intervalli, descrizione eventi e condizioni. Configurazioni dei servizi descritte,
non collegate. Sessione conserva la bozza, non la cronologia né i contenuti file.

Verifica browser: responsabilità → email → file fittizio → feriali 10:30;
modifica dall'aside a ogni 15 minuti e ripristino dopo reload. Screenshot desktop
1366 e mobile 390 ispezionati; mobile senza overflow orizzontale. Domanda corrente
separata dalla cronologia per mantenerla visibile. TypeScript, lint e build app e
preview passano. Nessuna esecuzione backend o prova della route autenticata.

Limite deliberato: domande predefinite agnostiche, non conversazione intelligente.
Fonti multiple e combinazioni di condizioni restano descrizioni testuali. Questa
prova valuta la composizione a due colonne prima di approfondire i singoli editor.
