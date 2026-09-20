const { contextBridge } = require('electron');
// No token, Node, arbitrary IPC or filesystem operation is exposed.
contextBridge.exposeInMainWorld('homunDesktop', Object.freeze({ engineBaseUrl: 'homun://app/engine' }));
