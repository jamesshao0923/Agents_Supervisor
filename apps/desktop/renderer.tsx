import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ExecutionEvent, ExecutionRecord, ExecutionState, ExecutorCapabilities } from '../../packages/contracts/p2.js';

import type { RuntimeRecord, RuntimeSubmit, RuntimePhase, RuntimeOperation, RuntimeCheckpoint, RuntimeEvent } from '../../packages/contracts/p3.js';
import type { Run } from '../../packages/contracts/p1.js';

type StartInput = Omit<RuntimeSubmit, 'type'>;
type StartResult = { accepted: true; record: RuntimeRecord } | { accepted: false; error: string };
interface RuntimeInspection { runtime: RuntimeRecord; run: Run; operations: RuntimeOperation[]; checkpoints: { checkpoint: RuntimeCheckpoint; digest: string; valid: boolean }[] }
interface TaskRecord {
  id: string; workspace: string; workspaceKind: 'project' | 'managed'; prompt: string; createdAt: string;
  state: ExecutionState | RuntimePhase; error: string | null; message: string;
  usage: ExecutionRecord['usage']; usageStatus: ExecutionRecord['usageStatus'];
  runtime?: RuntimeRecord; execution?: ExecutionRecord;
}
function taskViews(runtimes: RuntimeRecord[], executions: ExecutionRecord[]): TaskRecord[] {
  const durable = runtimes.map(runtime => {
    const execution = executions.filter(item => item.runtimeBinding?.runtimeId === runtime.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return { id: runtime.id, workspace: runtime.workspace, workspaceKind: runtime.workspaceKind, prompt: runtime.definition.goal, createdAt: runtime.createdAt, state: runtime.phase, error: runtime.error || execution?.error || null, message: execution?.message || '', usage: execution?.usage || null, usageStatus: execution?.usageStatus || 'unknown', runtime, ...(execution ? { execution } : {}) } satisfies TaskRecord;
  });
  const legacy = executions.filter(item => !item.runtimeBinding).map(execution => ({ ...execution, execution } satisfies TaskRecord));
  return [...durable, ...legacy].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
interface DesktopAPI {
  health(): Promise<unknown>;
  list(): Promise<ExecutionRecord[]>;
  inspect(id: string): Promise<ExecutionRecord>;
  events(id: string, after: number): Promise<ExecutionEvent[]>;
  capabilities(): Promise<ExecutorCapabilities>;
  runtimeList(): Promise<RuntimeRecord[]>;
  runtimeInspect(id: string): Promise<RuntimeInspection>;
  runtimeEvents(id: string, after: number): Promise<RuntimeEvent[]>;
  runtimeSubmit(input: StartInput): Promise<StartResult>;
  runtimePause(id: string, commandId: string): Promise<RuntimeRecord>;
  runtimeResume(id: string, commandId: string): Promise<RuntimeRecord>;
  runtimeCancel(id: string, commandId: string): Promise<RuntimeRecord>;
  runtimeReconcile(id: string, commandId: string): Promise<RuntimeRecord>;
  runtimeInput(id: string, commandId: string, stepId: string, text: string): Promise<RuntimeRecord>;
  cancel(id: string): Promise<ExecutionRecord>;
  reconcile(id: string): Promise<ExecutionRecord>;
  chooseWorkspace(): Promise<string | null>;
  openWorkspace(id: string): Promise<void>;
  chooseImages(): Promise<string[]>;
}
declare global { interface Window { supervisor: DesktopAPI } }
const api = window.supervisor;
const labels: Record<ExecutionState | RuntimePhase, string> = {
  queued: '已排队', starting: '启动中', running: '执行中', waiting: '等待执行器', cancelling: '取消中 · 核对进程',
  ready: '等待派发', 'waiting-input': '等待输入', paused: '已暂停派发', blocked: '恢复阻塞 · 待核对', 'awaiting-verification': '步骤已结束 · 待独立验收',
  completed: '执行结束 · 待验收', cancelled: '已取消', failed: '执行失败', interrupted: '执行中断', unknown: '状态待核对'
};
const active = (record: TaskRecord) => ['ready', 'queued', 'starting', 'running', 'waiting', 'cancelling'].includes(record.state) || Boolean(record.execution && !record.execution.stopConfirmed && ['starting', 'running', 'waiting', 'cancelling'].includes(record.execution.state));
const statusLabel = (record: TaskRecord) => record.runtime?.cancelled && record.execution && !record.execution.stopConfirmed ? '取消已请求 · 待停止核对' : labels[record.state];
const basename = (path: string) => path.split('/').filter(Boolean).at(-1) || path;
const time = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const count = (value: number) => new Intl.NumberFormat('zh-CN').format(value);
function Icon({ name, size = 16 }: { name: 'plus' | 'grid' | 'folder' | 'arrow' | 'close' | 'refresh' | 'agent' | 'stop' | 'image'; size?: number }) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14" />, grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
    folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3Z"/>, arrow: <path d="m9 5 7 7-7 7M3 12h13"/>, close: <path d="m6 6 12 12M18 6 6 18"/>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 4M18 18a8 8 0 0 1-13-4"/></>, agent: <><path d="m12 3 8 5v8l-8 5-8-5V8Z"/><path d="m4 8 8 5 8-5M12 13v8M8 6l8 5"/></>, stop: <rect x="6" y="6" width="12" height="12" rx="2"/>, image: <><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 17 5-5 4 3 4-5 5 6"/></>
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
function Status({ record }: { record: TaskRecord }) {
  const color = ['failed', 'unknown', 'interrupted', 'blocked'].includes(record.state) ? 'failed' : ['cancelled', 'completed', 'awaiting-verification', 'paused', 'waiting-input'].includes(record.state) ? 'stopped' : '';
  return <span className={`agent-status ${color}`}><i className="dot"/>{statusLabel(record)}</span>;
}
function EventItem({ event }: { event: ExecutionEvent }) {
  return <li className="event"><div className="event-meta"><span>{event.kind}</span><time>{time(event.receivedAt)}</time></div><pre>{typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload, null, 2)}</pre></li>;
}
function App() {
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeRecord[]>([]);
  const [runtimeDetail, setRuntimeDetail] = useState<RuntimeInspection | null>(null);
  const [runtimeEvents, setRuntimeEvents] = useState<RuntimeEvent[]>([]);
  const [inputText, setInputText] = useState('');
  const records = taskViews(runtimes, executions);
  const [connection, setConnection] = useState<'connecting' | 'online' | 'offline' | 'detached'>('connecting');
  const [monitoring, setMonitoring] = useState(true);
  const [revision, setRevision] = useState(0);
  const [connectionError, setConnectionError] = useState('');
  const [actionError, setActionError] = useState('');
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [eventError, setEventError] = useState('');
  const [composer, setComposer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [capabilities, setCapabilities] = useState<ExecutorCapabilities | null>(null);
  const [capError, setCapError] = useState('');
  const [capLoading, setCapLoading] = useState(false);
  const [workspace, setWorkspace] = useState('');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [timeout, setTimeoutValue] = useState(300);
  const [tokenLimit, setTokenLimit] = useState(170000);
  const [reservation, setReservation] = useState(150000);
  const [verificationReserve, setVerificationReserve] = useState(20000);
  const [pending, setPending] = useState<StartInput | null>(null);
  const pendingRef = useRef<StartInput | null>(null);
  const capabilityLoading = useRef(false);
  const chosen = records.find(record => record.id === selected) ?? null;
  const chosenRuntime = chosen?.runtime;
  const chosenExecution = chosen?.execution;
  const detail = runtimeDetail?.runtime.id === selected ? runtimeDetail : null;
  const waitingStep = chosenRuntime?.definition.steps[chosenRuntime.cursor];
  const isRuntime = Boolean(chosenRuntime);
  const childExecutionId = chosenExecution?.id;
  const visible = records.filter(record => record.workspace === project);
  const projects = Array.from(new Set(records.map(record => record.workspace))).map(path => ({
    path, tasks: records.filter(record => record.workspace === path),
    managed: records.some(record => record.workspace === path && record.workspaceKind === 'managed')
  }));
  const currentProject = projects.find(item => item.path === project);
  const projectName = (item: typeof projects[number]) => {
    if (!item.managed) return basename(item.path);
    const title = item.tasks.at(-1)!.prompt.split(/[\n：:。]/)[0]!.trim();
    return title.length > 28 ? title.slice(0, 28) + '…' : title || '暂存工作区';
  };
  const selectedModel = capabilities?.models.find(item => item.id === model);
  const loadCapabilities = useCallback(async () => {
    if (capabilityLoading.current) return;
    capabilityLoading.current = true; setCapLoading(true); setCapError('');
    try {
      const result = await api.capabilities(); setCapabilities(result);
      const first = result.models.find(item => item.id === 'gpt-5.6-sol')
        ?? result.models.find(item => item.id === 'gpt-6.1-sol')
        ?? result.models[0];
      if (first) { setModel(current => current || first.id); setEffort(current => current || first.defaultEffort || first.reasoningEfforts[0] || ''); }
      if (!first) setCapError('执行器未返回可用模型，无法启动任务。');
    } catch (error) { setCapError(errorText(error)); }
    finally { capabilityLoading.current = false; setCapLoading(false); }
  }, []);
  useEffect(() => {
    if (!monitoring) { setConnection('detached'); return; }
    let ended = false;
    let timer: ReturnType<typeof globalThis.setTimeout>;
    async function poll() {
      try {
        await api.health();
        const [result, durable] = await Promise.all([api.list(), api.runtimeList()]);
        if (ended) return;
        const ordered = taskViews(durable, result);
        setExecutions(result); setRuntimes(durable);
        setProject(current => current && ordered.some(item => item.workspace === current) ? current : ordered[0]?.workspace ?? null);
        setConnection('online'); setConnectionError(''); setLastSync(new Date().toISOString());
        const pendingRecord = pendingRef.current && durable.find(item => item.definition.commandId === pendingRef.current?.commandId);
        if (pendingRecord) { pendingRef.current = null; setPending(null); setComposer(false); setSelected(pendingRecord.id); setProject(pendingRecord.workspace); setCollapsed(current => { const next = new Set(current); next.delete(pendingRecord.workspace); return next; }); setActionError(''); }
      } catch (error) { if (!ended) { setConnection('offline'); setConnectionError(errorText(error)); } }
      if (!ended) timer = globalThis.setTimeout(poll, 2000);
    }
    void poll();
    return () => { ended = true; globalThis.clearTimeout(timer); };
  }, [monitoring, revision]);
  useEffect(() => { if (connection === 'online' && composer && !capabilities && !capError) void loadCapabilities(); }, [connection, composer, capabilities, capError, loadCapabilities]);
  useEffect(() => {
    setEvents([]); setRuntimeEvents([]); setRuntimeDetail(null); setInputText(''); setEventError('');
    if (!selected || !monitoring) return;
    const taskId = selected;
    let ended = false, cursor = 0, runtimeCursor = 0;
    let timer: ReturnType<typeof globalThis.setTimeout>;
    async function poll() {
      try {
        if (isRuntime) {
          const [inspection, batch] = await Promise.all([api.runtimeInspect(taskId), api.runtimeEvents(taskId, runtimeCursor)]);
          if (ended) return;
          setRuntimeDetail(inspection);
          const fresh = batch.filter(event => event.seq > runtimeCursor).sort((a, b) => a.seq - b.seq);
          if (fresh.length) { runtimeCursor = fresh.at(-1)!.seq; setRuntimeEvents(current => [...current, ...fresh].slice(-100)); }
        }
        const batch = !isRuntime || childExecutionId ? await api.events(childExecutionId || taskId, cursor) : [];
        if (ended) return;
        const ordered = batch.filter(event => event.seq > cursor).sort((a, b) => a.seq - b.seq);
        if (ordered.length) {
          cursor = ordered.at(-1)!.seq;
          setEvents(current => {
            const unique = new Map(current.map(event => [event.seq, event]));
            ordered.forEach(event => unique.set(event.seq, event));
            return Array.from(unique.values()).slice(-300);
          });
        }
        setEventError('');
      } catch (error) { if (!ended) setEventError(errorText(error)); }
      if (!ended) timer = globalThis.setTimeout(poll, 1500);
    }
    void poll();
    return () => { ended = true; globalThis.clearTimeout(timer); };
  }, [selected, isRuntime, childExecutionId, monitoring, revision]);
  const refresh = () => { setMonitoring(true); setConnection('connecting'); setRevision(value => value + 1); };
  async function start(event: React.FormEvent) {
    event.preventDefault(); setActionError('');
    const input: StartInput = pending ?? { commandId: crypto.randomUUID(), ...(workspace.trim() ? { workspace: workspace.trim() } : {}), goal: prompt.trim(), tokenLimit, verificationReserve, steps: [{ id: 'codex-execution', kind: 'codex', prompt: prompt.trim(), model, effort, timeoutMs: timeout * 1000, reservation, ...(images.length ? { images } : {}) }] };
    const codex = input.steps.find(step => step.kind === 'codex');
    if ((input.workspace && !input.workspace.startsWith('/')) || !input.goal || !codex || codex.kind !== 'codex' || !codex.model || !codex.effort) { setActionError('请填写目标、模型和思考深度；工作区可留空，填写时须使用绝对路径。'); return; }
    if (![codex.timeoutMs, input.tokenLimit, codex.reservation, input.verificationReserve].every(Number.isSafeInteger) || timeout < 1 || timeout > 3600 || reservation < 1 || verificationReserve < 1 || codex.reservation + input.verificationReserve > input.tokenLimit) { setActionError('超时须为 1–3600 秒；总额度须覆盖执行预留与独立验收预留。'); return; }
    pendingRef.current = input; setPending(input); setBusy(true);
    try {
      const result = await api.runtimeSubmit(input);
      if (!result.accepted) {
        pendingRef.current = null; setPending(null);
        setActionError(`${result.error}。后台已拒绝本次请求；请修改后重新提交。`);
        return;
      }
      const record = result.record;
      setRuntimes(current => [record, ...current.filter(item => item.id !== record.id)]);
      pendingRef.current = null; setPending(null); setSelected(record.id); setProject(record.workspace); setCollapsed(current => { const next = new Set(current); next.delete(record.workspace); return next; }); setComposer(false);
      setRevision(value => value + 1);
    } catch (error) { setActionError(`${errorText(error)}。请求编号已保留；请先重连核对，重试将使用同一编号。`); }
    finally { setBusy(false); }
  }
  async function control(kind: 'pause' | 'resume' | 'cancel' | 'reconcile') {
    if (!chosen) return;
    setBusy(true); setActionError('');
    try {
      if (chosen.runtime) {
        const methods = { pause: api.runtimePause, resume: api.runtimeResume, cancel: api.runtimeCancel, reconcile: api.runtimeReconcile };
        const record = await methods[kind](chosen.id, crypto.randomUUID());
        setRuntimes(current => current.map(item => item.id === record.id ? record : item));
      } else if (kind === 'cancel' || kind === 'reconcile') {
        const record = await api[kind](chosen.id); setExecutions(current => current.map(item => item.id === record.id ? record : item));
      }
      setRevision(value => value + 1);
    } catch (error) { setActionError(errorText(error)); }
    finally { setBusy(false); }
  }
  async function sendInput(event: React.FormEvent) {
    event.preventDefault(); if (!chosenRuntime || waitingStep?.kind !== 'input' || !inputText.trim()) return;
    setBusy(true); setActionError('');
    try { const record = await api.runtimeInput(chosenRuntime.id, crypto.randomUUID(), waitingStep.id, inputText.trim()); setRuntimes(current => current.map(item => item.id === record.id ? record : item)); setRevision(value => value + 1); }
    catch (error) { setActionError(errorText(error)); }
    finally { setBusy(false); }
  }
  function newTask(path: string | null = null) {
    setComposer(true); setSelected(null); setActionError('');
    if (pendingRef.current) return;
    setWorkspace(path ?? ''); setPrompt(''); setImages([]);
  }
  function selectTask(record: TaskRecord) { setSelected(record.id); setProject(record.workspace); setComposer(false); }
  async function openWorkspace(id: string) { try { await api.openWorkspace(id); } catch (error) { setActionError(errorText(error)); } }
  async function chooseWorkspace() { try { const path = await api.chooseWorkspace(); if (path) setWorkspace(path); } catch (error) { setActionError(errorText(error)); } }
  async function chooseImages() { try { const paths = await api.chooseImages(); setImages(current => Array.from(new Set([...current, ...paths])).slice(0, 5)); } catch (error) { setActionError(errorText(error)); } }
  const online = connection === 'online';
  const modelSupportsImages = Boolean(capabilities?.imageInput && selectedModel?.inputModalities.includes('image'));
  return <div className="shell">
    <aside className="sidebar" aria-label="项目与任务">
      <div className="brand"><span className="brand-mark"><Icon name="agent" size={21}/></span>Supervisor</div>
      <button className="nav-item new-task" onClick={() => newTask()}><Icon name="plus"/><span>新任务</span></button>
      <div className="eyebrow">Projects / 项目</div>
      <nav className="project-list" aria-label="按工作目录管理任务">{projects.length ? projects.map(item => <section className="project-group" key={item.path}>
        <div className={`project-row ${project === item.path ? 'active' : ''}`}>
          <button className="project-toggle" aria-label={`${collapsed.has(item.path) ? '展开' : '折叠'}项目 ${projectName(item)}`} aria-expanded={!collapsed.has(item.path)} onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(item.path)) next.delete(item.path); else next.add(item.path); return next; })}>{collapsed.has(item.path) ? '›' : '⌄'}</button>
          <button className="project-button" title={item.path} onClick={() => { setProject(item.path); setSelected(null); setComposer(false); }}><Icon name="folder"/><span>{projectName(item)}</span>{item.managed && <small>暂存</small>}<span className="count">{item.tasks.length}</span></button>
        </div>
        {!collapsed.has(item.path) && <div className="project-tasks">{item.tasks.map(record => <button className={`task-button ${selected === record.id ? 'selected' : ''}`} key={record.id} title={record.prompt} onClick={() => selectTask(record)}><strong>{record.prompt}</strong><small><i className={`dot ${active(record) ? '' : 'inactive'}`}/>{statusLabel(record)} · {date(record.createdAt)}</small></button>)}</div>}
      </section>) : <p className="subtle">任务将归入所选项目；未选择目录时自动创建暂存工作区。</p>}</nav>
      <div className="sidebar-footer"><strong>本地监督服务</strong><br/>关闭窗口或退出界面，<br/>后台任务继续运行。</div>
    </aside>
    <main className="workspace">
      <div className="titlebar">SUPERVISOR / LOCAL WORKSPACE</div>
      <header className="topbar"><div className="heading"><div className="eyebrow">Execution control</div><h1>让每一次执行，都有迹可循。</h1><p>持久任务 · 恢复核对 · 独立验收前不宣告交付</p></div>
        <div className="toolbar"><span className="connection" role="status"><i className={`dot ${online ? '' : 'offline'}`}/>{online ? '后台已连接' : connection === 'connecting' ? '正在连接' : connection === 'detached' ? '界面已断开' : '后台暂不可达'}</span>
          <button className="button ghost" onClick={refresh} aria-label="重新连接后台"><Icon name="refresh"/>重连</button>
          {online && <button className="button ghost" onClick={() => setMonitoring(false)}>断开界面</button>}
          <button className="button primary" onClick={() => newTask(project)}><Icon name="plus"/>{project ? '在此项目新建' : '新任务'}</button>
        </div></header>
      <div className="content"><section className="board" aria-label="Agent 工作台">
        {connection === 'offline' && <div className="notice error" role="alert">后台暂不可达，保留上次已知状态。请启动独立后台后重连。<br/>{connectionError}</div>}
        {connection === 'detached' && <div className="notice">界面已停止同步。后台任务继续由独立服务管理；重新连接后核对持久状态。</div>}
        {actionError && <div className="notice error" role="alert">{actionError}</div>}
        {composer && <form className="composer" onSubmit={event => { void start(event); }} aria-label="新建真实 Codex 任务">
          <div className="composer-head"><h2>{workspace.trim() ? '在项目中创建任务' : '创建新任务'}</h2><button type="button" className="icon-button" aria-label="关闭新任务面板" onClick={() => setComposer(false)}><Icon name="close"/></button></div>
          <p className="form-hint">选择已有项目目录，或留空使用独立暂存工作区。Codex 会在该目录实际读写文件。</p>
          <fieldset disabled={busy || Boolean(pending)}>
            <label className="field"><span>项目目录（可选）</span><div className="input-action"><input aria-label="工作区路径" value={workspace} onChange={event => setWorkspace(event.target.value)} placeholder="留空，自动创建暂存工作区"/><button type="button" className="button" onClick={() => { void chooseWorkspace(); }}><Icon name="folder"/>选择文件夹</button></div></label>
            <div className="workspace-hint">{workspace.trim() ? <><p className="form-hint">任务将挂载到此目录对应的项目。</p><button type="button" className="button ghost" onClick={() => setWorkspace('')}>改用独立暂存目录</button></> : <p className="form-hint">自动创建 ~/.supervisor/workspace/…，用于保存本次任务的文件与资料。退出应用后仍保留。</p>}</div>
            <label className="field"><span>本次目标</span><textarea aria-label="本次目标" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="描述需要修改的内容、边界与可验证的结果…" maxLength={200000} required/></label>
            <div className="field-row"><label className="field"><span>执行模型</span><select aria-label="执行模型" value={model} onChange={event => { const next = capabilities?.models.find(item => item.id === event.target.value); setModel(event.target.value); setEffort(next?.defaultEffort || next?.reasoningEfforts[0] || ''); setImages([]); }} disabled={!capabilities}><option value="" disabled>{capLoading ? '正在发现真实模型…' : '请选择模型'}</option>{capabilities?.models.map(item => <option key={item.id} value={item.id}>{item.label || item.id}</option>)}</select></label>
            <label className="field"><span>思考深度</span><select aria-label="思考深度" value={effort} onChange={event => setEffort(event.target.value)} disabled={!selectedModel}><option value="" disabled>由执行器提供</option>{selectedModel?.reasoningEfforts.map(item => <option key={item} value={item}>{item}</option>)}</select></label></div>
            <button type="button" className="button ghost" disabled={!modelSupportsImages || images.length >= 5} onClick={() => { void chooseImages(); }}><Icon name="image"/>附加真实截图（{images.length}/5）</button>
            {images.length > 0 && <div className="image-list">{images.map(path => <p key={path}>{basename(path)}</p>)}<button type="button" className="plain-button" onClick={() => setImages([])}>移除图像附件</button></div>}
            <details className="advanced"><summary>运行边界与预算</summary><div className="advanced-grid">
              <label className="field"><span>超时（秒）</span><input aria-label="超时秒数" type="number" min="1" max="3600" value={timeout} onChange={event => setTimeoutValue(Number(event.target.value))}/></label>
              <label className="field"><span>总额度（tokens）</span><input aria-label="总额度" type="number" min="1" value={tokenLimit} onChange={event => setTokenLimit(Number(event.target.value))}/></label>
              <label className="field"><span>执行预留（tokens）</span><input aria-label="执行预留" type="number" min="1" value={reservation} onChange={event => setReservation(Number(event.target.value))}/></label>
              <label className="field"><span>验收预留（tokens）</span><input aria-label="验收预留" type="number" min="1" value={verificationReserve} onChange={event => setVerificationReserve(Number(event.target.value))}/></label>
            </div><p className="form-hint">按执行器回报的原始 token 用量监控额度，包含缓存 token，不代表金额。验收额度单独保留；未知用量不当作零消耗。</p></details>
          </fieldset>
          {capError && <div className="validation" role="alert">模型能力发现失败：{capError} <button type="button" className="plain-button" onClick={() => { void loadCapabilities(); }} disabled={!online || capLoading}>重新发现</button></div>}
          {pending && <p className="form-hint mono">待核对请求：{pending.commandId}</p>}
          <div className="composer-footer"><p>执行结束仅表示本次尝试结束。<br/>交付仍须独立验收，本阶段不自动放行。</p><button className="button primary" type="submit" disabled={!online || busy || (!pending && (!model || !effort || !prompt.trim()))}>{busy ? '正在提交…' : pending ? '重试同一请求' : '启动 Codex'}<Icon name="arrow"/></button></div>
        </form>}
        <div className="board-head"><h2><span className="project-heading">{currentProject ? projectName(currentProject) : '项目工作台'}</span><span className="pill">{visible.length} 个任务</span></h2><span className="subtle">{visible.filter(active).length} 执行中 · 持久运行</span></div>
        {currentProject && <div className="project-context"><span className="mono" title={currentProject.path}>{currentProject.path}</span><button className="button ghost" onClick={() => { void openWorkspace(currentProject.tasks[0]!.id); }}><Icon name="folder"/>打开目录</button></div>}
        {visible.length ? <div className="grid">{visible.map(record => <button key={record.id} className={`agent-card ${selected === record.id ? 'selected' : ''}`} onClick={() => selectTask(record)} aria-label={`查看任务：${record.prompt}`}><div className="agent-top"><span className="agent-icon"><Icon name="agent" size={25}/></span><span className="pill">{record.runtime ? '持久任务' : 'Codex'}</span></div><div className="agent-role">{record.runtime ? '监督任务 / 固定步骤' : '执行 Agent / 单次尝试'}</div><h3>{record.prompt}</h3><Status record={record}/><div className="agent-excerpt">{record.error || record.message || (record.runtime ? `${Math.min(record.runtime.cursor + 1, record.runtime.definition.steps.length)} / ${record.runtime.definition.steps.length} 步 · ${record.runtime.definition.steps[record.runtime.cursor]?.kind || '待独立验收'}` : '等待执行器事件。')}</div><div className="agent-bottom"><span title={record.workspace}>{record.workspaceKind === 'managed' ? '暂存工作区' : basename(record.workspace)}</span><span>{record.usageStatus === 'reported' && record.usage ? `${count(record.usage.totalTokens)} tokens${record.runtime ? ' · 当前尝试' : ''}` : record.runtime && !record.execution ? '尚未调用模型' : '用量待回报'}</span></div></button>)}</div>
          : <div className="empty"><Icon name="agent" size={36}/><h2>从一个明确的目标开始</h2><p>选择已有项目，或直接描述目标。没有项目目录时，Supervisor 会自动创建暂存工作区。</p><button className="button primary" onClick={() => newTask(project)}><Icon name="plus"/>创建第一个任务</button></div>}
        <div className="single-note"><i className="dot"/>卡片展示可观测执行状态；完成标记由独立验收决定。</div>
      </section>
      {chosen && <aside className="detail" aria-label="任务详情"><header className="detail-header"><div className="detail-title"><h2>{chosenRuntime ? '任务详情' : '尝试详情'}</h2><button className="icon-button" aria-label="关闭任务详情" onClick={() => setSelected(null)}><Icon name="close"/></button></div><p className="detail-goal">{chosen.prompt}</p><Status record={chosen}/></header><div className="detail-body">
        <dl className="facts"><dt>项目目录</dt><dd>{chosen.workspace}<br/><span className="subtle">{chosen.workspaceKind === 'managed' ? 'Supervisor 暂存工作区 · 持续保留' : '本地项目'}</span></dd><dt>创建时间</dt><dd>{date(chosen.createdAt)}</dd>
          {chosenRuntime && <><dt>步骤位置</dt><dd>{Math.min(chosenRuntime.cursor + 1, chosenRuntime.definition.steps.length)} / {chosenRuntime.definition.steps.length} · {waitingStep?.kind || '全部步骤结束'}</dd><dt>累计用量</dt><dd>{detail ? `${count(detail.run.budget.spent)} tokens · ${detail.run.attempts.filter(attempt => !attempt.settled).length} 次用量待结算` : '等待后台账本'}</dd><dt>预算</dt><dd>{count(chosenRuntime.definition.tokenLimit)} tokens · 验收预留 {count(chosenRuntime.definition.verificationReserve)}</dd></>}
          {chosenExecution && <><dt>模型 / 深度</dt><dd>{chosenExecution.model} / {chosenExecution.effort}</dd><dt>当前尝试</dt><dd>{labels[chosenExecution.state]}</dd><dt>进程状态</dt><dd>{chosenExecution.stopConfirmed ? '已确认停止' : '尚未确认停止'}{chosenExecution.pid ? ` · PID ${chosenExecution.pid}` : ''}</dd><dt>超时期限</dt><dd>{date(chosenExecution.deadline)}</dd>{!chosenRuntime && <><dt>用量</dt><dd>{chosenExecution.usageStatus === 'reported' && chosenExecution.usage ? `${count(chosenExecution.usage.totalTokens)} tokens` : '未知 · 待执行器回报'}</dd><dt>预算</dt><dd>{count(chosenExecution.tokenLimit)} tokens · 验收预留 {count(chosenExecution.verificationReserve)}</dd></>}</>}
        </dl>
        {chosenRuntime?.paused && <div className="notice compact">已暂停新的步骤派发。在途执行继续运行，可另行取消任务。</div>}
        {['completed', 'awaiting-verification'].includes(chosen.state) && <div className="notice compact">步骤或执行已结束，待独立验收。尚未判定为已交付。</div>}
        {chosenRuntime?.phase === 'blocked' && <div className="notice compact">恢复核对尚未完成。未知副作用不会自动重复执行。</div>}
        {chosen.error && <div className="notice error compact">{chosen.error}</div>}
        {chosenRuntime && waitingStep?.kind === 'input' && !Object.hasOwn(chosenRuntime.inputs, waitingStep.id) && <form onSubmit={event => { void sendInput(event); }} className="runtime-input"><label className="field"><span>{waitingStep.prompt}</span><textarea aria-label="等待步骤输入" value={inputText} onChange={event => setInputText(event.target.value)} maxLength={200000} required disabled={!online || busy || chosenRuntime.cancelled}/></label><button className="button primary" disabled={!online || busy || chosenRuntime.cancelled || !inputText.trim()} type="submit">提交输入</button></form>}
        {chosen.message && <><h3 className="section-title">执行器输出</h3><div className="result">{chosen.message}</div></>}
        {chosenExecution?.diff && <details><summary className="section-title">查看变更差异</summary><pre className="result mono">{chosenExecution.diff}</pre></details>}
        {chosenRuntime && <details><summary className="section-title">恢复信息</summary><dl className="facts"><dt>检查点</dt><dd className="mono">{chosenRuntime.checkpointId || '尚未记录'}</dd><dt>游标 / 版本</dt><dd>{chosenRuntime.cursor} · 编排 v{chosenRuntime.workflowVersion} · 投影 v{chosenRuntime.projectionVersion}</dd><dt>任务编号</dt><dd className="mono">{chosenRuntime.id}</dd><dt>未决操作</dt><dd>{detail ? detail.operations.filter(operation => !['confirmed', 'cancelled'].includes(operation.state)).length : '等待核对'}</dd><dt>检查点摘要</dt><dd>{detail?.checkpoints.at(-1) ? (detail.checkpoints.at(-1)!.valid ? '核对一致' : '不一致 · 恢复阻塞') : '等待核对'}</dd></dl></details>}
        {chosenExecution && <details><summary className="section-title">当前尝试会话</summary><dl className="facts"><dt>会话</dt><dd className="mono">{chosenExecution.threadId || '尚未建立'}</dd><dt>Turn</dt><dd className="mono">{chosenExecution.turnId || '尚未建立'}</dd><dt>尝试编号</dt><dd className="mono">{chosenExecution.id}</dd></dl></details>}
        {eventError && <div className="notice error compact">状态与事件同步失败：{eventError}</div>}
        {chosenRuntime && <><h3 className="section-title">任务事件<span className="mono">游标 {runtimeEvents.at(-1)?.seq ?? 0}</span></h3>{runtimeEvents.length ? <ol className="events">{runtimeEvents.slice().reverse().map(event => <li className="event" key={event.seq}><div className="event-meta"><span>{event.kind}</span><time>{time(event.createdAt)}</time></div><pre>{JSON.stringify(event.payload, null, 2)}</pre></li>)}</ol> : <p className="no-events">尚无已同步任务事件。</p>}</>}
        <h3 className="section-title">执行事件<span className="mono">游标 {events.at(-1)?.seq ?? 0}</span></h3>
        {events.length ? <ol className="events">{events.slice().reverse().map(event => <EventItem key={event.seq} event={event}/>)}</ol> : <p className="no-events">尚无已同步执行事件。任务可先等待输入或派发。</p>}
        {events.length >= 300 && <p className="no-events">界面显示最近 300 条；完整事件保存在后台账本。</p>}
      </div><footer className="detail-actions">{chosenRuntime ? <>
        {chosenRuntime.paused ? <button className="button" disabled={!online || busy || chosenRuntime.cancelled} onClick={() => { void control('resume'); }}>恢复派发</button> : <button className="button" disabled={!online || busy || ['cancelled', 'awaiting-verification'].includes(chosenRuntime.phase)} onClick={() => { void control('pause'); }}>暂停派发</button>}
        <button className="button danger" disabled={!online || busy || chosenRuntime.cancelled || chosenRuntime.phase === 'awaiting-verification'} onClick={() => { void control('cancel'); }}><Icon name="stop"/>取消任务</button>
        <button className="button" disabled={!online || busy} onClick={() => { void control('reconcile'); }}>核对恢复状态</button>
      </> : chosenExecution && <><button className="button danger" disabled={!online || busy || chosenExecution.stopConfirmed || chosenExecution.cancelRequested} onClick={() => { void control('cancel'); }}><Icon name="stop"/>{chosenExecution.cancelRequested && !chosenExecution.stopConfirmed ? '等待停止确认' : '取消执行'}</button>{(chosenExecution.state === 'unknown' || chosenExecution.state === 'interrupted' || (!active(chosen) && !chosenExecution.stopConfirmed)) && <button className="button" disabled={!online || busy} onClick={() => { void control('reconcile'); }}>停止并核对进程</button>}</>}</footer></aside>}
      </div><footer className="status-strip"><span>{capabilities ? `Codex ${capabilities.version}` : '本地 IPC'} · P3 持久任务</span><span>{lastSync ? `最近同步 ${time(lastSync)}` : '等待后台连接'} · 退出界面不会停止任务</span></footer>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App/>);
