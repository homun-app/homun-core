// Fase rilascio (A7): docker e git si trovano anche fuori dal Terminale (il
// PATH di Finder/launchd è /usr/bin:/bin:/usr/sbin:/sbin). Test della parte
// PURA: l'ordine dei candidati, la scelta del primo eseguibile e il default
// di DOCKER_HOST per il socket di Docker Desktop.
import { describe, expect, it } from 'vitest'
import { dockerCandidatePaths, gitCandidatePaths, pickExecutable, dockerHostDefault, invalidateToolCache, resolveTool, DOCKER_INSTALL_URL } from '../tool-paths'

const HOME = '/Users/fabio'
const fsProbe = (existing: string[]): ((p: string) => boolean) => (p) => existing.includes(p)

describe('fase rilascio (A7): candidati di docker, in ordine', () => {
  it('env esplicita → PATH → /usr/local/bin → /opt/homebrew/bin → ~/.docker/bin → Docker.app', () => {
    const paths = dockerCandidatePaths({ HOMUN_DOCKER_PATH: '/custom/docker', PATH: '/usr/bin:/bin' }, HOME)
    expect(paths[0]).toBe('/custom/docker')
    expect(paths[1]).toBe('/usr/bin/docker')
    expect(paths[2]).toBe('/bin/docker')
    expect(paths).toContain('/usr/local/bin/docker')
    expect(paths).toContain('/opt/homebrew/bin/docker')
    expect(paths).toContain(`${HOME}/.docker/bin/docker`)
    expect(paths).toContain('/Applications/Docker.app/Contents/Resources/bin/docker')
    // il vincitore è il PRIMO eseguibile
    expect(pickExecutable(paths, fsProbe(['/bin/docker']))).toBe('/bin/docker')
    expect(pickExecutable(paths, fsProbe(['/opt/homebrew/bin/docker', '/usr/bin/docker']))).toBe('/usr/bin/docker')
  })

  it('senza env né PATH restano i posti noti, senza doppioni', () => {
    const paths = dockerCandidatePaths({}, HOME)
    expect(paths[0]).toBe('/usr/local/bin/docker')
    expect(new Set(paths).size).toBe(paths.length)
  })
})

describe('fase rilascio (A7): candidati di git, in ordine', () => {
  it('env → PATH → /usr/bin/git (Xcode CLT) → homebrew', () => {
    const paths = gitCandidatePaths({ HOMUN_GIT_PATH: '/x/git', PATH: '/usr/bin' }, HOME)
    expect(paths[0]).toBe('/x/git')
    expect(paths[1]).toBe('/usr/bin/git')
    expect(paths).toContain('/opt/homebrew/bin/git')
    expect(paths).toContain('/usr/local/bin/git')
    expect(pickExecutable(paths, fsProbe(['/usr/bin/git']))).toBe('/usr/bin/git')
  })
})

describe('fase rilascio (A7): pickExecutable accetta solo file che esistono', () => {
  it('null quando nessun candidato è eseguibile', () => {
    expect(pickExecutable(['/a/docker', '/b/docker'], fsProbe([]))).toBeNull()
  })
})

describe('fase rilascio (A7): DOCKER_HOST per i figli (puro)', () => {
  it('DOCKER_HOST già decisa dall\'utente → non si tocca', () => {
    expect(dockerHostDefault({ DOCKER_HOST: 'unix:///x' }, HOME, false, false)).toBeUndefined()
  })

  it('socket standard presente → il default del CLI va bene', () => {
    expect(dockerHostDefault({}, HOME, true, false)).toBeUndefined()
  })

  it('nessun socket standard, c\'è quello di Docker Desktop → si passa il suo percorso', () => {
    expect(dockerHostDefault({}, HOME, false, true)).toBe(`unix://${HOME}/.docker/run/docker.sock`)
  })

  it('niente di niente → nessun default (Docker proprio non c\'è)', () => {
    expect(dockerHostDefault({}, HOME, false, false)).toBeUndefined()
  })
})

describe('fase rilascio (A7): cache di resolveTool', () => {
  it('il link di Docker Desktop è quello ufficiale', () => {
    expect(DOCKER_INSTALL_URL).toBe('https://www.docker.com/products/docker-desktop/')
  })

  it('resolveTool torna un percorso (o il nome semplice come limite inferiore) e la cache si azzera', () => {
    invalidateToolCache()
    const docker = resolveTool('docker')
    expect(typeof docker).toBe('string')
    // dove Docker non c'è (la CI) resta il nome semplice: il limite inferiore
    expect(docker === 'docker' || docker.startsWith('/')).toBe(true)
    invalidateToolCache()
    const git = resolveTool('git')
    expect(git.length).toBeGreaterThan('git'.length)
  })
})
