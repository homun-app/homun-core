// C1 (fase linguaggio): il rendering di BotDot — il puntino del colore del
// bot, con la palette --bot-dot-*.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderHtml, parseHtml, findAll } from './render-helper'
import { BotDot } from '../components/ui/bot-dot'

const dotOf = (props: Record<string, unknown>) => {
  const tree = parseHtml(renderHtml(createElement(BotDot, { testId: 'dot-prova', ...props } as never)))
  return findAll(tree, (n) => n.attrs['data-testid'] === 'dot-prova')[0]!
}

describe('C1: BotDot — il puntino del colore del bot', () => {
  it('è un cerchio di 8 px (size-2) che NON si restringe', () => {
    const c = (dotOf({ color: 'c1' }).attrs.class ?? '').split(/\s+/)
    for (const k of ['size-2', 'shrink-0', 'rounded-full']) expect(c).toContain(k)
  })

  it('la tinta è la palette DEI PUNTINI (--bot-dot-*), mai quella della mascotte', () => {
    expect(dotOf({ color: 'c3' }).attrs.style).toContain('var(--bot-dot-c3)')
    expect(dotOf({ color: 'c7' }).attrs.style).not.toContain('var(--bot-c7)')
  })

  it('è aria-hidden: il colore non è informazione da screen reader (sta nel nome)', () => {
    expect(dotOf({ color: 'c1' }).attrs['aria-hidden']).toBe('true')
  })
})
