export type ChannelStatus = "active" | "needs_setup" | "disabled";

export type ChannelConfigField = {
  id: string;
  label: string;
  placeholder?: string;
  type: "text" | "password";
  required?: boolean;
  helpText?: string;
};

export type ChannelDefinition = {
  id: string;
  name: string;
  subtitle: string;
  iconColor: string;
  quickSetupAvailable?: boolean;
  quickSetupLabel?: string;
  credentialsGuide: string;
  guideUrl?: string;
  fields: ChannelConfigField[];
};

export const CHANNELS_CATALOG: ChannelDefinition[] = [
  {
    id: "telegram",
    name: "Telegram",
    subtitle: "Esegui Homun dai messaggi privati, gruppi o canali Telegram.",
    iconColor: "#229ed9",
    quickSetupAvailable: true,
    quickSetupLabel: "Scansiona un codice QR e conferma su Telegram. Homun rileverà il tuo ID utente automaticamente.",
    credentialsGuide:
      "Su Telegram, cerca @BotFather, invia /newbot e copia l'HTTP API token generato. Poi apri @userinfobot per scoprire il tuo ID utente numerico.",
    guideUrl: "https://core.telegram.org/bots/tutorial",
    fields: [
      {
        id: "bot_token",
        label: "Bot Token",
        placeholder: "es. 123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ",
        type: "password",
        required: true,
        helpText: "Crea un bot con @BotFather, quindi incolla il token qui.",
      },
      {
        id: "allowed_user_ids",
        label: "ID Utenti Telegram Autorizzati",
        placeholder: "es. 987654321, 123456789",
        type: "text",
        required: false,
        helpText: "Consigliato. ID numerici separati da virgola ricavati da @userinfobot. Senza questo campo, chiunque potrà inviare messaggi al tuo bot.",
      },
    ],
  },
  {
    id: "discord",
    name: "Discord",
    subtitle: "Interagisci con Homun in server Discord, canali testuali e messaggi diretti.",
    iconColor: "#5865f2",
    credentialsGuide:
      "Accedi al Discord Developer Portal (discord.com/developers), crea una New Application, vai nella sezione Bot, attiva 'Message Content Intent' e copia il Bot Token.",
    guideUrl: "https://discord.com/developers/docs/intro",
    fields: [
      {
        id: "bot_token",
        label: "Bot Token Discord",
        placeholder: "es. MTEwOTk...xxxxxxxxxxxxxxxx",
        type: "password",
        required: true,
        helpText: "Token segreto del bot Discord con intenti di lettura e scrittura abilitati.",
      },
      {
        id: "allowed_channels",
        label: "ID Canali o Server Autorizzati",
        placeholder: "es. 112233445566778899",
        type: "text",
        required: false,
        helpText: "Lascia vuoto per consentire a tutti i canali in cui il bot è invitato.",
      },
    ],
  },
  {
    id: "slack",
    name: "Slack",
    subtitle: "Connetti Homun al tuo workspace aziendale Slack in Socket Mode o Web API.",
    iconColor: "#e01e5a",
    credentialsGuide:
      "Crea un'app su api.slack.com/apps, abilita Socket Mode, genera l'App-level Token (xapp-...) e installa l'app nel workspace per ottenere il Bot User OAuth Token (xoxb-...).",
    guideUrl: "https://api.slack.com/bot-users",
    fields: [
      {
        id: "bot_token",
        label: "Bot User OAuth Token (xoxb-...)",
        placeholder: "xoxb-xxxxxxxx-xxxxxxxx-xxxxxxxx",
        type: "password",
        required: true,
        helpText: "Token con permessi chat:write, channels:history, app_mentions:read.",
      },
      {
        id: "app_token",
        label: "App-Level Token (xapp-...) per Socket Mode",
        placeholder: "xapp-xxxxxxxx-xxxxxxxx-xxxxxxxx",
        type: "password",
        required: false,
        helpText: "Permette a Homun di ricevere eventi Slack senza esporre porte aperte su Internet.",
      },
    ],
  },
  {
    id: "mattermost",
    name: "Mattermost",
    subtitle: "Integrazione con la tua istanza Mattermost self-hosted o cloud.",
    iconColor: "#0058cc",
    credentialsGuide:
      "Nelle impostazioni di sistema di Mattermost, abilita le Bot Accounts, crea un nuovo bot con permessi adeguati e salva il Bot Access Token generato.",
    fields: [
      {
        id: "server_url",
        label: "URL del Server Mattermost",
        placeholder: "https://mattermost.azienda.local",
        type: "text",
        required: true,
      },
      {
        id: "bot_token",
        label: "Bot Access Token",
        placeholder: "incolla qui il token",
        type: "password",
        required: true,
      },
    ],
  },
  {
    id: "matrix",
    name: "Matrix",
    subtitle: "Messaggistica federata e crittografata end-to-end su protocollo Matrix.",
    iconColor: "#0dbd8b",
    credentialsGuide:
      "Inserisci l'indirizzo del tuo Homeserver Matrix (es. https://matrix.org) e l'Access Token dell'account dedicato al bot.",
    fields: [
      {
        id: "homeserver_url",
        label: "Homeserver URL",
        placeholder: "https://matrix.org",
        type: "text",
        required: true,
      },
      {
        id: "user_id",
        label: "User ID Matrix",
        placeholder: "@homun-bot:matrix.org",
        type: "text",
        required: true,
      },
      {
        id: "access_token",
        label: "Access Token",
        placeholder: "syt_xxxxxxxx...",
        type: "password",
        required: true,
      },
    ],
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    subtitle: "Ricevi ed esegui richieste direttamente dal tuo WhatsApp personale, senza account Meta.",
    iconColor: "#25d366",
    quickSetupAvailable: true,
    quickSetupLabel: "Scansiona un codice QR da WhatsApp → Dispositivi collegati. Il tuo numero sarà l'unico autorizzato.",
    credentialsGuide:
      "Il canale usa il sidecar locale wa-rs-bridge (github.com/homunbot/wa-rs), che possiede la sessione WhatsApp Web: nessun account Meta né URL pubblica. Avvia il sidecar e usa la configurazione rapida con il QR.",
    guideUrl: "https://github.com/homunbot/wa-rs",
    fields: [
      {
        id: "allowed_user_ids",
        label: "ID Mittenti Autorizzati (JID o numero)",
        placeholder: "es. 393331234567, 393339876543@s.whatsapp.net",
        type: "text",
        required: false,
        helpText: "Il QR imposta automaticamente il tuo numero. Aggiungi qui altri JID (o numeri nudi) separati da virgola per autorizzarli.",
      },
      {
        id: "bridge_url",
        label: "URL del bridge wa-rs-bridge",
        placeholder: "http://127.0.0.1:8902",
        type: "text",
        required: false,
        helpText: "Opzionale: default http://127.0.0.1:8902 (o HOMUN_WHATSAPP_BRIDGE_URL nel motore).",
      },
      {
        id: "bridge_binary",
        label: "Percorso binario wa-rs-bridge",
        placeholder: "/percorso/wa-rs-bridge",
        type: "text",
        required: false,
        helpText: "Opzionale: se il canale è attivo e nessun bridge risponde, il motore lo avvia da questo percorso (default: HOMUN_WHATSAPP_BRIDGE_BIN, bin del venv, PATH).",
      },
    ],
  },
  {
    id: "whatsapp_cloud",
    name: "WhatsApp Business (Cloud API)",
    subtitle: "Canale ufficiale Meta Cloud API con numero aziendale e webhook.",
    iconColor: "#25d366",
    credentialsGuide:
      "Crea un'applicazione su Meta for Developers (developers.facebook.com), aggiungi il prodotto WhatsApp, e copia il Phone Number ID e il Token di accesso permanente.",
    guideUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api/get-started",
    fields: [
      {
        id: "phone_number_id",
        label: "Phone Number ID (Meta Cloud API)",
        placeholder: "es. 100609349549321",
        type: "text",
        required: true,
        helpText: "ID del numero di telefono generato nella dashboard WhatsApp Cloud API.",
      },
      {
        id: "api_token",
        label: "Access Token Permanente (Meta)",
        placeholder: "EAABwz...",
        type: "password",
        required: true,
        helpText: "Token permanente con permessi whatsapp_business_messaging.",
      },
    ],
  },
  {
    id: "signal",
    name: "Signal",
    subtitle: "Massima privacy e sicurezza con crittografia end-to-end tramite daemon signal-cli.",
    iconColor: "#3a76f0",
    credentialsGuide:
      "Richiede un'istanza locale di signal-cli in esecuzione in modalità JSON-RPC o REST daemon.",
    fields: [
      {
        id: "daemon_url",
        label: "URL Daemon signal-cli",
        placeholder: "http://127.0.0.1:8080",
        type: "text",
        required: true,
      },
      {
        id: "phone_number",
        label: "Numero di Telefono Registrato",
        placeholder: "+393331234567",
        type: "text",
        required: true,
      },
    ],
  },
  {
    id: "bluebubbles",
    name: "BlueBubbles (iMessage)",
    subtitle: "Invia e ricevi messaggi iMessage tramite il server BlueBubbles su macOS.",
    iconColor: "#147efb",
    credentialsGuide:
      "Avvia il server BlueBubbles sul tuo Mac e incolla l'URL dell'istanza e la password di autenticazione.",
    fields: [
      {
        id: "server_url",
        label: "BlueBubbles Server URL",
        placeholder: "http://localhost:1234",
        type: "text",
        required: true,
      },
      {
        id: "password",
        label: "Password Server",
        placeholder: "password del server",
        type: "password",
        required: true,
      },
    ],
  },
  {
    id: "homeassistant",
    name: "Home Assistant",
    subtitle: "Attivazioni domotiche e notifiche tramite entità e webhook di Home Assistant.",
    iconColor: "#03a9f4",
    credentialsGuide:
      "Nel tuo profilo Home Assistant, crea un Long-Lived Access Token e inserisci l'URL dell'istanza.",
    fields: [
      {
        id: "ha_url",
        label: "URL Istanza Home Assistant",
        placeholder: "http://homeassistant.local:8123",
        type: "text",
        required: true,
      },
      {
        id: "access_token",
        label: "Long-Lived Access Token",
        placeholder: "eyJhbGci...",
        type: "password",
        required: true,
      },
    ],
  },
  {
    id: "email",
    name: "Email (IMAP / SMTP)",
    subtitle: "Ricevi brief di lavoro e recapita report direttamente via posta elettronica.",
    iconColor: "#ea4335",
    credentialsGuide:
      "Configura le credenziali IMAP per la lettura dei messaggi in arrivo e SMTP per l'inoltro delle risposte.",
    fields: [
      {
        id: "email_address",
        label: "Indirizzo Email",
        placeholder: "assistente@azienda.com",
        type: "text",
        required: true,
      },
      {
        id: "smtp_host",
        label: "Server SMTP",
        placeholder: "smtp.azienda.com",
        type: "text",
        required: true,
      },
      {
        id: "password",
        label: "Password o App Password",
        placeholder: "password",
        type: "password",
        required: true,
      },
    ],
  },
  {
    id: "twilio",
    name: "SMS (Twilio)",
    subtitle: "Invio e ricezione di SMS con notifiche istantanee via API Twilio.",
    iconColor: "#f22f46",
    credentialsGuide:
      "Recupera Account SID e Auth Token dalla dashboard della console Twilio.",
    fields: [
      {
        id: "account_sid",
        label: "Twilio Account SID",
        placeholder: "ACxxxxxxxx...",
        type: "text",
        required: true,
      },
      {
        id: "auth_token",
        label: "Auth Token",
        placeholder: "auth token",
        type: "password",
        required: true,
      },
      {
        id: "from_number",
        label: "Numero Mittente Twilio",
        placeholder: "+1234567890",
        type: "text",
        required: true,
      },
    ],
  },
  {
    id: "dingtalk",
    name: "DingTalk",
    subtitle: "Comunicazione aziendale e bot personalizzati per DingTalk.",
    iconColor: "#007fff",
    credentialsGuide: "Crea una DingTalk Enterprise App e genera AppKey e AppSecret.",
    fields: [
      { id: "client_id", label: "AppKey (Client ID)", placeholder: "ding...", type: "text", required: true },
      { id: "client_secret", label: "AppSecret", placeholder: "secret", type: "password", required: true },
    ],
  },
  {
    id: "feishu",
    name: "Feishu / Lark",
    subtitle: "Integrazione con la suite di collaborazione aziendale Lark / Feishu.",
    iconColor: "#00d6b9",
    credentialsGuide:
      "Apri Feishu Open Platform, crea un'applicazione e ottieni App ID e App Secret per l'invio messaggi IM.",
    fields: [
      { id: "app_id", label: "App ID", placeholder: "cli_a1b2c3...", type: "text", required: true },
      { id: "app_secret", label: "App Secret", placeholder: "secret", type: "password", required: true },
    ],
  },
  {
    id: "googlechat",
    name: "Google Chat",
    subtitle: "Integrazione app per Google Workspace Chat e Spaces.",
    iconColor: "#00ac47",
    credentialsGuide:
      "Crea un Google Cloud Project, abilita l'API Google Chat e configura un webhook in entrata per lo Space.",
    fields: [
      { id: "webhook_url", label: "Incoming Webhook URL", placeholder: "https://chat.googleapis.com/v1/spaces/...", type: "password", required: true },
    ],
  },
  {
    id: "wecom",
    name: "WeCom (group bot)",
    subtitle: "Bot personalizzato per gruppi Enterprise WeChat.",
    iconColor: "#2072e5",
    credentialsGuide: "Aggiungi un bot personalizzato a un gruppo WeCom e copia la chiave del webhook.",
    fields: [
      { id: "webhook_key", label: "Webhook Key", placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", type: "password", required: true },
    ],
  },
  {
    id: "wechat",
    name: "Weixin / WeChat (Personal)",
    subtitle: "Supporto account personale WeChat tramite server bridge dedicato.",
    iconColor: "#07c160",
    credentialsGuide: "Configura il token del server bridge compatibile Weixin.",
    fields: [
      { id: "bridge_token", label: "Bridge Token", placeholder: "token", type: "password", required: true },
    ],
  },
  {
    id: "qq",
    name: "QQ Bot",
    subtitle: "Bot per la piattaforma Tencent QQ Open Platform.",
    iconColor: "#12b7f5",
    credentialsGuide: "Accedi alla console QQ Open Platform per ottenere AppID e Token.",
    fields: [
      { id: "app_id", label: "Bot AppID", placeholder: "102030405", type: "text", required: true },
      { id: "token", label: "Bot Token", placeholder: "token", type: "password", required: true },
    ],
  },
  {
    id: "yuanbao",
    name: "Yuanbao (元宝)",
    subtitle: "Integrazione con Tencent Yuanbao e canali collegati.",
    iconColor: "#ff4d4f",
    credentialsGuide: "Inserisci la chiave API fornita dal portale Tencent Yuanbao.",
    fields: [
      { id: "api_key", label: "Yuanbao API Key", placeholder: "yb_...", type: "password", required: true },
    ],
  },
  {
    id: "irc",
    name: "IRC",
    subtitle: "Connessione diretta a reti IRC storiche o server interni.",
    iconColor: "#4a5568",
    credentialsGuide: "Specifica server, porta, nickname e canali da monitorare.",
    fields: [
      { id: "host", label: "IRC Server Host", placeholder: "irc.libera.chat", type: "text", required: true },
      { id: "port", label: "Porta (es. 6697 SSL)", placeholder: "6697", type: "text", required: false },
      { id: "nickname", label: "Nickname Bot", placeholder: "HomunBot", type: "text", required: true },
      { id: "channels", label: "Canali (separati da virgola)", placeholder: "#homun, #dev", type: "text", required: false },
    ],
  },
];
