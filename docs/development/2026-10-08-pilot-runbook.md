# Runbook del pilot — due Mac su reti diverse (gate F5)

Ottenuto con: due Mac collegati da Tailscale (default D3), Fabio host e
Giulia peer. Durata stimata: un'ora. I cinque criteri del gate in fondo.

## Prerequisiti

- **Mac di Fabio (host)**: repository homun2 con venv engine pronto
  (`npm run engine:install`), motore spento eventuali istanze di dev.
- **Mac di Giulia (peer)**: idem. Non serve lo stesso account git: basta
  il codice e `engine:install`.
- **Tailscale** su entrambi ([tailscale.com](https://tailscale.com), piano
  free): creare la tailnet con l'account di Fabio e aggiungere entrambi i
  Mac. Annotare l'indirizzo `100.x.y.z` dell'host con `tailscale ip`.
- Convenzione: l'host risponde su porta **8765**.

## Passo 1 — Host (Mac di Fabio)

```sh
cd homun2/engine
.venv/bin/python -m homun serve --host 0.0.0.0 --port 8765 --dev-insecure
```

Dal terminale di Fabio (o dal browser su `http://localhost:4183` con il
dev server web): creare il progetto condiviso e l'invito.

Invito via API (semplice, dal Mac host):

```sh
H=http://127.0.0.1:8765; A='X-Homun-Actor-Id: person_fabio'
curl -s -X POST $H/v1/workspaces/ws_local/commands -H "$A" -H "Content-Type: application/json" \
  -d '{"command_id":"pil-p1","type":"project.create","payload":{"name":"Catalogo condiviso"}}'
curl -s -X POST $H/v1/workspaces/ws_local/people/invites -H "$A" -H "Content-Type: application/json" \
  -d '{"role":"member","note":"pilot Giulia"}'
# → annotare project_id e il token "invite:pinv_….<secret>" (monouso)
```

**Sicurezza del pilot (dichiarata)**: `--dev-insecure` su VPN significa che
i dispositivi della tailnet sono fidati — limitare con una ACL Tailscale
la porta 8765 al solo Mac di Giulia, oppure accettare esplicitamente il
perimetro per la prova. Le permission interne del workspace restano quelle
vere di F5 (grant, revoca, nessun accesso implicito). La produzione userà
sessioni/token: già supportate dal motore, manca solo il client web.

## Passo 2 — Peer (Mac di Giulia)

Opzione A — **dall'interfaccia** (consigliata per la prova utente):

```sh
cd homun2 && npm run engine:dev    # motore di Giulia su 127.0.0.1:8765
npm run dev                        # web su 127.0.0.1:4183
```

Impostazioni → **Spazi remoti** → «Entra nello spazio» con
`http://100.x.y.z:8765` (indirizzo Tailscale dell'host), il token
dell'invito e il nome «Giulia». Il dispositivo di Giulia si registra con
la propria chiave.

Opzione B — **da terminale** (equivalente):

```sh
.venv/bin/python -m homun peer pair --host http://100.x.y.z:8765 \
  --invite 'invite:pinv_…' --name 'Giulia' --device 'MacBook di Giulia'
```

## Passo 3 — Condivisione (Mac di Fabio)

Dopo il pairing, Fabio concede a Giulia lettura e scrittura sul progetto e
delega un passo (es. la traduzione di un listino):

```sh
PERSON=<person_id di Giulia dal pannello Persone o /v1/…/people>
PROJ=<project_id>
curl -s -X POST $H/v1/workspaces/ws_local/commands -H "$A" -H "Content-Type: application/json" \
  -d "{\"command_id\":\"pil-g1\",\"type\":\"grant.issue\",\"payload\":{\"project_id\":\"$PROJ\",\"subject_id\":\"$PERSON\",\"capability\":\"read\"}}"
# ripetere con capability write per il contributo
```

## Passo 4 — Giulia lavora

- Sidebar → **Spazi remoti** → apre «Catalogo condiviso» (sync automatica
  all'apertura, badge *Fonte: motore remoto · sola lettura*).
- Contributo: da terminale `homun peer message --host … --conversation …
  --text 'Listino tradotto'` oppure Impostazioni → Spazi remoti → sync.
- Delega: Fabio offre (comando `delegation.offer`), Giulia vede
  `/remote/assignments`, `accept` e `return` — da interfaccia quando la
  UI la esporrà, oggi da `homun peer`.

## I cinque criteri del gate (da spuntare)

1. ☐ Il contributo di Giulia al progetto condiviso è visibile a Fabio.
2. ☐ Un terzo nodo non invitato non ottiene nulla (provare un terzo
   dispositivo, se disponibile, o simulare con token fasullo).
3. ☐ Spengere l'host mentre Giulia scrive: l'outbox dice «in attesa di
   consegna», MAI «salvato»; riaccendere: la coda si svuota in ordine.
4. ☐ La delega produce UN solo risultato: rifare il return con lo stesso
   payload → «idempotente», con payload diverso → conflitto.
5. ☐ Ogni vista remota dichiara Fonte: motore remoto e host esplicito.

Dopo la prova: riavviare entrambi i motori e verificare che connessioni,
proiezioni e outbox sopravvivano (persistiti in `remote-peers.db`).

## Cose da osservare e annotare (per il report)

- Tempi percepiti di sync e ritardo dei contributi.
- Cosa non capisce Giulia al primo approccio (vocabolario UI, passi oscuri).
- Errori incontrati e come si sono presentati (tipizzati o muti).
- Qualsiasi perdita o incoerenza dopo riavvii/spegimenti improvvisi.
