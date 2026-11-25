// C1 (fase linguaggio): il rendering di Icon — l'icona lucide alla misura
// dei token, scritta dal pezzo.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { Plus, Settings } from 'lucide-react'
import { renderHtml, parseHtml, findAll } from './render-helper'
import { Icon } from '../components/ui/icon'

const svgOf = (props: Record<string, unknown>) => {
  const tree = parseHtml(renderHtml(createElement(Icon, props as never)))
  return findAll(tree, (n) => n.tag === 'svg')[0]!
}

describe('C1: Icon — solo lucide, la misura scritta dal pezzo', () => {
  it('sm (default) è 16 px (size-4), lg è 20 px (size-5): mai i 24 di fabbrica', () => {
    expect((svgOf({ icon: Plus }).attrs.class ?? '').split(/\s+/)).toContain('size-4')
    expect((svgOf({ icon: Plus, size: 'lg' }).attrs.class ?? '').split(/\s+/)).toContain('size-5')
    expect((svgOf({ icon: Settings }).attrs.class ?? '')).not.toContain('size-6')
  })

  it('è aria-hidden di default (l\'etichetta accessibile sta nel bottone che la porta)', () => {
    expect(svgOf({ icon: Plus }).attrs['aria-hidden']).toBe('true')
  })
})
