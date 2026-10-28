// Difese SSRF e troncamento di web_fetch (fase 11, punto 2) — PURE: niente
// rete, niente DNS, niente Electron.
import { describe, expect, it } from 'vitest'
import { checkUrl, isForbiddenIp, resolvedIpsAllowed, resolveRedirect, sliceWithOffset } from '../web-guard'
import { WEB_FETCH_MAX_CHARS } from '../../../shared/web-limits'

describe('checkUrl (puro)', () => {
  it('http e https ammessi, con host', () => {
    for (const u of ['http://example.com', 'https://example.com/a?b=c', 'https://sub.example.co.uk/x']) {
      const r = checkUrl(u)
      expect(r.ok, u).toBe(true)
    }
    expect(checkUrl('https://EXAMPLE.com').ok).toBe(true)
  })

  it('altri schemi rifiutati', () => {
    for (const u of ['file:///etc/passwd', 'ftp://example.com', 'javascript:alert(1)', 'gopher://x']) {
      expect(checkUrl(u).ok, u).toBe(false)
    }
  })

  it('credenziali nell\'URL rifiutate (user:pass@host)', () => {
    const r = checkUrl('https://user:password@example.com/')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('credenziali')
  })

  it('URL non valido rifiutato', () => {
    expect(checkUrl('non un url').ok).toBe(false)
    expect(checkUrl('').ok).toBe(false)
  })
})

describe('isForbiddenIp (puro)', () => {
  it('IP pubblici ammessi', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700::1111']) {
      expect(isForbiddenIp(ip), ip).toBe(false)
    }
  })

  it('loopback, privati, link-local (metadati cloud), 0.0.0.0, CGNAT, multicast rifiutati', () => {
    for (const ip of [
      '127.0.0.1', '127.8.8.8', // loopback
      '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', // privati RFC1918
      '169.254.169.254', // link-local = endpoint metadati cloud
      '0.0.0.0',
      '100.64.0.1', // CGNAT
      '224.0.0.1', '255.255.255.255' // multicast/riservati
    ]) {
      expect(isForbiddenIp(ip), ip).toBe(true)
    }
  })

  it('IPv6: loopback, ULA, link-local, multicast e IPv4-mapped rifiutati', () => {
    for (const ip of ['::1', '::', 'fd00::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1']) {
      expect(isForbiddenIp(ip), ip).toBe(true)
    }
    expect(isForbiddenIp('2606:4700::1111')).toBe(false)
  })
})

describe('resolvedIpsAllowed + flag di test', () => {
  it('senza flag: un solo IP privato basta a rifiutare', () => {
    expect(resolvedIpsAllowed(['93.184.216.34'])).toBe(true)
    expect(resolvedIpsAllowed(['93.184.216.34', '10.0.0.5'])).toBe(false)
  })
})

describe('resolveRedirect (puro)', () => {
  it('location assoluta e relativa risolvono contro l\'URL corrente', () => {
    const from = new URL('https://a.example/dir/page')
    expect(resolveRedirect(from, 'https://b.example/x').toString()).toBe('https://b.example/x')
    expect(resolveRedirect(from, '/root').toString()).toBe('https://a.example/root')
    expect(resolveRedirect(from, 'altro').toString()).toBe('https://a.example/dir/altro')
  })
})

describe('sliceWithOffset (puro): al più 20.000 caratteri con offset', () => {
  it('senza offset: primi 20k caratteri, nextOffset quando c\'è altro', () => {
    const text = 'a'.repeat(WEB_FETCH_MAX_CHARS + 500)
    const w = sliceWithOffset(text)
    expect(w.text).toHaveLength(WEB_FETCH_MAX_CHARS)
    expect(w.totalLength).toBe(WEB_FETCH_MAX_CHARS + 500)
    expect(w.nextOffset).toBe(WEB_FETCH_MAX_CHARS)
  })

  it('con offset prosegue dal punto giusto e finisce col testo', () => {
    const w2 = sliceWithOffset('a'.repeat(WEB_FETCH_MAX_CHARS + 500), WEB_FETCH_MAX_CHARS)
    expect(w2.text).toHaveLength(500)
    expect(w2.nextOffset).toBeNull()
  })

  it('offset oltre la fine: testo vuoto', () => {
    const w = sliceWithOffset('corto', 100)
    expect(w.text).toBe('')
    expect(w.nextOffset).toBeNull()
  })

  it('testo corto: tutto, nessun next', () => {
    const w = sliceWithOffset('ciao')
    expect(w.text).toBe('ciao')
    expect(w.nextOffset).toBeNull()
  })
})
