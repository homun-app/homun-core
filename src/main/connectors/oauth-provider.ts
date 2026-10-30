// OAuthClientProvider per un server MCP HTTP (fase 5): implementa l'interfaccia
// di @modelcontextprotocol/sdk e delega a lei discovery (RFC 9728/8414), PKCE
// e Dynamic Client Registration. Qui restano solo le parti nostre: il redirect
// di loopback (RFC 8252), la persistenza CIFRATA (sealed-store.ts) e
// l'apertura del browser di sistema (via UI/HostBridge).
//
// Fase 13 (punto 6), verso la specifica MCP 2026-07-28 con l'SDK 1.32:
// - clientMetadata manda application_type "native" (DCR): i server accettano
//   i redirect loopback delle app desktop;
// - clientMetadataUrl opzionale (impostazione connectors.oauth.clientMetadataUrl,
//   vuota di default): se l'utente OSPITA un Client ID Metadata Document
//   (es. GitHub Pages) l'SDK usa CIMD/URL-based client id, altrimenti DCR —
//   SandBot non ha un dominio, quindi nessun URL inventato;
// - authorizeWithLoopback valida l'iss della redirect (RFC 9207) prima di
//   riscattare il codice. Il LEGAME delle credenziali all'issuer lo fa già
//   l'SDK 1.32.2 (le timbra con issuer e si ri-registra quando cambia).
//
// Il provider è una fabbrica a dipendenze iniettabili (store, openExternal,
// state) così i test girano contro un authorization server finto in memoria.
import { randomBytes } from 'node:crypto'
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { startCallbackServer } from './callback-server'
import type { ConnectorsSecretStore } from './sealed-store'

/** Credenziali statiche inserite dall'utente (es. client OAuth Google). */
export interface StaticClientCredentials {
  client_id: string
  client_secret?: string
}

/**
 * Fase 14 (punto 0a): l'errore del provider SILENZIOSO senza client salvato.
 * UnauthorizedError → chi connette (ensure di mcp/index) segna il server
 * needs_auth, col bottone Connetti/Riconnetti dell'utente.
 */
export const SILENT_NO_CLIENT_MSG =
  'nessun client OAuth salvato per questo server e la connessione silenziosa non ne registra: connetti il server col bottone Connetti/Riconnetti (il flusso interattivo registra e salva il client)'

export interface OAuthProviderDeps {
  /** Server MCP a cui i segreti appartengono (chiave dello store cifrato). */
  serverId: string
  /** Redirect di loopback http://127.0.0.1:<porta>/callback (RFC 8252). */
  redirectUrl: string
  /** Apre il browser di sistema (UI/HostBridge); deve throware senza UI. */
  openExternal(url: string): Promise<void>
  store: ConnectorsSecretStore
  /** Scope richiesti dal catalogo (opzionale: decide il server altrimenti). */
  scope?: string
  /** Credenziali pre-registrate (clientRegistration 'static'); null per DCR. */
  staticClient?(): Promise<StaticClientCredentials | null>
  /** Parametri extra da appendere all'URL di autorizzazione (es. access_type=offline). */
  extraAuthParams?: Record<string, string>
  /** Factory dello state (la connessione la pre-generata per il callback server). */
  stateFactory?(): string
  /** Fase 13 (punto 6): URL del Client ID Metadata Document ospitato dall'utente (CIMD). */
  clientMetadataUrl?: string
  /**
   * Fase 14 (punto 0a): 'all' (default) — il provider registra client (DCR) e
   * li salva; 'existing-only' — il provider del trasporto SILENZIOSO (connessione
   * fuori dal flusso interattivo: mcp:test, inizio turno, toolsOfServer):
   * NIENTE registrazione. Senza client salvato, clientInformation() throwa
   * UnauthorizedError PRIMA della DCR (l'endpoint /register non viene mai
   * chiamato) e la connessione rifiuta: il server finisce in needs_auth come
   * per un token scaduto, con il bottone Connetti/Riconnetti dell'utente.
   * Con clientMetadataUrl (CIMD) il comportamento è invariato: l'URL-based
   * client id non ha bisogno di registrazione.
   */
  registration?: 'all' | 'existing-only'
}

/**
 * Il provider di una connessione. `onInvalidate` viene chiamato quando l'SDK
 * invalida le credenziali (refresh fallito): il manager segna il connettore
 * 'needs_auth' e il prossimo uso propone la card "Riconnetti".
 */
export function createOAuthProvider(
  deps: OAuthProviderDeps,
  onInvalidate?: (scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') => void
): OAuthClientProvider {
  const fields = {
    tokens: 'oauth.tokens',
    clientInformation: 'oauth.client',
    codeVerifier: 'oauth.verifier',
    discovery: 'oauth.discovery'
  } as const

  return {
    get redirectUrl(): string {
      return deps.redirectUrl
    },

    /** Fase 13 (punto 6): CIMD se l'utente ospita il documento (l'SDK lo usa per gli URL-based client id). */
    ...(deps.clientMetadataUrl ? { clientMetadataUrl: deps.clientMetadataUrl } : {}),

    get clientMetadata(): OAuthClientMetadata {
      // client pubblico con PKCE; application_type native (punto 6): i server
      // accettano i redirect loopback delle app desktop — l'SDK 1.32.2 non lo
      // tipizza ma lo inoltra nella DCR così com'è; con credenziali statiche
      // (es. Google) il secret accompagna le richieste del token endpoint
      const meta: OAuthClientMetadata & { application_type?: string } = {
        client_name: 'Homun',
        redirect_uris: [deps.redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: deps.staticClient ? 'client_secret_basic' : 'none',
        ...(deps.scope ? { scope: deps.scope } : {})
      }
      meta.application_type = 'native'
      return meta
    },

    async state(): Promise<string> {
      return deps.stateFactory ? deps.stateFactory() : randomBytes(16).toString('hex')
    },

    async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
      const staticCreds = deps.staticClient ? await deps.staticClient() : null
      if (staticCreds?.client_id) {
        return {
          client_id: staticCreds.client_id,
          ...(staticCreds.client_secret ? { client_secret: staticCreds.client_secret } : {}),
          redirect_uris: [deps.redirectUrl]
        }
      }
      const stored = (await deps.store.read<OAuthClientInformationMixed>(deps.serverId, fields.clientInformation)) ?? undefined
      // fase 14 (0a): il provider SILENZIOSO non registra client. Senza uno
      // salvato, l'UnauthorizedError fa rifiutare la connessione PRIMA della
      // DCR (l'endpoint /register non si tocca mai) e il server va in
      // needs_auth. Con CIMD si prosegue normale: l'URL-based client id non
      // ha bisogno né di client salvato né di registrazione.
      if (!stored && deps.registration === 'existing-only' && !deps.clientMetadataUrl) {
        throw new UnauthorizedError(SILENT_NO_CLIENT_MSG)
      }
      return stored
    },

    // fase 14 (0a): 'existing-only' NON espone saveClientInformation — senza
    // un client salvato l'SDK throwa prima di chiamare /register (rete di
    // sicurezza per qualunque percorso che leggesse il client altrove)
    ...(deps.registration === 'existing-only'
      ? {}
      : {
          async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
            await deps.store.write(deps.serverId, fields.clientInformation, clientInformation)
          }
        }),

    async tokens(): Promise<OAuthTokens | undefined> {
      return (await deps.store.read<OAuthTokens>(deps.serverId, fields.tokens)) ?? undefined
    },

    async saveTokens(tokens: OAuthTokens): Promise<void> {
      await deps.store.write(deps.serverId, fields.tokens, tokens)
    },

    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
      // parametri extra del vendor (Google: refresh token duraturo)
      for (const [k, v] of Object.entries(deps.extraAuthParams ?? {})) authorizationUrl.searchParams.set(k, v)
      await deps.openExternal(authorizationUrl.toString())
    },

    async saveCodeVerifier(codeVerifier: string): Promise<void> {
      await deps.store.write(deps.serverId, fields.codeVerifier, codeVerifier)
    },

    async codeVerifier(): Promise<string> {
      return (await deps.store.read<string>(deps.serverId, fields.codeVerifier)) ?? ''
    },

    async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
      await deps.store.write(deps.serverId, fields.discovery, state)
    },

    async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
      return (await deps.store.read<OAuthDiscoveryState>(deps.serverId, fields.discovery)) ?? undefined
    },

    async invalidateCredentials(scope): Promise<void> {
      onInvalidate?.(scope)
      if (scope === 'all') await deps.store.removeAll(deps.serverId)
      else if (scope === 'client') await deps.store.remove(deps.serverId, [fields.clientInformation])
      else if (scope === 'tokens') await deps.store.remove(deps.serverId, [fields.tokens])
      else if (scope === 'verifier') await deps.store.remove(deps.serverId, [fields.codeVerifier])
      else if (scope === 'discovery') await deps.store.remove(deps.serverId, [fields.discovery])
    }
  }
}

/** Come l'SDK: due issuer combaciano anche con una sola slash finale diversa. */
export function issuersMatch(a: string, b: string): boolean {
  let [x, y] = [a, b]
  try {
    ;[x, y] = [new URL(a).href, new URL(b).href]
  } catch {
    // non due URL: confronto come scritti
  }
  return x === y || (x.endsWith('/') && x.slice(0, -1) === y) || (y.endsWith('/') && y.slice(0, -1) === x)
}

/**
 * Fase 13 (punto 6): il flusso di autorizzazione completo col callback di
 * loopback — prima auth() (discovery/DCR/PKCE + apertura del browser), attesa
 * del codice con lo state verificato dal callback server, VALIDAZIONE dell'iss
 * della redirect (RFC 9207): un iss diverso dall'issuer scoperto rifiuta il
 * codice con "issuer non corrispondente" (mai riscattato), poi riscatto.
 * Il ri-legame delle credenziali all'issuer (nuova registrazione quando
 * cambia) lo fa già l'SDK 1.32.2, che le timbra con l'issuer della discovery.
 */
export async function authorizeWithLoopback(
  serverUrl: string,
  providerFor: (redirectUrl: string, stateFactory: () => string) => OAuthClientProvider,
  opts: { timeoutMs?: number } = {}
): Promise<void> {
  const state = randomBytes(16).toString('hex')
  const cb = await startCallbackServer({ expectedState: state, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) })
  try {
    const provider = providerFor(cb.url, () => state)
    // fase 14 (punto 0a): un client salvato che NON contiene il redirect di
    // QUESTO flusso fra i suoi redirect_uris non serve (p.es. registrato dal
    // trasporto silenzioso con http://127.0.0.1:9/callback, o da un flusso
    // precedente su un'altra porta): un authorization server che non accetta
    // ogni porta di loopback (RFC 8252 §7.3 lo chiede, molti non lo fanno)
    // rifiuterebbe la richiesta. Si BUTTA prima di auth(): l'SDK registra di
    // nuovo col redirect del callback di questo flusso.
    const savedInfo = await Promise.resolve(provider.clientInformation()).catch(() => undefined)
    const savedRedirects = (savedInfo as { redirect_uris?: string[] } | undefined)?.redirect_uris
    if (savedInfo && !(savedRedirects ?? []).includes(cb.url)) {
      await provider.invalidateCredentials?.('client')
    }
    let result = await auth(provider, { serverUrl })
    if (result === 'REDIRECT') {
      const { code, iss } = await cb.waitForCode()
      const discovery = await provider.discoveryState?.()
      const expected = discovery?.authorizationServerUrl
      // RFC 9207: se i metadati dichiarano authorization_response_iss_parameter_supported
      // la redirect DEVE portare iss — senza, la risposta potrebbe non venire
      // dall'authorization server scoperto e il codice non si riscatta
      const issSupported = (discovery?.authorizationServerMetadata as { authorization_response_iss_parameter_supported?: boolean } | undefined)
        ?.authorization_response_iss_parameter_supported === true
      if (issSupported && !iss) {
        throw new Error('issuer assente nella redirect (RFC 9207): l\'authorization server lo dichiara obbligatorio')
      }
      if (iss && expected && !issuersMatch(iss, expected)) {
        throw new Error(`issuer non corrispondente: la redirect dichiara ${iss}, l'authorization server scoperto è ${expected}`)
      }
      result = await auth(provider, { serverUrl, authorizationCode: code })
    }
    if (result !== 'AUTHORIZED') throw new Error(`autenticazione non completata (${String(result)})`)
  } finally {
    cb.close()
  }
}
