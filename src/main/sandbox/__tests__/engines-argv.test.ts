// Fase box-container (BX5): gli argv del motore DOCKER restano BYTE-IDENTICI
// a oggi. Ogni metodo dell'interfaccia si confronta con la funzione attuale
// di docker-argv, STESSI input: nessun comportamento Docker deve cambiare
// (BX1.3). Test di guardia: nasce verde e impedisce qualunque deriva.
import { describe, expect, it } from 'vitest'
import { dockerEngine } from '../docker-engine'
import { appleContainerEngine } from '../apple-container-engine'
import * as d from '../docker-argv'

const a = dockerEngine.argv

describe('OBD3: la build chiede --progress plain ESPLICITO a entrambi i motori', () => {
  it('Apple: --progress plain in due token (la forma della CLI di Apple); Docker: --progress=plain', () => {
    expect(appleContainerEngine.argv.build('t', '/df', '/ctx')).toEqual(['build', '--progress', 'plain', '-t', 't', '-f', '/df', '/ctx'])
    expect(a.build('t', '/df', '/ctx')).toEqual(['build', '--progress=plain', '-t', 't', '-f', '/df', '/ctx'])
  })
})

describe('BX5: gli argv del motore Docker sono byte-identici a oggi', () => {
  it('contenitore del box: ps, start, stop, create, rm, inspect, volumi', () => {
    expect(a.ps('sandbot-box')).toEqual(d.dockerPsArgv('sandbot-box'))
    expect(a.start('sandbot-box')).toEqual(d.dockerStartArgv('sandbot-box'))
    expect(a.stop('sandbot-box')).toEqual(d.dockerStopArgv('sandbot-box'))
    expect(a.boxCreate('sandbot-box', 'sandbot-box', 'bridge', d.DEFAULT_BOX_LIMITS, 'img'))
      .toEqual(d.dockerBoxCreateArgv('sandbot-box', 'sandbot-box', 'bridge', d.DEFAULT_BOX_LIMITS, 'img'))
    expect(a.boxCreate('sbtest1-box', 'sbtest1-box', 'none', { memory: '2g', cpus: 1, pids: 512 }, 'img2'))
      .toEqual(d.dockerBoxCreateArgv('sbtest1-box', 'sbtest1-box', 'none', { memory: '2g', cpus: 1, pids: 512 }, 'img2'))
    expect(a.boxRm('c')).toEqual(d.dockerBoxRmArgv('c'))
    expect(a.boxInitCheck!('c')).toEqual(d.dockerBoxInitCheckArgv('c'))
    expect(a.boxMounts!('c')).toEqual(d.dockerBoxMountsArgv('c'))
    expect(a.boxWritable('c')).toEqual(d.dockerBoxWritableArgv('c'))
    expect(a.containerImage!('c')).toEqual(d.dockerContainerImageArgv('c'))
    // BR3 (fase box-rete): la rete DEL box esistente, per decidere se ricreare
    expect(a.containerNetwork!('c')).toEqual(d.dockerContainerNetworkArgv('c'))
    expect(a.ensureHome('c', 'agent_x')).toEqual(d.dockerEnsureHomeArgv('c', 'agent_x'))
    expect(a.imageInspect('t')).toEqual(d.dockerImageInspectArgv('t'))
    expect(a.imageSize('t')).toEqual(d.dockerImageSizeArgv('t'))
    // OBD3: la build chiede --progress plain ESPLICITO — Docker col =
    expect(a.build('t', '/df', '/ctx')).toEqual(d.dockerBuildArgv('t', '/df', '/ctx'))
    expect(a.build('t', '/df', '/ctx')).toEqual(['build', '--progress=plain', '-t', 't', '-f', '/df', '/ctx'])
    expect(a.volumeLs('v')).toEqual(d.dockerVolumeLsArgv('v'))
  })

  it('BR3: networkNameOf — la rete che ogni motore richiede per modalità (Docker i nomi di Docker, Apple le reti di Homun)', () => {
    expect(dockerEngine.networkNameOf('bridge')).toBe('bridge')
    expect(dockerEngine.networkNameOf('none')).toBe('none')
    expect(appleContainerEngine.networkNameOf('bridge')).toBe('homun-box')
    expect(appleContainerEngine.networkNameOf('none')).toBe('homun-box-isolated')
  })

  it('exec: comandi, background, kill di gruppo, stat, MCP stdio', () => {
    expect(a.exec('c', 'echo hi', { workdir: '/w', env: { HOME: '/h', SANDBOT_SECRET_K: 'v' } }))
      .toEqual(d.dockerExecArgv('c', 'echo hi', { workdir: '/w', env: { HOME: '/h', SANDBOT_SECRET_K: 'v' } }))
    const paths = { log: '/l', exit: '/e', pid: '/p' }
    expect(a.execBackground('c', 'build', { workdir: '/w' }, paths))
      .toEqual(d.dockerExecBackgroundArgv('c', 'build', { workdir: '/w' }, paths))
    expect(a.killGroup('c', 42, 'KILL', '1001:1001')).toEqual(d.dockerKillGroupArgv('c', 42, 'KILL', '1001:1001'))
    expect(a.statSize('c', '/box/f')).toEqual(d.dockerStatSizeArgv('c', '/box/f'))
    expect(a.stdioMcp({ workdir: '/w', command: 'npx', args: ['-y', 'x@1'], envKeys: ['K'], home: '/h' }))
      .toEqual(d.dockerStdioMcpArgv({ workdir: '/w', command: 'npx', args: ['-y', 'x@1'], envKeys: ['K'], home: '/h' }))
  })

  it('file del box: read/write/list/realpath/find/b64/test/rmDir/cpFromBox', () => {
    expect(a.readFile('c', '/box/f')).toEqual(d.dockerReadFileArgv('c', '/box/f'))
    expect(a.writeFile('c', '/box/f')).toEqual(d.dockerWriteFileArgv('c', '/box/f'))
    expect(a.listDir('c', '/box')).toEqual(d.dockerListDirArgv('c', '/box'))
    expect(a.realpath('c', '/box/f')).toEqual(d.dockerRealpathArgv('c', '/box/f'))
    expect(a.findList('c', '/box/home/x')).toEqual(d.dockerFindListArgv('c', '/box/home/x'))
    expect(a.readB64('c', '/box/f')).toEqual(d.dockerBoxReadB64Argv('c', '/box/f'))
    expect(a.browserWriteB64('c', '/box/f')).toEqual(d.dockerBrowserWriteB64Argv('c', '/box/f'))
    expect(a.testPath('c', '-f', '/box/f')).toEqual(d.dockerTestPathArgv('c', '-f', '/box/f'))
    expect(a.rmDir('/plugins/p', 'img')).toEqual(d.dockerRmDirArgv('/plugins/p', 'img'))
    expect(a.rmDir('/box/home/x/y', 'img')).toEqual(d.dockerRmDirArgv('/box/home/x/y', 'img'))
    expect(a.cpFromBox('c', '/box/f', '/mac/dest')).toEqual(d.dockerCpFromBoxArgv('c', '/box/f', '/mac/dest'))
  })

  it('plugin e volumi dedicati', () => {
    expect(a.pluginsVolumeCreate()).toEqual(d.dockerPluginsVolumeCreateArgv())
    expect(a.pluginCopyCreate('helper', 'img')).toEqual(d.dockerPluginCopyCreateArgv('helper', 'img'))
    expect(a.pluginsMkdir('img', '/plugins/p')).toEqual(d.dockerPluginsMkdirArgv('img', '/plugins/p'))
    expect(a.pluginCp('/mac/dir', 'helper', '/plugins/p')).toEqual(d.dockerPluginCpArgv('/mac/dir', 'helper', '/plugins/p'))
    expect(a.pluginsChown('img', '/plugins/p')).toEqual(d.dockerPluginsChownArgv('img', '/plugins/p'))
    expect(a.pluginsChmod('img', '/plugins/p')).toEqual(d.dockerPluginsChmodArgv('img', '/plugins/p'))
    expect(a.pluginsRmHelper('helper')).toEqual(d.dockerPluginsRmHelperArgv('helper'))
    expect(a.browserVolumeCreate()).toEqual(d.dockerBrowserVolumeCreateArgv())
    expect(a.browserRoot('img')).toEqual(d.dockerBrowserRootArgv('img'))
  })

  it('browser e desktop: launcher, stato, screenshot, ponte, xdotool', () => {
    expect(a.browserWritable('c')).toEqual(d.dockerBrowserWritableArgv('c'))
    expect(a.browserOldProfileRm('c', 'own')).toEqual(d.dockerBrowserOldProfileRmArgv('c', 'own'))
    // BRB2 (fase browser-riavvio-box): il rm dei lock di un avvio precedente
    // — la UNICA chiave con cui il contratto BX5 cresce in questa fase
    expect(a.browserLocksRm('c', 'own')).toEqual(d.dockerBrowserLocksRmArgv('c', 'own'))
    expect(a.browserMcp('agent_x', 8085)).toEqual(d.dockerBrowserMcpArgv('agent_x', 8085))
    expect(a.browserMcp('agent_x', 8085, { child: true, owner: 'own' }))
      .toEqual(d.dockerBrowserMcpArgv('agent_x', 8085, { child: true, owner: 'own' }))
    expect(a.browserReadFile('c', '/browser/f')).toEqual(d.dockerBrowserReadFileArgv('c', '/browser/f'))
    expect(a.browserReadB64('c', '/browser/f')).toEqual(d.dockerBrowserReadB64Argv('c', '/browser/f'))
    expect(a.browserRmFile('c', '/browser/f')).toEqual(d.dockerBrowserRmFileArgv('c', '/browser/f'))
    expect(a.screenControlVnc('own', ':0')).toEqual(d.dockerScreenControlVncArgv('own', ':0'))
    expect(a.screenControlPidRead('c', 'own')).toEqual(d.dockerScreenControlPidReadArgv('c', 'own'))
    expect(a.screenSocketReady('c', '/browser/own/s.sock')).toEqual(d.dockerScreenSocketReadyArgv('c', '/browser/own/s.sock'))
    expect(a.screenDisplayRead('c', 'own')).toEqual(d.dockerScreenDisplayReadArgv('c', 'own'))
    expect(a.screenBridge('/browser/own/s.sock')).toEqual(d.dockerScreenBridgeArgv('/browser/own/s.sock'))
    expect(a.xdotool(':0', './Xauthority', ['mousemove', '10', '20'])).toEqual(d.dockerXdotoolArgv(':0', './Xauthority', ['mousemove', '10', '20']))
    expect(a.screenCapture(':0', './Xauthority', 'own', 'shot.png')).toEqual(d.dockerScreenCaptureArgv(':0', './Xauthority', 'own', 'shot.png'))
    expect(a.screenGeometry(':0', './Xauthority')).toEqual(d.dockerScreenGeometryArgv(':0', './Xauthority'))
  })

  it('terminale, migrazione, spazio su disco', () => {
    expect(a.terminal('own')).toEqual(d.dockerTerminalArgv('own'))
    expect(a.termPidList('c', 'own')).toEqual(d.dockerTermPidListArgv('c', 'own'))
    expect(a.termPidClean('c', 'own')).toEqual(d.dockerTermPidCleanArgv('c', 'own'))
    expect(a.boxChown('v', 'img')).toEqual(d.dockerBoxChownArgv('v', 'img'))
    expect(a.boxMigrate('sandbot-x-box', 'x', 'img')).toEqual(d.dockerBoxMigrateArgv('sandbot-x-box', 'x', 'img'))
    expect(a.boxMarkerCheck('img')).toEqual(d.dockerBoxMarkerCheckArgv('img'))
    expect(a.boxMarkerWrite('img')).toEqual(d.dockerBoxMarkerWriteArgv('img'))
    expect(a.df()).toEqual(d.dockerDfArgv())
    expect(a.pruneSafe()).toEqual(d.dockerPruneSafeArgv())
    expect(a.removeImage('sandbot-box:abc')).toEqual(d.dockerRemoveImageArgv('sandbot-box:abc'))
    expect(a.removeVolumes(['sandbot-box'])).toEqual(d.dockerRemoveVolumesArgv(['sandbot-box']))
  })

  it('il motore espone TUTTE le operazioni dell\'interfaccia (nessun metodo mancante)', () => {
    const missing = Object.entries(a).filter(([, v]) => typeof v !== 'function').map(([k]) => k)
    expect(missing).toEqual([])
    // l'elenco dei nomi dell'interfaccia BoxEngineArgv, letterale: se una
    // operazione si aggiunge, questo elenco la pretende sul motore
    const OPS = [
      'ps', 'start', 'stop', 'boxCreate', 'boxRm', 'boxInitCheck', 'boxMounts', 'boxWritable', 'containerImage',
      'containerNetwork',
      'ensureHome', 'imageInspect', 'imageSize', 'build', 'volumeLs',
      'exec', 'execBackground', 'killGroup', 'statSize', 'stdioMcp',
      'readFile', 'writeFile', 'listDir', 'realpath', 'findList', 'readB64', 'testPath', 'rmDir', 'cpFromBox',
      'pluginsVolumeCreate', 'pluginCopyCreate', 'pluginsMkdir', 'pluginCp', 'pluginsChown', 'pluginsChmod', 'pluginsRmHelper',
      'browserVolumeCreate', 'browserRoot', 'browserWritable', 'browserOldProfileRm', 'browserLocksRm', 'browserMcp', 'browserReadFile',
      'browserReadB64', 'browserWriteB64', 'browserRmFile',
      'screenControlVnc', 'screenControlPidRead', 'screenSocketReady', 'screenDisplayRead', 'screenBridge', 'xdotool',
      'screenCapture', 'screenGeometry',
      'terminal', 'termPidList', 'termPidClean',
      'boxChown', 'boxMigrate', 'boxMarkerCheck', 'boxMarkerWrite',
      'df', 'pruneSafe', 'removeImage', 'removeVolumes'
    ] as const
    for (const op of OPS) expect(typeof a[op]).toBe('function')
    expect(Object.keys(a).length).toBe(OPS.length)
  })
})
