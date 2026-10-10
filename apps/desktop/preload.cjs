const { contextBridge, ipcRenderer } = require('electron');
// Deliberately expose named operations, never arbitrary IPC or filesystem access.
contextBridge.exposeInMainWorld('supervisor', Object.freeze({
  health: () => ipcRenderer.invoke('supervisor:health'),
  runtimeList: () => ipcRenderer.invoke('supervisor:runtime-list'),
  runtimeInspect: runtimeId => ipcRenderer.invoke('supervisor:runtime-inspect', runtimeId),
  runtimeEvents: (runtimeId, after) => ipcRenderer.invoke('supervisor:runtime-events', runtimeId, after),
  runtimeSubmit: input => ipcRenderer.invoke('supervisor:runtime-submit', input),
  runtimePause: (runtimeId, commandId) => ipcRenderer.invoke('supervisor:runtime-pause', runtimeId, commandId),
  runtimeResume: (runtimeId, commandId) => ipcRenderer.invoke('supervisor:runtime-resume', runtimeId, commandId),
  runtimeCancel: (runtimeId, commandId) => ipcRenderer.invoke('supervisor:runtime-cancel', runtimeId, commandId),
  runtimeReconcile: (runtimeId, commandId) => ipcRenderer.invoke('supervisor:runtime-reconcile', runtimeId, commandId),
  runtimeInput: (runtimeId, commandId, stepId, text) => ipcRenderer.invoke('supervisor:runtime-input', runtimeId, commandId, stepId, text),
  list: () => ipcRenderer.invoke('supervisor:list'),
  inspect: executionId => ipcRenderer.invoke('supervisor:inspect', executionId),
  events: (executionId, after) => ipcRenderer.invoke('supervisor:events', executionId, after),
  capabilities: () => ipcRenderer.invoke('supervisor:capabilities'),
  start: input => ipcRenderer.invoke('supervisor:start', input),
  cancel: executionId => ipcRenderer.invoke('supervisor:cancel', executionId),
  reconcile: executionId => ipcRenderer.invoke('supervisor:reconcile', executionId),
  chooseWorkspace: () => ipcRenderer.invoke('supervisor:choose-workspace'),
  openWorkspace: id => ipcRenderer.invoke('supervisor:open-workspace', id),
  chooseImages: () => ipcRenderer.invoke('supervisor:choose-images')
}));
