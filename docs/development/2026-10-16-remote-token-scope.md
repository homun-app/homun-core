# Ambito dei token remoti — un dispositivo abbinato non è il proprietario

Deciso e implementato il 2026-10-16 dopo la verifica di sicurezza che ha
riprodotto: il token di sessione di una persona invitata (dispositivo
abbinato con `POST /v1/remote/pair`, oppure sessione riscattata con
`POST /v1/session/redeem`) era accettato da `routes/session_auth.py` su
TUTTE le rotte del motore, con la stessa fiducia del token locale del
desktop. Un membro senza alcun grant otteneva: registrazione di server MCP
`stdio` con `command` arbitrario (esecuzione di codice sull'host), letture
delle memorie personali del proprietario, backup dell'intero workspace e
`POST …/commands` con `project.create`.

## I tre tipi di token

| Token                                                                                       | Chi lo ha                                     | Cosa può fare                                                                                                                   |
| ------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Launcher** (`HOMUN_SESSION_TOKEN`, generato dal desktop)                                  | Il processo del desktop sulla stessa macchina | Tutto: È il proprietario. L'attore è fisso (`person_fabio`) e non può essere impersonato (`session_actor_mismatch`)             |
| **Sessione persona** (riscattata con `/v1/session/redeem`, solo localhost)                  | Una persona invitata, da un processo locale   | SOLO l'allowlist remota (sotto)                                                                                                 |
| **Sessione dispositivo** (emessa da `/v1/remote/pair/confirm`, nel `device_token` del peer) | Un dispositivo abbinato di una persona        | SOLO l'allowlist remota: è una sessione persona legata al dispositivo (TTL 30 giorni, revocabile per persona o per dispositivo) |

Le rotte `POST /v1/remote/pair`, `/v1/remote/pair/confirm`,
`/v1/session/redeem`, `/v1/contribution-portal/read` e
`/v1/contribution-portal/respond` si autenticano DA SÉ con l'invito nel
corpo: non accettano il token launcher e stanno fuori dal Bearer di
sessione.

## L'allowlist: chiusa per impostazione predefinita

`SessionAuthMiddleware` distingue launcher e persona. Per le sessioni di
persona (e per il Bearer risolto da `PersonBearerHeaderMiddleware`, anche
in `--dev-insecure`) la richiesta deve corrispondere a una voce di
`engine/src/homun/routes/remote_scope.py` — elenco esplicito di coppie
metodo + modello di percorso. Tutto il resto risponde **403** con
`reason: "session.scope_denied"` (frase nel catalogo condiviso
`contracts/i18n/errors.{it,en}.json`) **prima di arrivare al gestore della
rotta**. Conseguenze volute:

- una rotta NUOVA è chiusa per impostazione predefinita: chi la aggiunge
  decide esplicitamente se è remota;
- non esistono scorciatoie «blocco solo le rotte pericolose»: l'elenco è
  di ciò che è PERMESSO;
- l'ordine dei controlli è: sessione valida (401 se scaduta/revocata) →
  ambito (403 `session.scope_denied`) → permessi della risorsa reale.

### Le rotte permesse e perché

Ogni voce continua a controllare i permessi sulla risorsa REALE: l'elenco
dice solo che la rotta fa parte del perimetro remoto, non che è fidata.

| Rotte                                                                                                                           | Client reale                                                                                                                        | Permesso della risorsa                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET …/remote/snapshot`, `GET …/remote/events`                                                                                  | `peers/replication.py` (`sync_remote_project`)                                                                                      | grant `read` sul progetto richiesto (`identity/remote_feed.py`), eventi filtrati dal perimetro del progetto e da `visible_event`                    |
| `POST …/remote/commands`                                                                                                        | `peers/outbox.py` (outbox del peer)                                                                                                 | solo i tipi di `REMOTE_ALLOWED_COMMANDS` (`identity/remote_commands.py`: `conversation.post_message`, `conversation.rename`) + permessi del dominio |
| `GET …/projects`                                                                                                                | `peers/cli.py` (`homun peer projects`)                                                                                              | elenco filtrato da `list_readable_project_ids`: solo i progetti con grant                                                                           |
| `GET …/remote/assignments`, `GET …/remote/assignments/{id}`, `POST …/{id}/accept\|return\|reconcile`                            | `peers/cli.py`                                                                                                                      | solo le deleghe assegnate a quella persona (`list_assignments_for`, `get_assignment_for`)                                                           |
| `POST …/remote/objects`, `GET …/remote/objects`, `GET …/remote/objects/{id}/versions/{v}`, `GET\|PUT …/versions/{v}/chunks/{i}` | trasporto degli oggetti cifrati fra peer (F5.5; il sealing è `peers/object_crypto.py`, il client di pubblicazione arriva col pilot) | grant + recipient wrap + firma del publisher verificate in `identity/object_transfer.py` (revisione P1–P6)                                          |

Il portale contributi web usa solo `/v1/contribution-portal/*` con il
token invito nel Bearer: rotte self-authenticate, fuori da questo elenco.

### Il caso delle rotte language (deciso insieme, allowlist NON allargata)

`test_language_preference.py` usava sessioni persona reali su
`GET/PUT …/people/{id}/language` e `PUT …/language`: rotte NON remote,
nessun client le chiama con token di persona (il desktop le chiama col
token launcher). Non sono state aggiunte all'elenco; i test provano le
stesse authority su un'app dev-insecure fidata sugli header attore. Se un
giorno una persona remota dovrà scegliere la propria lingua, si aprirà la
rotta con un test di autorizzazione dedicato.

## Come aprire una rotta remota

1. Aggiungi la coppia (metodo, modello) a `REMOTE_SCOPE_ALLOWLIST` in
   `routes/remote_scope.py` con un commento che dice quale client la usa.
2. Il gestore DEVE già controllare i permessi sulla risorsa reale
   (progetto della risorsa, non quello dichiarato nella richiesta). Se non
   li controlla, prima quelli.
3. **Test di autorizzazione obbligatorio** in
   `engine/tests/test_remote_token_scope.py`: un membro senza grant sulla
   rotta nuova riceve il rifiuto del dominio (non 200); un membro con il
   grant giusto ottiene solo la sua risorsa. La passeggiata
   (`test_every_route_outside_allowlist_denies_member_and_keeps_owner`)
   copre automaticamente il resto: verifica con l'OpenAPI che tutto ciò
   che non è in elenco risponde 403 `session.scope_denied` al token del
   membro e niente al token del proprietario.
4. Aggiorna la tabella qui sopra con la motivazione.

## Difesa in profondità sulle memorie

`GET …/memories` e `GET …/memories/export` (`routes/memory.py`) filtrano
per persona anche quando chiamate dal launcher su richiesta di un'altra
persona: le memorie `scope=person` di altri non si restituiscono MAI; le
memorie di progetto solo con grant `read` sul progetto reale della nota.
L'ambito delle memorie visibili a una persona: proprie note personali +
note dei progetti leggibili + mestiere condiviso (`agent`/`global`).

## Test

- `engine/tests/test_remote_token_scope.py` — i quattro casi riprodotti,
  sessione riscattata, dev-insecure, pattern dell'elenco, passeggiata su
  tutte le rotte OpenAPI, difesa sulle memorie.
- La passeggiata usa una middleware guard interna (418): prova l'ambito su
  ogni rotta senza mai eseguire un gestore — nessun processo, nessuna rete.

## Collegamenti

- Runbook del pilot: `2026-10-08-pilot-runbook.md` (il pilot in rete non
  parte prima di questa PR).
- Perimetro dei comandi remoti: `engine/src/homun/identity/remote_commands.py`.
- Revisione object transfer: commit `0fdc75b1` (P1–P6).
