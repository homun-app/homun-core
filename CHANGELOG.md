# Changelog

Le note di ogni versione di Homun stanno qui: la sezione della versione
pubblicata finisce nel corpo della GitHub Release (da cui l'app mostra il
«cosa cambia» quando propone un aggiornamento). Formato: `## [x.y.z] — data`,
sezioni H2 e un punto per riga.

## [0.3.1000] — 2026-11-02

Homun torna: questa versione è il rinnovo completo di Homun 2, con la squadra
di bot che vive sul tuo Mac. **Le conversazioni e i bot di Homun 2 non vengono
importati: restano dove sono**, in `~/Library/Application Support/Homun2`
(apribile dal Finder la prima volta che apri la nuova app), e puoi conservarli
o cancellarli quando vuoi.

## Highlights

- **Un rinnovo, non un'importazione.** Homun 0.3 è la stessa app di sempre —
  stesso bundle, stesso aggiornamento automatico — con il motore rifatto: i
  bot, le routine, la cassaforte e il computer dei bot girano tutti in locale.
- **Il daemon è più sicuro.** Il processo che tiene in vita i bot quando
  chiudi la finestra ora è l'app stessa (niente più modalità «Node spoglio»):
  le build firmate spegnono quel vettore, e le chiavi della cassaforte sono
  legate alla firma dell'app — un altro programma che prova a leggerle fa
  comparire la richiesta di macOS.
- **Docker e git si trovano anche fuori dal Terminale.** Aprire l'app dal
  Finder non tocca più il percorso del box: se manca Docker Desktop, l'app te
  lo dice in parole con il link per installarlo.
- **Aggiornamenti mai in silenzio.** Quando c'è una versione nuova l'app te lo
  dice, scarichi guardando l'avanzamento e scegli se riavviare subito o
  installare alla chiusura. Il controllo parte solo nell'app installata.

## Fixes

- **Le finestre di dialogo si allargano davvero**: le Impostazioni occupano
  ora fino a 1080 px e «Nuovo bot» non sfora più in orizzontale.
- **La pagina è servita dall'app stessa** (protocollo `homun://`), non da
  `file://`, con i permessi del browser chiusi al minimo indispensabile.

## [Unreleased]

## Highlights

- **Il computer dei bot (Docker) resta un requisito** della prima versione
  firmata; la macchina virtuale inclusa nell'app arriva in una versione
  successiva.
