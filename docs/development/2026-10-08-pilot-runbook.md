# Runbook del pilot — due Mac su reti diverse (gate F5)

Ottenuto con: due Mac collegati da Tailscale (default D3), Fabio host e
Giulia peer. Durata stimata: un'ora. I cinque criteri del gate in fondo.

> **GATE**: il pilot in rete NON parte prima dell'unione della PR
> «listener remoto separato» (`feat/remote-listener`, modello in
> `2026-10-16-remote-token-scope.md`): il traffico di rete entra SOLO da
> `--remote-listen`, dove l'attore deriva dal token di persona/dispositivo
> e ogni header attore del client è rifiutato. `--dev-insecure` in rete è
> vietato dal motore stesso.

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

Il motore parte con una sessione VERA del proprietario e con il listener
remoto esplicito: il listener principale resta su loopback (contratto del
desktop), la tailnet vede solo il listener remoto.

```sh
cd homun2/engine
export HOMUN_SESSION_TOKEN=$(.venv/bin/python -c "import secrets; print(secrets.token_urlsafe(32))")
TAILSCALE_IP=$(tailscale ip -4 | head -1)
.venv/bin/python -m homun serve --host 127.0.0.1 --port 8765 --remote-listen ${TAILSCALE_IP}:8765
```

- `--remote-listen` vuole un indirizzo ESPPLICITO della macchina (l'IP
  Tailscale `100.x.y.z`): `0.0.0.0` e `[::]` sono rifiutati, il motore
  esce con codice 2.
- `--dev-insecure` e `--remote-listen` si escludono a vicenda: se richiesti
  insieme il motore NON parte. Nel pilot non si usa MAI `--dev-insecure`:
  senza autenticazione il motore si fida dell'header `X-Homun-Actor-Id`, e
  qualunque dispositivo della tailnet diventerebbe il proprietario
  (esattamente ciò che la PR #450 ha chiuso).

Invito via API dal terminale dell'host, su **loopback** con il **token
locale** (mai header attore: l'identità la porta la sessione):

```sh
H=http://127.0.0.1:8765; A="Authorization: Bearer $HOMUN_SESSION_TOKEN"
curl -s -X POST $H/v1/workspaces/ws_local/commands -H "$A" -H "Content-Type: application/json" \
  -d '{"command_id":"pil-p1","type":"project.create","payload":{"name":"Catalogo condiviso"}}'
curl -s -X POST $H/v1/workspaces/ws_local/people/invites -H "$A" -H "Content-Type: application/json" \
  -d '{"role":"member","note":"pilot Giulia"}'
# → annotare project_id e il token "invite:pinv_….<secret>" (monouso)
```

**Sicurezza del pilot (dichiarata)**: la rete entra SOLO dal listener
remoto (`homun/remote_listener.py`), che accetta esclusivamente token di
persona/dispositivo del registro sessioni: pairing + allowlist remota
(`routes/remote_scope.py`), tutto il resto 403 `session.scope_denied`
prima del gestore; gli header `X-Homun-Actor-Id`/`Name` inviati dal client
sono rifiutati con 403 `remote.actor_header_forbidden`; il token del
desktop non vale fuori dal loopback. Le permission interne del workspace
restano quelle vere di F5 (grant, revoca, nessun accesso implicito). Come
difesa AGGIUNTIVA consigliata, limitare con una ACL Tailscale la porta
8765 al solo Mac di Giulia: il motore resta chiuso anche se un altro
dispositivo della tailnet tenta il pairing o gioca con i token.
Sull'host non serve il dev server web: i comandi del proprietario girano
da terminale col token locale (l'origine `homun://app` del desktop resta
l'unica browser-face ammessa con la sessione attiva).

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
  all'apertura, badge _Fonte: motore remoto · sola lettura_).
- Contributo: da terminale `homun peer message --host … --conversation …
--text 'Listino tradotto'` oppure Impostazioni → Spazi remoti → sync.
- Delega: Fabio offre (comando `delegation.offer`), Giulia vede
  `/remote/assignments`, `accept` e `return` — da interfaccia quando la
  UI la esporrà, oggi da `homun peer`.

## I cinque criteri del gate (da spuntare)

1. ☐ Il contributo di Giulia al progetto condiviso è visibile a Fabio.
2. ☐ Un terzo nodo non invitato non ottiene nulla (provare un terzo
   dispositivo, se disponibile, o simulare con token fasullo); anche
   `X-Homun-Actor-Id: person_fabio` senza token è rifiutato con 403
   `remote.actor_header_forbidden`.
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
