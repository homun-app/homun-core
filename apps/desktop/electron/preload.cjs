const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("localFirstDesktop", {
  gatewayUrl: process.env.LOCAL_FIRST_DESKTOP_GATEWAY_URL ?? "http://127.0.0.1:18765",
  gatewayToken: process.env.LOCAL_FIRST_DESKTOP_GATEWAY_TOKEN ?? "",
  // Opens a native directory picker; resolves to the chosen path or null.
  pickFolder: () => ipcRenderer.invoke("lfpa:pick-folder"),
});
