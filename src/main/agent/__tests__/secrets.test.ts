import { describe, expect, it } from 'vitest'
import { resolveSecretRefs, redactSecrets, secretEnvName } from '../secrets'

const VALUE = 'SK-1234-SEGRETO-MOLTO-LUNGO'
const reveal = async (name: string) => {
  if (name === 'API_KEY' || name === 'API_TOKEN') return name === 'API_KEY' ? VALUE : 'tok-9876'
  throw new Error(`credenziale "${name}" non presente nel vault`)
}

describe('secretEnvName', () => {
  it('NOME → SANDBOT_SECRET_NOME con sanitizzazione', () => {
    expect(secretEnvName('API_KEY')).toBe('SANDBOT_SECRET_API_KEY')
    expect(secretEnvName('db.password-2')).toBe('SANDBOT_SECRET_DB_PASSWORD_2')
  })
})

describe('resolveSecretRefs (§5.6)', () => {
  it('riscrive il comando sulla variabile d’ambiente: nessun valore e nessun ref residui', async () => {
    const r = await resolveSecretRefs('curl -H "Authorization: Bearer {{secret:API_KEY}}" https://x', reveal)
    expect(r.command).toBe('curl -H "Authorization: Bearer $SANDBOT_SECRET_API_KEY" https://x')
    expect(r.command).not.toContain(VALUE)
    expect(r.command).not.toContain('{{secret:')
    expect(r.env.SANDBOT_SECRET_API_KEY).toBe(VALUE)
    expect(r.missing).toEqual([])
  })

  it('più riferimenti (anche ripetuti) → una env per nome', async () => {
    const r = await resolveSecretRefs('echo {{secret:API_KEY}} {{secret:API_TOKEN}} {{secret:API_KEY}}', reveal)
    expect(r.command).toBe('echo $SANDBOT_SECRET_API_KEY $SANDBOT_SECRET_API_TOKEN $SANDBOT_SECRET_API_KEY')
    expect(Object.keys(r.env).sort()).toEqual(['SANDBOT_SECRET_API_KEY', 'SANDBOT_SECRET_API_TOKEN'])
    expect(r.used).toHaveLength(2)
  })

  it('nome inesistente → missing, il comando non parte col valore sbagliato', async () => {
    const r = await resolveSecretRefs('echo {{secret:NON_C_E}}', reveal)
    expect(r.missing).toEqual(['NON_C_E'])
    expect(r.env).toEqual({})
  })

  it('comando senza riferimenti resta identico', async () => {
    const r = await resolveSecretRefs('ls -la', reveal)
    expect(r.command).toBe('ls -la')
    expect(r.used).toEqual([])
  })
})

describe('redactSecrets', () => {
  it('sostituisce ogni occorrenza del valore, anche ripetuta e dentro stderr', () => {
    const used = [{ name: 'API_KEY', envName: 'SANDBOT_SECRET_API_KEY', value: VALUE }]
    const text = `header Bearer ${VALUE}\nseconda riga con ${VALUE} e ${VALUE}`
    expect(redactSecrets(text, used)).toBe(
      `header Bearer [redacted:API_KEY]\nseconda riga con [redacted:API_KEY] e [redacted:API_KEY]`
    )
  })

  it('valori multipli vengono tutti redatti', () => {
    const used = [
      { name: 'A', envName: 'X_A', value: 'aaa' },
      { name: 'B', envName: 'X_B', value: 'bbb' }
    ]
    expect(redactSecrets('aaa e bbb', used)).toBe('[redacted:A] e [redacted:B]')
  })
})
