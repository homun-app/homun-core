import { describe, it, expect } from 'vitest'
import { composioRouteFor } from '../connector-route'

// la card di collegamento del bot segue la strada della finestra App
// (catalogo vero: Gmail è una curata static con il marchio anche su Composio)
describe('composioRouteFor — la strada della card di collegamento', () => {
  it('Gmail diretto senza client OAuth → strada Composio (apps:connect)', () => {
    expect(composioRouteFor('gmail', [{ id: 'gmail' }])).toEqual({ appId: 'gmail', composioSlug: 'gmail' })
  })

  it('Gmail diretto CON il client OAuth salvato → strada diretta (null)', () => {
    expect(composioRouteFor('gmail', [{ id: 'gmail', hasStaticCredentials: true }])).toBeNull()
  })

  it('Google Calendar senza client → lo slug Composio del marchio (googlecalendar)', () => {
    expect(composioRouteFor('gcalendar', [])).toMatchObject({ composioSlug: 'googlecalendar' })
  })

  it('una curata dynamic resta diretta', () => {
    expect(composioRouteFor('notion', [])).toBeNull()
  })

  it('le card già Composio o del gateway non si toccano', () => {
    expect(composioRouteFor('composio:gmail', [])).toBeNull()
    expect(composioRouteFor('composio-app:gmail', [])).toBeNull()
    expect(composioRouteFor(undefined, [])).toBeNull()
  })

  it('una static senza marchio Composio resta diretta (la card dirà il motivo)', () => {
    const rows = [{ id: 'x', name: 'X', description: null, tagline: null, category: 'other' as const, logo: null, via: 'direct' as const, directId: 'x', featured: false, rank: 0 }]
    expect(composioRouteFor('x', [], rows)).toBeNull()
  })
})
