// R4 (fase app — ritocchi): i nomi delle azioni nella lingua dell'utente.
// Pure: verbo da tabella + oggetto dal glossario, MAI mezze traduzioni (una
// parola fuori tabella → null → il chiamante usa il nome originale di
// Composio) e in inglese sempre null (vince il nome originale).
import { describe, expect, it } from 'vitest'
import { localizedActionName, bareActionSlug } from '../composio-names'

describe('R4 — localizedActionName', () => {
  it('SLACK_CREATE_REMINDER → «Crea promemoria»', () => {
    expect(localizedActionName('SLACK_CREATE_REMINDER', 'it')).toBe('Crea promemoria')
  })

  it('GMAIL_SEND_EMAIL → «Invia email»', () => {
    expect(localizedActionName('GMAIL_SEND_EMAIL', 'it')).toBe('Invia email')
  })

  it('GMAIL_LIST_THREADS → «Elenca conversazioni» (plurale esplicito nel glossario)', () => {
    expect(localizedActionName('GMAIL_LIST_THREADS', 'it')).toBe('Elenca conversazioni')
  })

  it('HUBSPOT_CREATE_DEAL → «Crea trattativa»', () => {
    expect(localizedActionName('HUBSPOT_CREATE_DEAL', 'it')).toBe('Crea trattativa')
  })

  it('una parola sconosciuta (canvas) → null: mai mezze traduzioni', () => {
    expect(localizedActionName('SLACK_CREATE_CANVAS_SECTION', 'it')).toBeNull()
  })

  it('in inglese → null (il chiamante usa il nome originale di Composio)', () => {
    expect(localizedActionName('SLACK_CREATE_REMINDER', 'en')).toBeNull()
    expect(localizedActionName('GMAIL_SEND_EMAIL', 'en')).toBeNull()
  })

  it('accetta anche il nome completo dello strumento (composio__slack__…)', () => {
    expect(localizedActionName('composio__slack__SLACK_CREATE_REMINDER', 'it')).toBe('Crea promemoria')
    expect(localizedActionName('composio__gmail__GMAIL_SEND_EMAIL', 'it')).toBe('Invia email')
  })

  it('senza verbo in testa, o con una sola parola → null', () => {
    expect(localizedActionName('REMINDER', 'it')).toBeNull()
    expect(localizedActionName('SEND', 'it')).toBeNull()
    expect(localizedActionName('TODAY_GET', 'it')).toBeNull() // verbo non in testa
    expect(localizedActionName('WEATHER_GET_TODAY', 'it')).toBeNull() // today fuori glossario
  })

  it('bareActionSlug: accetta il nome completo e toglie il toolkit ripetuto in testa (forma minuscola normalizzata)', () => {
    expect(bareActionSlug('composio__gmail__GMAIL_SEND_EMAIL')).toBe('send_email')
    expect(bareActionSlug('GMAIL_SEND_EMAIL')).toBe('send_email')
    expect(bareActionSlug('SEND_EMAIL')).toBe('send_email')
    expect(bareActionSlug('WEATHER_GET_TODAY')).toBe('get_today')
  })
})
