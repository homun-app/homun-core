// OBV1 (fase onboarding-b-dal-vivo): le USCITE VERE di `container system
// status` della 1.7.1, copiate alla lettera dalla prova dal vivo del
// 2026-11-13 — con UNA sola sostituzione consentita dalla spec: l'appRoot è
// NEUTRO (/Users/test/…), mai il nome dell'utente vero. Le usano i test del
// parse, della sonda dei fatti e della CLI finta (che le stampa identiche).
// Non è una suite: è una fixture condivisa (come le altre delle __tests__).

/** L'appRoot neutro delle fixture (spec OBV: mai l'utente vero). */
export const NEUTRAL_APP_ROOT = '/Users/test/Library/Application Support/com.apple.container/'

/** `container system status --format json` (1.7.1, una riga sola com'è vera). */
export const SYSTEM_STATUS_JSON =
  '{"client":{"appName":"container","build":"release","commit":"a15b46097aa4c2325da13c1fb5192b9274aab083","version":"1.7.1"},"host":{"architecture":"arm64","cpus":10,"operatingSystem":"Version 27.2.1 (Build 26B131)"},"paths":{"appRoot":"' +
  NEUTRAL_APP_ROOT +
  '","installRoot":"/usr/local/"},"resources":{"containersRunning":0,"containersTotal":0,"images":0},"server":{"appName":"container-apiserver","build":"release","commit":"a15b46097aa4c2325da13c1fb5192b9274aab083","version":"1.7.1"},"status":"running"}'

/** `container system status`, il formato di default (la TABELLA vera, senza separatori). */
export const SYSTEM_STATUS_TABLE = [
  'FIELD               VALUE',
  'status              running',
  'client.version      1.7.1',
  'client.build        release',
  'client.commit       a15b46097aa4c2325da13c1fb5192b9274aab083',
  'host.os             Version 27.2.1 (Build 26B131)',
  'host.architecture   arm64',
  'host.cpus           10',
  'server.version      1.7.1',
  'server.build        release',
  'server.commit       a15b46097aa4c2325da13c1fb5192b9274aab083',
  'server.appName      container-apiserver',
  'paths.appRoot       ' + NEUTRAL_APP_ROOT,
  'paths.installRoot   /usr/local/',
  'paths.logRoot       ',
  'containers.total    0',
  'containers.running  0',
  'images.total        0'
].join('\n')

/** Il kernel dopo `kernel set --recommended` (il symlink e il suo bersaglio). */
export const KERNEL_LINK_NAME = 'default.kernel-arm64'
export const KERNEL_TARGET_NAME = 'vmlinux-6.18.56-208-debug'
/** I byte veri del bersaglio (30 564 864): la dimensione la legge il FILE. */
export const KERNEL_TARGET_BYTES = 30_564_864
