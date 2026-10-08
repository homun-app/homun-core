# Parità del motore Homun con Hermes

Autorizzazione: Fabio chiede di continuare autonomamente fino alla parità completa.
Riferimento congelato: NousResearch/hermes-agent c9dca726514b709cf6e677d236a79fc8d0627f37.
Homun mantiene il proprio runtime; sorgenti e prompt derivati conservano MIT e provenienza.

La parità comprende comportamenti verificabili del motore e strumenti, non solo il loop.
Una matrice sorgente/capacità/test deve includere anche integrazioni opzionali: nessuna
funzionalità assente viene rimossa dal traguardo per poterlo dichiarare raggiunto.
La visione Homun (uso diretto oppure squadra aziendale) rimane sopra il motore.

Approccio scelto: derivare componenti piccoli e collegarli al percorso reale di Homun,
riusando storage, approvazioni, budget, procedure, memoria e MCP già presenti. Un fork
runtime incorporato contraddice la richiesta; una riscrittura libera senza prove di
confronto non garantisce equivalenza. Ogni tranche ha regressioni e prove persistenti.

Prima estensione: controlli di esecuzione. `steer` accoda una nuova istruzione al
prossimo confine tra round; `redirect` invalida il tentativo corrente e richiede una
nuova decisione, registrando come interrotte le chiamate incomplete; `pause` conserva
le chiamate pendenti, `resume` le riprende, `cancel` termina il lavoro. Gli esiti
incerti di una chiamata già iniziata non vengono dichiarati non eseguiti.

L'epoch del run separa i workflow vecchi dai nuovi, il lease protegge la pubblicazione.
I controlli sono comandi idempotenti del proprietario/revisore umano. Arresto e
annullamento restano possibili se una fonte è cambiata; ripresa e nuove istruzioni
rivalidano il perimetro autorizzato. Un normale messaggio nella chat di un lavoro
nativo attivo diventa steering senza una seconda interpretazione indipendente.
Il frontend espone pausa, ripresa e correzione senza richiedere un bot specializzato.

La parità non sarà dichiarata prima di test di interruzione durante modello/strumento,
riavvio, contesto lungo, strumenti generali, memoria, skill, delega, scheduling,
provider e sessioni. Credenziali assenti limitano la verifica live di specifiche
integrazioni; i relativi casi rimangono esplicitamente non verificati.
