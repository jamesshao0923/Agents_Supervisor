const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const { stat, realpath } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');

// This process is only a client. The launcher owns the independent backend.
const dataIndex = process.argv.indexOf('--data');
const dataDir = resolve(dataIndex >= 0 && process.argv[dataIndex + 1] ? process.argv[dataIndex + 1] : '.supervisor');
const documentPath = join(__dirname, 'index.html');
const documentURL = pathToFileURL(documentPath).href;
let window;
let request;
let parseOrchestrationAction;
let parseConversationAction;
let parseSupervisionAction;

function assertSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== documentURL) {
    throw new Error('Untrusted desktop IPC sender');
  }
}
function id(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || value.includes('\0')) throw new Error('Invalid execution identifier');
  return value;
}
async function invoke(value) {
  const response = await request(dataDir, { id: randomUUID(), ...value });
  if (!response.ok) throw new Error(response.error);
  return response.value;
}
function execution(action) { return invoke({ method: 'execution', action }); }
function runtime(action) { return invoke({ method: 'runtime', action }); }
function verification(action) { return invoke({ method: 'verification', action }); }
function orchestration(action) { return invoke({ method: 'orchestration', action: parseOrchestrationAction(action) }); }
function conversation(action) { return invoke({ method: 'conversation', action: parseConversationAction(action) }); }
function supervision(action) { return invoke({ method: 'supervision', action: parseSupervisionAction(action) }); }
function reviewConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['model', 'effort', 'reservation', 'timeoutMs'].includes(key))) throw new Error('Invalid verification model configuration');
  if (!Number.isSafeInteger(value.reservation) || value.reservation < 1 || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 3600000) throw new Error('Invalid verification reservation or timeout');
  return { model: id(value.model), effort: id(value.effort), reservation: value.reservation, timeoutMs: value.timeoutMs };
}
function register(channel, handler) {
  ipcMain.handle(`supervisor:${channel}`, (event, ...args) => { assertSender(event); return handler(...args); });
}
function installBridge() {
  register('health', () => invoke({ method: 'health' }));
  register('supervision-list', () => supervision({ type: 'list' }));
  register('supervision-attach', input => { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.hasOwn(input, 'type')) throw new Error('Invalid supervision input');return supervision({type:'attach',...input}); });
  for(const type of ['pause','resume','stop'])register(`supervision-${type}`,loopId=>supervision({type,loopId:id(loopId)}));
  register('conversation-list', () => conversation({ type: 'list' }));
  register('conversation-for-session', sessionId => conversation({ type: 'forSession', sessionId: id(sessionId) }));
  register('conversation-inspect', conversationId => conversation({ type: 'inspect', conversationId: id(conversationId) }));
  for (const type of ['send', 'retry', 'cancelAssessment']) register(`conversation-${type}`, input => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.hasOwn(input, 'type')) throw new Error('Invalid conversation input');
    return conversation({ type, ...input });
  });
  register('orchestration-list', () => orchestration({ type: 'list' }));
  register('orchestration-inspect', sessionId => orchestration({ type: 'inspect', sessionId: id(sessionId) }));
  register('orchestration-start', async input => {
    let action;
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.hasOwn(input, 'type')) throw new Error('Invalid goal input');
      action = parseOrchestrationAction({ type: 'start', ...input });
    } catch (error) { return { accepted: false, error: String(error) }; }
    const response = await request(dataDir, { id: randomUUID(), method: 'orchestration', action });
    return response.ok ? { accepted: true, record: response.value } : { accepted: false, error: response.error };
  });
  for (const type of ['answer', 'admit', 'restore', 'cancel']) register(`orchestration-${type}`, input => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.hasOwn(input, 'type')) throw new Error('Invalid goal action');
    return orchestration({ type, ...input });
  });
  register('workbench-read', projectPath => { if(typeof projectPath!=='string'||!projectPath.startsWith('/')||projectPath.length>4096||projectPath.includes('\0'))throw new Error('Invalid workbench project path');return invoke({method:'workbench',action:{type:'read',projectPath}}); });
  register('runtime-list', () => runtime({ type: 'list' }));
  register('runtime-inspect', runtimeId => runtime({ type: 'inspect', runtimeId: id(runtimeId) }));
  register('runtime-events', (runtimeId, after) => {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid runtime event cursor');
    return runtime({ type: 'events', runtimeId: id(runtimeId), after });
  });
  register('runtime-submit', async input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { accepted: false, error: 'Invalid durable task input' };
    const keys = ['commandId', 'workspace', 'goal', 'tokenLimit', 'verificationReserve', 'steps'];
    if (Object.keys(input).some(key => !keys.includes(key))) return { accepted: false, error: 'Unknown durable task input field' };
    const action = { type: 'submit' };
    for (const key of keys) if (input[key] !== undefined) action[key] = input[key];
    const response = await request(dataDir, { id: randomUUID(), method: 'runtime', action });
    return response.ok ? { accepted: true, record: response.value } : { accepted: false, error: response.error };
  });
  for (const type of ['pause', 'resume', 'cancel', 'reconcile']) register(`runtime-${type}`, (runtimeId, commandId) => runtime({ type, runtimeId: id(runtimeId), commandId: id(commandId) }));
  register('runtime-input', (runtimeId, commandId, stepId, text) => {
    if (typeof text !== 'string' || !text.trim() || text.length > 200000 || text.includes('\0')) throw new Error('Invalid runtime input');
    return runtime({ type: 'input', runtimeId: id(runtimeId), commandId: id(commandId), stepId: id(stepId), text });
  });
  register('verification-status', runtimeId => verification({ type: 'status', runtimeId: id(runtimeId) }));
  register('verification-propose', (runtimeId, commandId, specPath) => {
    if (typeof specPath !== 'string' || !specPath.startsWith('/') || specPath.length > 4096 || specPath.includes('\0')) throw new Error('Invalid verification spec path');
    return verification({ type: 'propose', runtimeId: id(runtimeId), commandId: id(commandId), specPath });
  });
  register('verification-review', (proposalId, commandId, config) => verification({ type: 'review', proposalId: id(proposalId), commandId: id(commandId), ...reviewConfig(config) }));
  register('verification-publish', (proposalId, reviewId, commandId) => verification({ type: 'publish', proposalId: id(proposalId), reviewId: id(reviewId), commandId: id(commandId) }));
  register('verification-freeze', (runtimeId, commandId) => verification({ type: 'freeze', runtimeId: id(runtimeId), commandId: id(commandId), mode: 'final' }));
  register('verification-run', (planId, commandId, config) => verification({ type: 'run', planId: id(planId), commandId: id(commandId), ...reviewConfig(config) }));
  register('verification-deliver', (jobId, commandId) => verification({ type: 'deliver', jobId: id(jobId), commandId: id(commandId) }));
  register('verification-cancel', jobId => verification({ type: 'cancel', jobId: id(jobId) }));
  register('choose-verification-spec', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择项目验收定义 JSON', properties: ['openFile'], filters: [{ name: '验收定义', extensions: ['json'] }] });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  register('list', () => execution({ type: 'list' }));
  register('inspect', executionId => execution({ type: 'inspect', executionId: id(executionId) }));
  register('events', (executionId, after) => {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid event cursor');
    return execution({ type: 'events', executionId: id(executionId), after });
  });
  register('capabilities', () => execution({ type: 'capabilities' }));
  register('start', async input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { accepted: false, error: 'Invalid task input' };
    const keys = ['commandId', 'workspace', 'prompt', 'model', 'effort', 'timeoutMs', 'tokenLimit', 'reservation', 'verificationReserve', 'images'];
    if (Object.keys(input).some(key => !keys.includes(key))) return { accepted: false, error: 'Unknown task input field' };
    const action = { type: 'start' };
    for (const key of keys) if (input[key] !== undefined) action[key] = input[key];
    // Preserve definitive rejections as data across Electron's error serialization.
    // Transport failures still reject: the renderer must retain the command ID.
    const response = await request(dataDir, { id: randomUUID(), method: 'execution', action });
    return response.ok ? { accepted: true, record: response.value } : { accepted: false, error: response.error };
  });
  register('cancel', executionId => execution({ type: 'cancel', executionId: id(executionId) }));
  register('reconcile', executionId => execution({ type: 'reconcile', executionId: id(executionId) }));
  register('open-project-directory', async projectPath => {
    if (typeof projectPath !== 'string' || !projectPath.startsWith('/') || projectPath.length > 4096 || projectPath.includes('\0')) throw new Error('Invalid project directory');
    const directory = await realpath(projectPath);
    if (!(await stat(directory)).isDirectory()) throw new Error('项目目录已不可用');
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
  });
  register('open-workspace', async executionId => {
    executionId = id(executionId);
    const record = executionId.startsWith('runtime-')
      ? (await runtime({ type: 'inspect', runtimeId: id(executionId) })).runtime
      : executionId.startsWith('goal-') ? (await orchestration({ type: 'inspect', sessionId: executionId })).session
      : await execution({ type: 'inspect', executionId: id(executionId) });
    if (!(await stat(record.workspace)).isDirectory()) throw new Error('项目目录已不可用');
    const error = await shell.openPath(record.workspace);
    if (error) throw new Error(error);
  });
  register('choose-workspace', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择任务工作区', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  register('choose-images', async () => {
    const result = await dialog.showOpenDialog(window, { title: '附加真实截图', properties: ['openFile', 'multiSelections'], filters: [{ name: '图像', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    return result.canceled ? [] : result.filePaths;
  });
}
function createWindow() {
  window = new BrowserWindow({
    title: 'Supervisor', width: 1440, height: 980, minWidth: 980, minHeight: 680,
    backgroundColor: '#101311', titleBarStyle: 'hiddenInset',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: false }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.on('closed', () => { window = undefined; });
  window.loadFile(documentPath);
}
app.whenReady().then(async () => {
  ({ request } = await import(pathToFileURL(join(__dirname, '../cli/client.js')).href));
  ({ parseOrchestrationAction } = await import(pathToFileURL(join(__dirname, '../../packages/contracts/p5.js')).href));
  ({ parseSupervisionAction } = await import(pathToFileURL(join(__dirname, '../../packages/contracts/p6-supervision-actions.js')).href));
  ({ parseConversationAction } = await import(pathToFileURL(join(__dirname, '../../packages/contracts/p6-actions.js')).href));
  installBridge();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Supervisor', submenu: [{ role: 'about' }, { type: 'separator' }, { label: '退出界面（后台继续运行）', role: 'quit' }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { label: '关闭窗口（后台继续运行）', role: 'close' }] }
  ]));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch(error => { dialog.showErrorBox('Supervisor 启动失败', String(error)); app.quit(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
