const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("blogAuto", {
  getInitialData: () => ipcRenderer.invoke("app:getInitialData"),
  openChromeInstallAndQuit: () => ipcRenderer.invoke("chrome:installAndQuit"),
  refreshCodexUsage: () => ipcRenderer.invoke("codex:refreshUsage"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  saveAccountStore: (store) => ipcRenderer.invoke("accounts:save", store),
  chooseAccountSampleImage: (accountId) => ipcRenderer.invoke("accounts:chooseSampleImage", accountId),
  deleteAccountSampleImage: (accountId) => ipcRenderer.invoke("accounts:deleteSampleImage", accountId),
  checkAccountSession: (accountId, options) => ipcRenderer.invoke("accounts:checkSession", accountId, options),
  checkTistorySession: (tistoryBlogId) => ipcRenderer.invoke("tistory:checkSession", tistoryBlogId),
  testTistoryPublish: (form) => ipcRenderer.invoke("tistory:testPublish", form),
  loadHistory: () => ipcRenderer.invoke("history:load"),
  startJob: (form) => ipcRenderer.invoke("job:start", form),
  openRuntimeFolder: () => ipcRenderer.invoke("runtime:open"),
  openFile: (filePath) => ipcRenderer.invoke("file:open", filePath),
  showFileInFolder: (filePath) => ipcRenderer.invoke("file:showInFolder", filePath),
  onLog: (handler) => {
    ipcRenderer.on("job:log", (_event, payload) => handler(payload));
  },
  onStatus: (handler) => {
    ipcRenderer.on("job:status", (_event, payload) => handler(payload));
  },
  onTokens: (handler) => {
    ipcRenderer.on("job:tokens", (_event, payload) => handler(payload));
  },
  onPreview: (handler) => {
    ipcRenderer.on("job:preview", (_event, payload) => handler(payload));
  },
  onSelectedTitle: (handler) => {
    ipcRenderer.on("job:selectedTitle", (_event, payload) => handler(payload));
  },
  onComplete: (handler) => {
    ipcRenderer.on("job:complete", (_event, payload) => handler(payload));
  },
  onAccountsUpdate: (handler) => {
    ipcRenderer.on("accounts:update", (_event, payload) => handler(payload));
  }
});
