// Fase app (A6): i test PURI della classificazione delle azioni di Composio.
// La regola di lettura è quella di Rakazo (action-approval.ts:79–113): verbo
// di lettura E nessun verbo di modifica E nessuna azione composta; la
// dichiarazione del fornitore non allenta mai (qui non passa proprio).
import { describe, expect, it } from 'vitest'
import {
  MUTATING_COMPOSIO_ACTION_PATTERN, READ_COMPOSIO_ACTION_PATTERN, COMPOUND_COMPOSIO_ACTION_PATTERN,
  DESTRUCTIVE_COMPOSIO_ACTION_PATTERN, stripToolkitPrefix, composioActionOfToolName,
  classifyComposioAction, classifyComposioToolName, composioSendLikeName,
  composioToolName, readableActionSlug, sanitizeComposioError, redactComposioSecrets
} from '../composio-actions'

describe('stripToolkitPrefix (A6 punto 1)', () => {
  it('toglie il prefisso del toolkit dal nome dell\'azione', () => {
    expect(stripToolkitPrefix('gmail', 'GMAIL_SEND_EMAIL')).toBe('SEND_EMAIL')
    expect(stripToolkitPrefix('googledrive', 'GOOGLEDRIVE_DELETE_FILE')).toBe('DELETE_FILE')
  })
  it('lascia il nome quando il prefisso non c\'è', () => {
    expect(stripToolkitPrefix('gmail', 'SEND_EMAIL')).toBe('SEND_EMAIL')
  })
  it('dal nome completo dello strumento ricava toolkit e azione senza prefisso', () => {
    expect(composioActionOfToolName('composio__gmail__GMAIL_SEND_EMAIL')).toEqual({ toolkit: 'gmail', action: 'SEND_EMAIL' })
    expect(composioActionOfToolName('composio__slack__SLACK_LIST_CHANNELS')).toEqual({ toolkit: 'slack', action: 'LIST_CHANNELS' })
  })
  it('i nomi non Composio sono nulli', () => {
    expect(composioActionOfToolName('mcp__gmail__send_email')).toBeNull()
    expect(composioActionOfToolName('composio__gmail')).toBeNull()
  })
})

describe('i pattern portati da Rakazo (costanti con test)', () => {
  it('MUTATING_COMPOSIO_ACTION_PATTERN copre TUTTO l\'elenco (accept … write)', () => {
    const verbs = ['accept', 'add', 'approve', 'archive', 'assign', 'buy', 'cancel', 'charge', 'checkout', 'close',
      'commit', 'copy', 'create', 'delete', 'deploy', 'disable', 'enable', 'execute', 'forward', 'grant', 'invite',
      'link', 'mark', 'merge', 'modify', 'move', 'patch', 'pay', 'post', 'publish', 'purchase', 'put', 'register',
      'reject', 'remove', 'rename', 'replace', 'reply', 'reset', 'revoke', 'run', 'schedule', 'send', 'set', 'share',
      'start', 'stop', 'submit', 'subscribe', 'trigger', 'unassign', 'unlink', 'unsubscribe', 'update', 'upload',
      'upsert', 'write']
    for (const v of verbs) {
      expect(MUTATING_COMPOSIO_ACTION_PATTERN.test(v.toUpperCase()), v).toBe(true)
      expect(MUTATING_COMPOSIO_ACTION_PATTERN.test(`GET_AND_${v.toUpperCase()}`), v).toBe(true)
    }
  })
  it('il verbo di modifica vale solo come SEGMENTO (post non matched in "posting_hub")', () => {
    expect(MUTATING_COMPOSIO_ACTION_PATTERN.test('POSTING_HUB')).toBe(false)
    expect(READ_COMPOSIO_ACTION_PATTERN.test('LISTINGS')).toBe(false)
  })
  it('READ_COMPOSIO_ACTION_PATTERN: get|list|search|find|read come segmento', () => {
    for (const v of ['GET', 'LIST', 'SEARCH', 'FIND', 'READ']) {
      expect(READ_COMPOSIO_ACTION_PATTERN.test(v)).toBe(true)
      expect(READ_COMPOSIO_ACTION_PATTERN.test(`${v}_USER`)).toBe(true)
    }
    expect(READ_COMPOSIO_ACTION_PATTERN.test('GETALL')).toBe(false)
  })
  it('COMPOUND: _and_ / _or_ / _then_', () => {
    expect(COMPOUND_COMPOSIO_ACTION_PATTERN.test('GET_AND_UPDATE_CONTACT')).toBe(true)
    expect(COMPOUND_COMPOSIO_ACTION_PATTERN.test('FETCH_OR_SEARCH')).toBe(true)
    expect(COMPOUND_COMPOSIO_ACTION_PATTERN.test('LIST_THEN_DELETE')).toBe(true)
    expect(COMPOUND_COMPOSIO_ACTION_PATTERN.test('LIST_CHANNELS')).toBe(false)
  })
  it('DESTRUCTIVE: delete|remove|cancel|revoke|archive|purge…', () => {
    for (const v of ['DELETE_FILE', 'REMOVE_USER', 'CANCEL_EVENT', 'REVOKE_TOKEN', 'ARCHIVE_CARD', 'PURGE_CACHE']) {
      expect(DESTRUCTIVE_COMPOSIO_ACTION_PATTERN.test(v), v).toBe(true)
    }
    expect(DESTRUCTIVE_COMPOSIO_ACTION_PATTERN.test('GET_DELETED_ITEMS')).toBe(false)
  })
})

describe('classifyComposioToolName — i casi della spec (A6 punto 6)', () => {
  it('GMAIL_FETCH_EMAILS → non lettura secondo il pattern di Rakazo → card', () => {
    // FETCH non è nella lista dei verbi di lettura di Rakazo (get|list|search|find|read)
    expect(classifyComposioToolName('composio__gmail__GMAIL_FETCH_EMAILS')).toBe('write')
  })
  it('GMAIL_LIST_THREADS → lettura', () => {
    expect(classifyComposioToolName('composio__gmail__GMAIL_LIST_THREADS')).toBe('read')
  })
  it('GMAIL_SEND_EMAIL → bozza', () => {
    expect(classifyComposioToolName('composio__gmail__GMAIL_SEND_EMAIL')).toBe('send')
  })
  it('SLACK_SEND_MESSAGE → bozza', () => {
    expect(classifyComposioToolName('composio__slack__SLACK_SEND_MESSAGE')).toBe('send')
  })
  it('GITHUB_CREATE_ISSUE → card', () => {
    expect(classifyComposioToolName('composio__github__GITHUB_CREATE_ISSUE')).toBe('write')
  })
  it('GOOGLEDRIVE_DELETE_FILE → distruttivo (card senza «sempre»)', () => {
    expect(classifyComposioToolName('composio__googledrive__GOOGLEDRIVE_DELETE_FILE')).toBe('destructive')
  })
  it('HUBSPOT_GET_AND_UPDATE_CONTACT → card (composta)', () => {
    expect(classifyComposioToolName('composio__hubspot__HUBSPOT_GET_AND_UPDATE_CONTACT')).toBe('write')
  })
})

describe('classifyComposioAction — regole di lettura e fail-closed', () => {
  it('lettura: verbo di lettura E nessuna modifica E nessuna composta', () => {
    expect(classifyComposioAction('GET_USER')).toBe('read')
    expect(classifyComposioAction('LIST_THREADS')).toBe('read')
    expect(classifyComposioAction('SEARCH_ISSUES')).toBe('read')
  })
  it('una dichiarazione «read» del fornitore NON allenta: il nome comanda', () => {
    // anche se un fornitore dichiarasse read-only UPDATE_SETTINGS, il verbo
    // update nel nome resta una modifica (il classificatore non riceve hints)
    expect(classifyComposioAction('READ_AND_UPDATE_SETTINGS')).toBe('write')
  })
  it('lettura con verbo di modifica dopo → non lettura', () => {
    // il classificatore COMPLETO vede l'invio (SEND dopo il verbo di lettura)
    expect(classifyComposioToolName('composio__crm__CRM_GET_USER_SEND_EMAIL')).toBe('send')
    expect(classifyComposioAction('LIST_AND_DELETE')).toBe('destructive')
  })
  it('senza verbi riconosciuti → scrittura (fail closed)', () => {
    expect(classifyComposioAction('FETCH_EMAILS')).toBe('write')
    expect(classifyComposioAction('EXPORT_REPORT')).toBe('write')
  })
  it('il prefisso del toolkit non confonde la classificazione (già tolto)', () => {
    // GMAIL_ sarebbe il primo segmento: senza lo strip, LIST_THREADS dopo
    // GMAIL_ resterebbe comunque ok, ma SEND dopo GMAIL_ (GMAIL_SEND_EMAIL)
    // verrebbe letto col verbo in SECONDA posizione — lo strip lo mette in testa
    expect(composioSendLikeName('composio__gmail__GMAIL_SEND_EMAIL')).toBe(true)
    expect(composioSendLikeName('composio__slack__SLACK_POST_MESSAGE')).toBe(true)
    expect(composioSendLikeName('composio__gmail__GMAIL_GET_MESSAGE')).toBe(false)
    // un verbo di lettura in testa vince su post/reply usati come nome
    expect(composioSendLikeName('composio__forum__FORUM_GET_POST')).toBe(false)
    // ma send/forward dopo una lettura restano invii (fail closed)
    expect(composioSendLikeName('composio__gmail__GMAIL_FETCH_AND_SEND')).toBe(true)
  })
})

describe('composioToolName (A5)', () => {
  it('composio__<toolkit>__<ACTION>', () => {
    expect(composioToolName('gmail', 'GMAIL_SEND_EMAIL')).toBe('composio__gmail__GMAIL_SEND_EMAIL')
  })
  it('oltre 64 caratteri accorcia con hash e resta unico/deterministico', () => {
    const long = 'VERYLONGTOOLKITNAME__' + 'A'.repeat(60)
    const name = composioToolName('verylongtoolkitname', long)
    expect(name.length).toBeLessThanOrEqual(64)
    expect(name.startsWith('composio__verylongtoolkitname__')).toBe(true)
    expect(name).toBe(composioToolName('verylongtoolkitname', long))
    // slug diversi danno nomi diversi (l'hash discrimina)
    const other = composioToolName('verylongtoolkitname', long.replace(/A$/, 'B'))
    expect(other).not.toBe(name)
  })
})

describe('readableActionSlug', () => {
  it('SEND_EMAIL → «Send email»', () => {
    expect(readableActionSlug('SEND_EMAIL')).toBe('Send Email')
    expect(readableActionSlug('composio__gmail__GMAIL_SEND_EMAIL')).toBe('Send Email')
  })
})

describe('sanitizeComposioError / redactComposioSecrets (A5)', () => {
  it('una chiave ak_… non compare MAI nel testo ripulito', () => {
    const err = new Error('Request failed with api key ak_live_9f3d2b8e: unauthorized')
    expect(sanitizeComposioError(err)).not.toContain('ak_live_9f3d2b8e')
    expect(sanitizeComposioError(err)).toContain('[redacted]')
  })
  it('Bearer e assegnazioni di credenziali vengono redatte', () => {
    expect(redactComposioSecrets('Authorization: Bearer eyJhbGc.abc.def')).toBe('Authorization: Bearer [redacted]')
    expect(redactComposioSecrets('api_key="sk-test-123"')).toContain('[redacted]')
    expect(redactComposioSecrets('password: hunter2')).toContain('[redacted]')
  })
  it('il testo senza segreti passa intatto', () => {
    expect(redactComposioSecrets('Channel not found: #generale')).toBe('Channel not found: #generale')
  })
})

describe('verifica fase app: nomi accorciati classificati sullo slug completo', () => {
  it('un\'azione lunga composta con cancellazione non passa per lettura', () => {
    const name = composioToolName('googledrive', 'GOOGLEDRIVE_FIND_FILE_IN_SHARED_DRIVE_AND_MOVE_TO_TRASH_FOLDER')
    expect(name.length).toBe(64)
    expect(classifyComposioToolName(name)).toBe('destructive')
  })
  it('lettura lunga e semplice resta lettura se lo slug completo è noto', () => {
    const name = composioToolName('googlecalendar', 'GOOGLECALENDAR_LIST_EVENTS_FOR_A_SPECIFIC_CALENDAR_WITH_PAGING')
    expect(name.length).toBe(64)
    expect(classifyComposioToolName(name)).toBe('read')
  })
  it('un nome accorciato sconosciuto non è mai lettura (fail closed)', () => {
    const unknown = 'composio__salesforce__SALESFORCE_GET_ACCOUNT_DETAILS_BY_I_abcdef'
    expect(unknown.length).toBe(64)
    expect(classifyComposioToolName(unknown)).toBe('write')
  })
})
