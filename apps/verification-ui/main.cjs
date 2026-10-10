const { app, BrowserWindow, session, Menu } = require('electron');
const { realpath, stat, open } = require('node:fs/promises');
const { readFileSync, mkdirSync } = require('node:fs');
const { join, relative, isAbsolute } = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');

// Only this reviewed program supplies JavaScript. Verifier input is declarative data.
const arg = process.argv.indexOf('--request');
let window;
let trace;
let request;
let fatal;
let finishing = false;
const startedAt = Date.now();
class StepFailure extends Error { constructor(message, observed) { super(message); this.observed = observed; } }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const contained = (tree, path) => { const name = relative(tree, path); return name !== '..' && !name.startsWith('../') && !isAbsolute(name); };
async function durable(path, bytes) { const file = await open(path, 'wx', 0o600); try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); } }
function check() { if (fatal) throw fatal; if (Date.now() - startedAt >= request.verifier.timeoutMs) throw new Error('UI driver deadline reached'); }
function validate(input) {
  if (!input || typeof input !== 'object' || input.schemaVersion !== 1 || typeof input.id !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/.test(input.id)
    || !isAbsolute(input.candidateTree) || !isAbsolute(input.output)) throw new Error('Invalid UI driver request');
  if(input.localOrigin!==undefined&&!input.localIdentity)throw new Error('Missing local application identity');
  if(input.localOrigin!==undefined&&!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(input.localOrigin))throw new Error('Invalid owned local origin');
  const v = input.verifier;
  if (!v || v.kind !== 'ui' || typeof v.entry !== 'string' || !v.entry.endsWith('.html') || v.entry.includes('\\') || /[?#]/.test(v.entry)
    || v.entry.split('/').some(part => !part || part === '.' || part === '..') || isAbsolute(v.entry)
    || !Number.isSafeInteger(v.timeoutMs) || v.timeoutMs < 1 || v.timeoutMs > 3600000 || !Array.isArray(v.steps) || !v.steps.length || v.steps.length > 1000) throw new Error('Invalid UI verifier');
  for (const step of v.steps) {
    if (!step || !['click', 'fill', 'assertText', 'assertVisible'].includes(step.kind) || typeof step.selector !== 'string' || !step.selector.trim() || step.selector.length > 20000
      || step.kind === 'fill' && (typeof step.value !== 'string' || step.value.length > 200000)
      || step.kind === 'assertText' && (typeof step.text !== 'string' || !step.text || step.text.length > 200000)) throw new Error('Invalid declarative UI step');
    const keys = step.kind === 'fill' ? ['kind', 'selector', 'value'] : step.kind === 'assertText' ? ['kind', 'selector', 'text'] : ['kind', 'selector'];
    if (Object.keys(step).some(key => !keys.includes(key))) throw new Error('UI step cannot contain scripts or unknown fields');
  }
}
let ownershipModule;
async function checkLocalOwnership() {
 if(!request.localOrigin)return;
 ownershipModule ??= import(pathToFileURL(join(__dirname,'../../packages/verification/fullstack-host.js')).href);
 const {assertOwnedApplication}=await ownershipModule;
 await assertOwnedApplication(request.localOrigin,request.localIdentity);
 trace.ownershipChecks.push({origin:request.localOrigin,at:new Date().toISOString()});
}
async function allowedURL(url, mainFrame = false) {
  try {
    const parsed = new URL(url);
    if (!mainFrame && parsed.protocol === 'data:') return true;
    if(request.localOrigin)return parsed.origin===request.localOrigin&&parsed.protocol==='http:';
    if (parsed.protocol !== 'file:') return false;
    const path = await realpath(fileURLToPath(parsed));
    return contained(request.candidateTree, path) && (await stat(path)).isFile() && (!mainFrame || path.endsWith('.html'));
  } catch { return false; }
}
async function capture(name) {
  await checkLocalOwnership();
  if (!window || window.isDestroyed()) throw new Error('UI window closed before screenshot');
  const image = await window.webContents.capturePage();
  if (image.isEmpty()) throw new Error('UI screenshot is empty');
  await durable(join(request.output, name), image.toPNG());
  trace.screenshots.push(name); return name;
}
async function query(step, scroll) {
  // The page cannot replace the DOM builtins in this isolated world. JSON literals
  // preserve selectors/text as data and never become executable verifier input.
  const code = `(() => {
    const step=${JSON.stringify(step)},scroll=${JSON.stringify(scroll)};
    let found; try { found=document.querySelectorAll(step.selector); } catch { return {error:'Invalid CSS selector'}; }
    if(found.length!==1)return {found:found.length,visible:false};
    const element=found[0];
    if(scroll)element.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
    const style=getComputedStyle(element),rect=element.getBoundingClientRect();
    const left=Math.max(0,rect.left),right=Math.min(innerWidth,rect.right),top=Math.max(0,rect.top),bottom=Math.min(innerHeight,rect.bottom);
    const x=Math.floor((left+right)/2),y=Math.floor((top+bottom)/2);
    let ancestor=element,hidden=false;while(ancestor){const s=getComputedStyle(ancestor);if(s.display==='none'||s.visibility==='hidden'||s.visibility==='collapse'||Number(s.opacity)===0||ancestor.hidden)hidden=true;ancestor=ancestor.parentElement;}
    const hit=document.elementFromPoint(x,y),visible=!hidden&&rect.width>0&&rect.height>0&&right>left&&bottom>top&&!!hit&&(hit===element||element.contains(hit));
    return {found:1,visible,x,y,tag:element.tagName,type:element.type||'',disabled:!!element.disabled||element.closest('[inert]')!==null,readOnly:!!element.readOnly,editable:element.isContentEditable,text:element.innerText||'',value:'value' in element?element.value:element.textContent||'',focused:document.activeElement===element,selectionStart:element.selectionStart??null,selectionEnd:element.selectionEnd??null,selectedText:getSelection()?.toString()||''};
  })()`;
  return window.webContents.executeJavaScriptInIsolatedWorld(979, [{ code }]);
}
async function ready(step) {
  const until = Math.min(startedAt + request.verifier.timeoutMs, Date.now() + 2500);
  let observed;
  do {
    check(); observed = await query(step, true);
    if (observed.error) throw new Error(observed.error);
    if (observed.found > 1) throw new Error(`Selector is ambiguous (${observed.found} matches): ${step.selector}`);
    if (observed.found === 1 && observed.visible && (step.kind !== 'assertText' || observed.text.includes(step.text))) return observed;
    await wait(80);
  } while (Date.now() < until);
  if (!observed?.found) throw new StepFailure(`Required element not found: ${step.selector}`);
  if (!observed.visible) throw new StepFailure(`Required element is not visible or is obscured: ${step.selector}`);
  throw new StepFailure(`Visible text does not include ${JSON.stringify(step.text)}; actual ${JSON.stringify(observed.text)}`);
}
async function executeStep(step) {
  await checkLocalOwnership();
  const observed = await ready(step);
  if (step.kind === 'assertText' || step.kind === 'assertVisible') return observed;
  if (observed.disabled) throw new StepFailure(`Required control is disabled: ${step.selector}`);
  if (step.kind === 'fill' && (observed.readOnly || !observed.editable && !(observed.tag === 'TEXTAREA' || observed.tag === 'INPUT' && ['text', 'email', 'password', 'url', 'search', 'tel', 'number'].includes(observed.type)))) throw new StepFailure(`Control is not a writable text input: ${step.selector}`);
  window.focus(); window.webContents.focus();
  window.webContents.sendInputEvent({ type: 'mouseMove', x: observed.x, y: observed.y });
  window.webContents.sendInputEvent({ type: 'mouseDown', x: observed.x, y: observed.y, button: 'left', clickCount: 1 });
  window.webContents.sendInputEvent({ type: 'mouseUp', x: observed.x, y: observed.y, button: 'left', clickCount: 1 });
  let focused, selected;
  if (step.kind === 'fill') {
    focused = await observe(step, value => value.focused, 'Declared text input did not receive focus');
    // Execute Chromium's actual editing command. A menu-less macOS window can
    // receive Cmd+A as an ordinary key without selecting its existing text.
    // No DOM value, selection or application handler is assigned by the driver.
    window.webContents.selectAll();
    selected = await observe(step, value => value.focused && (value.selectionStart === 0 && value.selectionEnd === value.value.length || value.selectionStart === null && value.selectedText === value.value), 'Declared text input did not select its existing value');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
    await observe(step, value => value.focused && value.value === '', 'Declared text input did not clear its existing value');
    if (step.value) await window.webContents.insertText(step.value);
  }
  await wait(40);
  while (window.webContents.isLoadingMainFrame()) { check(); await wait(40); }
  // Allow handlers and layout to run; no arbitrary sleeps supplied by a case.
  await window.webContents.executeJavaScriptInIsolatedWorld(979, [{ code: 'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))' }]);
  if (step.kind === 'fill') {
    const filled = await observe(step, value => value.value === step.value, 'Text input did not retain declared value');
    return { before: observed, focused, selected, after: filled };
  }
  return observed;
}
async function observe(step, accepts, message) {
  const until = Math.min(startedAt + request.verifier.timeoutMs, Date.now() + 2500); let observed;
  do { check(); observed = await query(step, false); if (accepts(observed)) return observed; await wait(20); } while (Date.now() < until);
  throw new StepFailure(`${message}: ${step.selector}; actual value ${JSON.stringify(observed?.value)}`, observed);
}
async function run() {
  request.candidateTree = await realpath(request.candidateTree);
  request.output = await realpath(request.output);
  if (contained(request.candidateTree, request.output)) throw new Error('UI evidence must be outside the candidate tree');
  const entry = await realpath(join(request.candidateTree, request.verifier.entry));
  if (!contained(request.candidateTree, entry) || !(await stat(entry)).isFile()) throw new Error('UI entry escapes the candidate tree');
  trace = { schemaVersion: 1, id: request.id, driverVersion: 'ui-driver-v2', entry, localOrigin:request.localOrigin??null, startedAt: new Date().toISOString(), executionStatus: 'verifier-error', reason: '', steps: [], screenshots: [], blockedRequests: [], errors: [], ownershipChecks: [] };
  await app.whenReady(); Menu.setApplicationMenu(null);
  const isolated = session.fromPartition('supervisor-ui-' + randomUUID(), { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on('will-download', event => { event.preventDefault(); fatal ??= new Error('UI verification rejects downloads'); });
  isolated.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    void checkLocalOwnership().then(()=>allowedURL(details.url, details.resourceType === 'mainFrame' || details.resourceType === 'subFrame')).then(allowed => {
      const reject = !allowed || !(request.localOrigin?['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']:['GET']).includes(details.method);
      if (reject) { trace.blockedRequests.push({ url: details.url, method: details.method }); fatal ??= new Error('UI requested an external or unsupported resource'); }
      callback({ cancel: reject });
    }).catch(error => { fatal ??= error; callback({ cancel: true }); });
  });
  window = new BrowserWindow({ title: 'Supervisor verification', width: 1280, height: 900, useContentSize: true, show: true, backgroundColor: '#07152e',
    webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false, devTools: false, backgroundThrottling: false, disableDialogs: true },
  });
  window.webContents.setWindowOpenHandler(() => { fatal ??= new Error('UI requested a new window'); return { action: 'deny' }; });
  window.webContents.on('will-attach-webview', event => { event.preventDefault(); fatal ??= new Error('UI requested an embedded webview'); });
  for (const eventName of ['will-navigate', 'will-frame-navigate', 'will-redirect']) window.webContents.on(eventName, (event, legacyURL) => {
    const url = event.url || legacyURL;
    // Navigation validity is checked synchronously first; webRequest performs
    // the subsequent realpath/symlink check before any local bytes are loaded.
    try { const parsed = new URL(url); if(request.localOrigin){if(parsed.origin!==request.localOrigin||parsed.protocol!=='http:')throw new Error();}else if (parsed.protocol !== 'file:' || !contained(request.candidateTree, fileURLToPath(parsed))) throw new Error(); }
    catch { event.preventDefault(); fatal ??= new Error('UI attempted external navigation'); }
  });
  window.webContents.on('render-process-gone', (_event, detail) => { fatal ??= new Error(`UI renderer exited: ${detail.reason}`); });
  window.webContents.on('console-message', event => { trace.errors.push({ kind: 'console', level: event.level, message: event.message, sourceId: event.sourceId, lineNumber: event.lineNumber }); });
  window.on('closed', () => { if (!finishing) fatal ??= new Error('UI window closed during verification'); });
  if(request.localOrigin)await window.loadURL(request.localOrigin+'/'+request.verifier.entry);else await window.loadFile(entry); check();
  trace.initialScreenshot = await capture('initial.png');
  let failed = false;
  for (let index = 0; index < request.verifier.steps.length; index++) {
    const step = request.verifier.steps[index];
    const item = { index, step, verdict: 'unknown', reason: '', startedAt: new Date().toISOString() };
    trace.steps.push(item);
    if (failed) { item.reason = 'Not executed after a preceding failed step'; continue; }
    try { item.observed = await executeStep(step); check(); item.verdict = 'passed'; item.reason = 'Actual declared UI step completed'; }
    catch (error) {
      if (error.observed) item.observed = error.observed;
      item.reason = String(error.message || error); item.verdict = error instanceof StepFailure ? 'failed' : 'unknown';
      if (!(error instanceof StepFailure)) throw error; failed = true;
    }
    finally { item.finishedAt = new Date().toISOString(); item.screenshot = await capture(`step-${String(index + 1).padStart(3, '0')}.png`); }
  }
  check(); trace.finalScreenshot = await capture('final.png'); check(); trace.finalURL = window.webContents.getURL();
  trace.executionStatus = 'executed'; trace.reason = failed ? 'An actual declared UI assertion or operation failed' : 'Actual declared UI steps completed; visual expectations require separate independent review';
}
async function finish(error) {
  if (finishing) return; finishing = true;
  if (error && trace) { trace.executionStatus = 'verifier-error'; trace.reason = String(error.message || error); trace.errors.push({ kind: 'driver', message: trace.reason }); }
  if (trace) {
    try { if (!trace.finalScreenshot && window && !window.isDestroyed()) trace.finalScreenshot = await capture('final.png'); } catch (screenshotError) { trace.errors.push({ kind: 'screenshot', message: String(screenshotError) }); }
    trace.finishedAt = new Date().toISOString();
    try { await durable(join(request.output, 'trace.json'), JSON.stringify(trace, null, 2) + '\n'); }
    catch (writeError) { console.error(String(writeError)); app.exit(2); return; }
  } else console.error(String(error || 'UI driver failed before initialization'));
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(error ? 2 : trace.steps.some(step => step.verdict !== 'passed') ? 1 : 0);
}
// Resolve all profile paths before app readiness; no default/global Electron
// session directory is touched while asynchronous candidate checks run.
try {
  if (arg < 0 || !process.argv[arg + 1]) throw new Error('Missing UI request file');
  request = JSON.parse(readFileSync(process.argv[arg + 1], 'utf8')); validate(request);
  const profile = join(request.output, 'electron-profile'); mkdirSync(profile, { recursive: true, mode: 0o700 });
  app.setPath('userData', profile); app.setPath('sessionData', profile);
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  run().then(() => finish()).catch(error => finish(error));
} catch (error) { console.error(String(error)); app.exit(2); }
app.on('window-all-closed', () => { if (!finishing) void finish(new Error('UI window unavailable')); });
