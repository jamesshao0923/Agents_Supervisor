const { contextBridge, ipcRenderer } = require('electron');
// Deliberately expose named operations, never arbitrary IPC or filesystem access.
contextBridge.exposeInMainWorld('supervisor', Object.freeze({
  health: () => ipcRenderer.invoke('supervisor:health'),
  list: () => ipcRenderer.invoke('supervisor:list'),
  inspect: executionId => ipcRenderer.invoke('supervisor:inspect', executionId),
  events: (executionId, after) => ipcRenderer.invoke('supervisor:events', executionId, after),
  capabilities: () => ipcRenderer.invoke('supervisor:capabilities'),
  start: input => ipcRenderer.invoke('supervisor:start', input),
  cancel: executionId => ipcRenderer.invoke('supervisor:cancel', executionId),
  reconcile: executionId => ipcRenderer.invoke('supervisor:reconcile', executionId),
  chooseWorkspace: () => ipcRenderer.invoke('supervisor:choose-workspace'),
  chooseImages: () => ipcRenderer.invoke('supervisor:choose-images')
}));
