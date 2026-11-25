// C1 (fase linguaggio): il rendering di Switch — l'interruttore di
// acceso/spento, con le misure di sempre.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderHtml, parseHtml, findAll } from './render-helper'
import { Switch } from '../components/ui/switch'

const swOf = (props: Record<string, unknown>) => {
  const tree = parseHtml(renderHtml(createElement(Switch, { label: 'Attivo', ...props } as never)))
  return findAll(tree, (n) => n.attrs.role === 'switch')[0]!
}

describe('C1: Switch — acceso/spento, nient\'altro', () => {
  it('è un interruttore accessibile: role switch, aria-checked, il nome in aria-label', () => {
    const sw = swOf({ checked: true, onChange: () => undefined })
    expect(sw.attrs.role).toBe('switch')
    expect(sw.attrs['aria-checked']).toBe('true')
    expect(sw.attrs['aria-label']).toBe('Attivo')
  })

  it('il bersaglio è alto 32 (h-control-sm), la pista 24 dentro (inset-y-1), la pallina 20 (size-5)', () => {
    const sw = swOf({ checked: false, onChange: () => undefined })
    expect((sw.attrs.class ?? '').split(/\s+/)).toContain('h-control-sm')
    const pista = findAll(sw, (n) => (n.attrs.class ?? '').includes('inset-y-1'))[0]!
    expect(pista).toBeTruthy()
    const pallina = findAll(sw, (n) => (n.attrs.class ?? '').includes('size-5'))[0]!
    expect(pallina).toBeTruthy()
  })

  it('spento la pista è grigia tenue, acceso in primo piano', () => {
    const off = findAll(swOf({ checked: false, onChange: () => undefined }), (n) => (n.attrs.class ?? '').includes('inset-y-1'))[0]!
    const on = findAll(swOf({ checked: true, onChange: () => undefined }), (n) => (n.attrs.class ?? '').includes('inset-y-1'))[0]!
    expect(off.attrs.class).toContain('bg-muted-foreground/30')
    expect(on.attrs.class).toContain('bg-foreground')
  })
})
