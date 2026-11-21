// PL2 (fase plugin): la divisione degli strumenti di un plugin in Sola
// lettura / Scrittura / Altro e l'insieme FISSO (invii, pagamenti) che non
// offre mai «Consenti sempre». Le regole: le annotazioni MCP
// readOnlyHint/destructiveHint quando ci sono, il classificatore Composio
// per composio__<toolkit>__<ACTION>, altrimenti «Altro». Il test INCROCIATO
// con i classificatori veri (main, nodo puro) inchioda le copie: se una
// cambia, questo test diventa rosso.
import { describe, expect, it } from 'vitest'
import {
  classifyPluginTool, fixedAskOf, isPaymentToolName, TOOL_GROUP_OTHER
} from '../tool-classify'
import { classifyComposioToolName, composioSendLikeName } from '../../main/connectors/composio-actions'

describe('PL2: la divisione Sola lettura / Scrittura / Altro', () => {
  it('le annotazioni MCP quando ci sono: readOnlyHint → lettura, destructiveHint → scrittura', () => {
    expect(classifyPluginTool('mcp__srv__search', { readOnlyHint: true }).group).toBe('read')
    expect(classifyPluginTool('mcp__srv__delete_thing', { destructiveHint: true }).group).toBe('write')
    expect(classifyPluginTool('mcp__srv__write_thing', { readOnlyHint: false, destructiveHint: false }).group).toBe('other')
  })

  it('senza annotazioni → Altro (mai un gruppo inventato)', () => {
    expect(classifyPluginTool('mcp__srv__mystery').group).toBe(TOOL_GROUP_OTHER)
  })

  it('Composio: il classificatore delle azioni decide (read/write/destructive)', () => {
    expect(classifyPluginTool('composio__gmail__GMAIL_FETCH_EMAILS').group).toBe('read')
    expect(classifyPluginTool('composio__googledrive__GOOGLEDRIVE_DELETE_FILE').group).toBe('write')
    expect(classifyPluginTool('composio__hubspot__HUBSPOT_GET_AND_UPDATE_CONTACT').group).toBe('write')
  })

  it('INCROCIATO con il classificatore VERO di Composio (le copie restano allineate)', () => {
    const names = [
      'composio__gmail__GMAIL_FETCH_EMAILS', 'composio__gmail__GMAIL_SEND_EMAIL',
      'composio__googledrive__GOOGLEDRIVE_DELETE_FILE', 'composio__hubspot__HUBSPOT_GET_AND_UPDATE_CONTACT',
      'composio__slack__SLACK_SEARCH_MESSAGES', 'composio__trello__TRELLO_CREATE_CARD',
      'composio__notion__NOTION_APPEND_BLOCK', 'composio__github__GITHUB_CREATE_ISSUE',
      'composio__gmail__GMAIL_FETCH_AND_DELETE'
    ]
    for (const n of names) {
      const mine = classifyPluginTool(n)
      const real = classifyComposioToolName(n)
      const expectGroup = real === 'read' ? 'read' : 'write'
      expect(mine.group, n).toBe(expectGroup)
      expect(mine.fixedAsk === 'send', `${n} send`).toBe(composioSendLikeName(n))
    }
  })
})

describe('PL2: l\'insieme fisso non offre «Consenti sempre»', () => {
  it('gli invii (send/reply/forward/post…) sono dell\'insieme fisso, con o senza prefisso', () => {
    expect(fixedAskOf('mcp__srv__send_message')).toBe('send')
    expect(fixedAskOf('composio__gmail__GMAIL_SEND_EMAIL')).toBe('send')
    expect(fixedAskOf('mcp__mail__forward_email')).toBe('send')
    expect(fixedAskOf('mcp__mail__fetch_and_send')).toBe('send')
  })

  it('readOnlyHint ESCLUDE l\'invio (come il classificatore delle bozze)', () => {
    expect(fixedAskOf('mcp__srv__send_report', { readOnlyHint: true })).toBeNull()
  })

  it('le letture e le scritture normali NON sono dell\'insieme fisso', () => {
    expect(fixedAskOf('mcp__srv__search', { readOnlyHint: true })).toBeNull()
    expect(fixedAskOf('mcp__srv__create_draft')).toBeNull()
  })

  it('i nomi con parole di pagamento/acquisto sono dell\'insieme fisso', () => {
    expect(isPaymentToolName('mcp__shop__place_order')).toBe(true)
    expect(isPaymentToolName('mcp__shop__purchase_item')).toBe(true)
    expect(isPaymentToolName('mcp__shop__checkout_cart')).toBe(true)
    expect(fixedAskOf('mcp__shop__subscribe_plan')).toBe('payment')
    expect(isPaymentToolName('mcp__shop__list_orders')).toBe(false)
  })
})
