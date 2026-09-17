# Persone, condivisione e autonomia

Direzione autorizzata: continuare con la gestione dei permessi e lasciare la revisione
complessiva dell'esperienza a fine completamento. Rimane un prototipo UX, non un sistema
di autorizzazione implementato.

Spazio: Persone e accessi, proprietario fisso, ruoli admin/collaboratore/ospite,
bozze invito locali con controllo duplicati, sospensione/ripristino. Nessun invio.
Progetti: Condivisione per persona, nessun accesso/vedere/lavorare/gestire; documenti,
conversazioni e approvazioni separati. Proprietario con gestione completa, accessi
espliciti anche per amministratori. Nuovi progetti senza condivisioni implicite.
Bot: operatori diretti, azioni per strumento, responsabile approvazioni. Ospiti solo
nel contesto dei progetti; sospesi/inviti non attivi non possono ricevere abilitazione
diretta. Strumenti dichiarati sola lettura bloccati su consultazione.

Verifiche: bozza invito Luca non attiva; Cliente demo con sola lettura non può
approvare; assegnazione a Giulia e successiva sospensione riflessa nelle opzioni del
bot; policy Trello bozze conservata navigando; sola lettura non modificabile. Mobile
390 senza overflow. Screenshot desktop/mobile ispezionati; tipi, lint e build preview.

Limiti e revisione futura: il motore dovrà verificare ogni azione e accesso a risorse,
memoria, passaggi tra agenti, approvatore nel progetto corrente e collegamenti/account.
L'interfaccia resta una vista del proprietario, non simula sessioni di altri utenti.
Azioni completamente autonome e condizioni granulari da definire. Tutto si azzera al
reload. La densità dei dettagli del bot va ridotta nella revisione complessiva finale.
