// C1 (fase linguaggio): il rendering di Field — etichetta · campo · aiuto · errore.
import './render-helper-install'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderHtml, parseHtml, findAll, textOf } from './render-helper'
import { Field } from '../components/ui/field'
import { Input } from '../components/ui/input'

const rootOf = (props: Record<string, unknown>) => {
  const tree = parseHtml(renderHtml(createElement(Field, { testId: 'field-prova', ...props } as never)))
  return findAll(tree, (n) => n.attrs['data-testid'] === 'field-prova')[0]!
}

describe('C1: Field — etichetta, campo, aiuto, errore', () => {
  it('l\'etichetta è text-small grigia e collegata al campo (htmlFor)', () => {
    const root = rootOf({ label: 'Il nome', htmlFor: 'campo-nome', children: createElement(Input, { id: 'campo-nome' }) })
    const label = findAll(root, (n) => n.tag === 'label')[0]!
    expect(textOf(label)).toBe('Il nome')
    expect(label.attrs.for).toBe('campo-nome')
    expect(label.attrs.class).toContain('text-small')
  })

  it('l\'aiuto sta sotto il campo, grigio — finché NON c\'è l\'errore', () => {
    const conAiuto = rootOf({ label: 'x', children: 'c', aiuto: 'serve per le ricerche' })
    expect(textOf(conAiuto)).toContain('serve per le ricerche')
    const conErrore = rootOf({ label: 'x', children: 'c', aiuto: 'serve per le ricerche', errore: 'troppo corto' })
    expect(textOf(conErrore)).not.toContain('serve per le ricerche')
  })

  it('l\'errore è in parole, nel colore del distruttivo, con ruolo alert', () => {
    const root = rootOf({ label: 'x', children: 'c', errore: 'troppo corto' })
    const alert = findAll(root, (n) => n.attrs.role === 'alert')[0]!
    expect(textOf(alert)).toBe('troppo corto')
    expect(alert.attrs.class).toContain('text-destructive')
  })
})
