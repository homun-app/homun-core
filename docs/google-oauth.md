# Client OAuth per i connettori Google (Gmail, Calendar, Drive)

I server MCP di Google richiedono una registrazione **statica**: serve un client
OAuth **tuo**, creato nella Google Cloud Console. La guida ufficiale di Google è
["Configure the Gmail MCP server"](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server);
l'elenco degli endpoint MCP è in
["Supported products"](https://docs.cloud.google.com/mcp/supported-products).

## 1. Progetto Google Cloud e API

1. Su [console.cloud.google.com](https://console.cloud.google.com) crea (o scegli)
   un progetto.
2. Abilita le API del servizio che vuoi connettere, ad esempio per Gmail:
   ```sh
   gcloud services enable gmail.googleapis.com gmailmcp.googleapis.com --project=PROJECT_ID
   ```
   (per Calendar/Drive: `calendarmcp.googleapis.com` / `drivemcp.googleapis.com`).

## 2. Schermata di consenso

In *Google Auth Platform → Branding*:

- nome app: es. "SandBot MCP";
- pubblico: *Internal* se hai un'organizzazione Google Workspace, altrimenti
  *External* e aggiungi il tuo account come **utente di test**;
- aggiungi gli scope del servizio (per Gmail:
  `https://www.googleapis.com/auth/gmail.readonly` e
  `https://www.googleapis.com/auth/gmail.compose` — sono gli scope minimi che
  SandBot richiede, solo lettura + bozze).

## 3. Client OAuth di tipo "Desktop app" (redirect su loopback)

In *Auth Platform → Clients → Create client*:

- **tipo: "Desktop app"** — i client desktop usano il redirect **loopback**
  `http://127.0.0.1:<porta>/callback` (RFC 8252): SandBot apre un server locale
  sulla porta libera al momento della connessione, quindi non serve registrare
  una porta fissa;
- salva **client_id** e **client_secret**.

Nota: la guida ufficiale di Google mostra il tipo "Web application" con redirect
fissi dei loro client di esempio (Antigravity/Claude). SandBot è un'app nativa:
il tipo "Desktop app" + loopback è la forma equivalente per client propri.

## 4. Inserisci le credenziali in SandBot

Impostazioni → **Connetti app** → connettore Gmail (o Calendar/Drive) →
"Client OAuth": incolla client_id e client_secret. Vengono conservati **cifrati**
(AES-256-GCM, chiave nel Keychain macOS) e non compaiono mai nei settings in
chiaro. Poi premi **Connetti**: si apre il browser di sistema sulla pagina di
consenso di Google e al ritorno il connettore risulta connesso.

Per ottenere un **refresh token duraturo** SandBot aggiunge alla richiesta di
autorizzazione `access_type=offline` e `prompt=consent`, come raccomandato dalla
guida ufficiale (senza `access_type=offline` Google non rilascia il refresh token
e il connettore chiederebbe di riconnettersi ogni ora).

## Limiti noti

- I server MCP di Google sono in **Developer Preview**: serve l'adesione al
  programma preview del progetto (vedi la guida ufficiale).
- Un solo client per progetto va bene per più servizi, ma gli scope della
  schermata di consenso devono coprire quelli richiesti da ciascun connettore.
