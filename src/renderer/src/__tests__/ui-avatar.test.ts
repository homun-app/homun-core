// C1 (fase linguaggio): il rendering di Avatar — la mascotte VERA (bot/Bot),
// con le misure chiuse del catalogo. La demo della galleria di
// fondamenta-galleria disegnava un cerchio qualsiasi al posto delle famiglie:
// qui si chiede che il pezzo renda il disegno vero, cinque famiglie distinte.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderHtml, parseHtml, findAll } from './render-helper'
import { Avatar } from '../components/ui/avatar'
import { BOT_FAMILIES } from '../../../shared/avatar'

const htmlOf = (props: Record<string, unknown>) => renderHtml(createElement(Avatar, props as never))

describe('C1: Avatar — la mascotte vera, alle misure del catalogo', () => {
  it('rende il disegno del bot (il pezzo avvolge bot/Bot, non ridisegna)', () => {
    const tree = parseHtml(htmlOf({ family: 'h-creature', color: 'c1' }))
    expect(findAll(tree, (n) => n.tag === 'svg').length).toBeGreaterThan(0)
  })

  it('le CINQUE famiglie si DISTINGUONO: ciascuna rende un disegno suo (il difetto della demo di galleria)', () => {
    const disegni = BOT_FAMILIES.map((f) => htmlOf({ family: f, color: 'c1' }))
    // lo stesso markup non si ripete: i path (e le forme) delle famiglie differiscono
    const unici = new Set(disegni.map((h) => h.replace(/\s+/g, ' ')))
    expect([...unici]).toHaveLength(disegni.length)
  })

  it('le misure sono una variante chiusa: sm 20 · md 32 (default) · lg 40 · xl 64', () => {
    expect(htmlOf({ family: 'jelly', color: 'c2' })).toContain('width="32"')
    expect(htmlOf({ family: 'jelly', color: 'c2', size: 'sm' })).toContain('width="20"')
    expect(htmlOf({ family: 'jelly', color: 'c2', size: 'lg' })).toContain('width="40"')
    expect(htmlOf({ family: 'jelly', color: 'c2', size: 'xl' })).toContain('width="64"')
  })
})
