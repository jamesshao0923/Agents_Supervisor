import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ExecutionEvent, ExecutionRecord, ExecutionStart, ExecutionState, ExecutorCapabilities } from '../../packages/contracts/p2.js';

type StartInput = Omit<ExecutionStart, 'type'>;
type StartResult = { accepted: true; record: ExecutionRecord } | { accepted: false; error: string };
interface DesktopAPI {
  health(): Promise<unknown>;
  list(): Promise<ExecutionRecord[]>;
  inspect(id: string): Promise<ExecutionRecord>;
  events(id: string, after: number): Promise<ExecutionEvent[]>;
  capabilities(): Promise<ExecutorCapabilities>;
  start(input: StartInput): Promise<StartResult>;
  cancel(id: string): Promise<ExecutionRecord>;
  reconcile(id: string): Promise<ExecutionRecord>;
  chooseWorkspace(): Promise<string | null>;
  openWorkspace(id: string): Promise<void>;
  chooseImages(): Promise<string[]>;
}
declare global { interface Window { supervisor: DesktopAPI } }
const api = window.supervisor;
const labels: Record<ExecutionState, string> = {
  queued: '已排队', starting: '启动中', running: '执行中', waiting: '等待执行器', cancelling: '取消中 · 核对进程',
  completed: '执行结束 · 待验收', cancelled: '已取消', failed: '执行失败', interrupted: '执行中断', unknown: '状态待核对'
};
const active = (record: ExecutionRecord) => ['queued', 'starting', 'running', 'waiting', 'cancelling'].includes(record.state);
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
function Status({ record }: { record: ExecutionRecord }) {
  const color = ['failed', 'unknown', 'interrupted'].includes(record.state) ? 'failed' : ['cancelled', 'completed'].includes(record.state) ? 'stopped' : '';
  return <span className={`agent-status ${color}`}><i className="dot"/>{labels[record.state]}</span>;
}
function EventItem({ event }: { event: ExecutionEvent }) {
  return <li className="event"><div className="event-meta"><span>{event.kind}</span><time>{time(event.receivedAt)}</time></div><pre>{typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload, null, 2)}</pre></li>;
}
function App() {
  const [records, setRecords] = useState<ExecutionRecord[]>([]);
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
        const result = await api.list();
        if (ended) return;
        const ordered = result.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setRecords(ordered);
        setProject(current => current && ordered.some(item => item.workspace === current) ? current : ordered[0]?.workspace ?? null);
        setConnection('online'); setConnectionError(''); setLastSync(new Date().toISOString());
        const pendingRecord = pendingRef.current && result.find(item => item.commandId === pendingRef.current?.commandId);
        if (pendingRecord) { pendingRef.current = null; setPending(null); setComposer(false); setSelected(pendingRecord.id); setProject(pendingRecord.workspace); setCollapsed(current => { const next = new Set(current); next.delete(pendingRecord.workspace); return next; }); setActionError(''); }
      } catch (error) { if (!ended) { setConnection('offline'); setConnectionError(errorText(error)); } }
      if (!ended) timer = globalThis.setTimeout(poll, 2000);
    }
    void poll();
    return () => { ended = true; globalThis.clearTimeout(timer); };
  }, [monitoring, revision]);
  useEffect(() => { if (connection === 'online' && composer && !capabilities && !capError) void loadCapabilities(); }, [connection, composer, capabilities, capError, loadCapabilities]);
  useEffect(() => {
    setEvents([]); setEventError('');
    if (!selected || !monitoring) return;
    const executionId = selected;
    let ended = false, cursor = 0;
    let timer: ReturnType<typeof globalThis.setTimeout>;
    async function poll() {
      try {
        const batch = await api.events(executionId, cursor);
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
  }, [selected, monitoring, revision]);
  const refresh = () => { setMonitoring(true); setConnection('connecting'); setRevision(value => value + 1); };
  async function start(event: React.FormEvent) {
    event.preventDefault(); setActionError('');
    const input: StartInput = pending ?? { commandId: crypto.randomUUID(), ...(workspace.trim() ? { workspace: workspace.trim() } : {}), prompt: prompt.trim(), model, effort, timeoutMs: timeout * 1000, tokenLimit, reservation, verificationReserve, images };
    if ((input.workspace && !input.workspace.startsWith('/')) || !input.prompt || !input.model || !input.effort) { setActionError('请填写目标、模型和思考深度；工作区可留空，填写时须使用绝对路径。'); return; }
    if (![input.timeoutMs, tokenLimit, reservation, verificationReserve].every(Number.isSafeInteger) || timeout < 1 || timeout > 3600 || reservation < 1 || verificationReserve < 0 || reservation + verificationReserve > tokenLimit) { setActionError('超时须为 1–3600 秒；总额度须覆盖执行预留与独立验收预留。'); return; }
    pendingRef.current = input; setPending(input); setBusy(true);
    try {
      const result = await api.start(input);
      if (!result.accepted) {
        pendingRef.current = null; setPending(null);
        setActionError(`${result.error}。后台已拒绝本次请求；请修改后重新提交。`);
        return;
      }
      const record = result.record;
      setRecords(current => [record, ...current.filter(item => item.id !== record.id)]);
      pendingRef.current = null; setPending(null); setSelected(record.id); setProject(record.workspace); setCollapsed(current => { const next = new Set(current); next.delete(record.workspace); return next; }); setComposer(false);
      setRevision(value => value + 1);
    } catch (error) { setActionError(`${errorText(error)}。请求编号已保留；请先重连核对，重试将使用同一编号。`); }
    finally { setBusy(false); }
  }
  async function control(kind: 'cancel' | 'reconcile') {
    if (!chosen) return;
    setBusy(true); setActionError('');
    try { const record = await api[kind](chosen.id); setRecords(current => current.map(item => item.id === record.id ? record : item)); setRevision(value => value + 1); }
    catch (error) { setActionError(errorText(error)); }
    finally { setBusy(false); }
  }
  function newTask(path: string | null = null) {
    setComposer(true); setSelected(null); setActionError('');
    if (pendingRef.current) return;
    setWorkspace(path ?? ''); setPrompt(''); setImages([]);
  }
  function selectTask(record: ExecutionRecord) { setSelected(record.id); setProject(record.workspace); setComposer(false); }
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
        {!collapsed.has(item.path) && <div className="project-tasks">{item.tasks.map(record => <button className={`task-button ${selected === record.id ? 'selected' : ''}`} key={record.id} title={record.prompt} onClick={() => selectTask(record)}><strong>{record.prompt}</strong><small><i className={`dot ${active(record) ? '' : 'inactive'}`}/>{labels[record.state]} · {date(record.createdAt)}</small></button>)}</div>}
      </section>) : <p className="subtle">任务将归入所选项目；未选择目录时自动创建暂存工作区。</p>}</nav>
      <div className="sidebar-footer"><strong>本地监督服务</strong><br/>关闭窗口或退出界面，<br/>后台任务继续运行。</div>
    </aside>
    <main className="workspace">
      <div className="titlebar">SUPERVISOR / LOCAL WORKSPACE</div>
      <header className="topbar"><div className="heading"><div className="eyebrow">Execution control</div><h1>让每一次执行，都有迹可循。</h1><p>受控单次执行 · 真实事件 · 独立验收前不宣告交付</p></div>
        <div className="toolbar"><span className="connection" role="status"><i className={`dot ${online ? '' : 'offline'}`}/>{online ? '后台已连接' : connection === 'connecting' ? '正在连接' : connection === 'detached' ? '界面已断开' : '后台离线'}</span>
          <button className="button ghost" onClick={refresh} aria-label="重新连接后台"><Icon name="refresh"/>重连</button>
          {online && <button className="button ghost" onClick={() => setMonitoring(false)}>断开界面</button>}
          <button className="button primary" onClick={() => newTask(project)}><Icon name="plus"/>{project ? '在此项目新建' : '新任务'}</button>
        </div></header>
      <div className="content"><section className="board" aria-label="Agent 工作台">
        {connection === 'offline' && <div className="notice error" role="alert">后台暂不可达，保留上次已知状态。请启动独立后台后重连。<br/>{connectionError}</div>}
        {connection === 'detached' && <div className="notice">界面已停止同步。后台执行不受影响；重新连接后从真实事件账本恢复。</div>}
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
              <label className="field"><span>验收预留（tokens）</span><input aria-label="验收预留" type="number" min="0" value={verificationReserve} onChange={event => setVerificationReserve(Number(event.target.value))}/></label>
            </div><p className="form-hint">按执行器回报的原始 token 用量监控额度，包含缓存 token，不代表金额。验收额度单独保留；未知用量不当作零消耗。</p></details>
          </fieldset>
          {capError && <div className="validation" role="alert">模型能力发现失败：{capError} <button type="button" className="plain-button" onClick={() => { void loadCapabilities(); }} disabled={!online || capLoading}>重新发现</button></div>}
          {pending && <p className="form-hint mono">待核对请求：{pending.commandId}</p>}
          <div className="composer-footer"><p>执行结束仅表示本次尝试结束。<br/>交付仍须独立验收，本阶段不自动放行。</p><button className="button primary" type="submit" disabled={!online || busy || (!pending && (!model || !effort || !prompt.trim()))}>{busy ? '正在提交…' : pending ? '重试同一请求' : '启动 Codex'}<Icon name="arrow"/></button></div>
        </form>}
        <div className="board-head"><h2><span className="project-heading">{currentProject ? projectName(currentProject) : '项目工作台'}</span><span className="pill">{visible.length} 个任务</span></h2><span className="subtle">{visible.filter(active).length} 执行中 · 单次控制</span></div>
        {currentProject && <div className="project-context"><span className="mono" title={currentProject.path}>{currentProject.path}</span><button className="button ghost" onClick={() => { void openWorkspace(currentProject.tasks[0]!.id); }}><Icon name="folder"/>打开目录</button></div>}
        {visible.length ? <div className="grid">{visible.map(record => <button key={record.id} className={`agent-card ${selected === record.id ? 'selected' : ''}`} onClick={() => selectTask(record)} aria-label={`查看任务：${record.prompt}`}><div className="agent-top"><span className="agent-icon"><Icon name="agent" size={25}/></span><span className="pill">Codex</span></div><div className="agent-role">执行 Agent / 单次尝试</div><h3>{record.prompt}</h3><Status record={record}/><div className="agent-excerpt">{record.error || record.message || (record.state === 'queued' ? '等待控制器建立受管执行。' : '等待执行器事件。')}</div><div className="agent-bottom"><span title={record.workspace}>{record.workspaceKind === 'managed' ? '暂存工作区' : basename(record.workspace)}</span><span>{record.usageStatus === 'reported' && record.usage ? `${count(record.usage.totalTokens)} tokens` : '用量待回报'}</span></div></button>)}</div>
          : <div className="empty"><Icon name="agent" size={36}/><h2>从一个明确的目标开始</h2><p>选择已有项目，或直接描述目标。没有项目目录时，Supervisor 会自动创建暂存工作区。</p><button className="button primary" onClick={() => newTask(project)}><Icon name="plus"/>创建第一个任务</button></div>}
        <div className="single-note"><i className="dot"/>卡片展示可观测执行状态；完成标记由独立验收决定。</div>
      </section>
      {chosen && <aside className="detail" aria-label="任务详情"><header className="detail-header"><div className="detail-title"><h2>尝试详情</h2><button className="icon-button" aria-label="关闭任务详情" onClick={() => setSelected(null)}><Icon name="close"/></button></div><p className="detail-goal">{chosen.prompt}</p><Status record={chosen}/></header><div className="detail-body">
        <dl className="facts"><dt>项目目录</dt><dd>{chosen.workspace}<br/><span className="subtle">{chosen.workspaceKind === 'managed' ? 'Supervisor 暂存工作区 · 持续保留' : '本地项目'}</span></dd><dt>模型 / 深度</dt><dd>{chosen.model} / {chosen.effort}</dd><dt>开始时间</dt><dd>{date(chosen.createdAt)}</dd><dt>超时期限</dt><dd>{date(chosen.deadline)}</dd><dt>累计用量</dt><dd>{chosen.usageStatus === 'reported' && chosen.usage ? `${count(chosen.usage.totalTokens)} tokens` : '未知 · 待执行器回报'}</dd><dt>预算</dt><dd>{count(chosen.tokenLimit)} tokens · 验收预留 {count(chosen.verificationReserve)}</dd><dt>进程状态</dt><dd>{chosen.stopConfirmed ? '已确认停止' : '尚未确认停止'}{chosen.pid ? ` · PID ${chosen.pid}` : ''}</dd><dt>会话</dt><dd className="mono">{chosen.threadId || '尚未建立'}</dd><dt>Turn</dt><dd className="mono">{chosen.turnId || '尚未建立'}</dd><dt>尝试编号</dt><dd className="mono">{chosen.id}</dd></dl>
        {chosen.state === 'completed' && <div className="notice compact">执行结束，待独立验收。尚未判定为已交付。</div>}
        {chosen.error && <div className="notice error compact">{chosen.error}</div>}
        {chosen.message && <><h3 className="section-title">执行器输出</h3><div className="result">{chosen.message}</div></>}
        {chosen.diff && <details><summary className="section-title">查看变更差异</summary><pre className="result mono">{chosen.diff}</pre></details>}
        <h3 className="section-title">事件轨迹<span className="mono">游标 {events.at(-1)?.seq ?? 0}</span></h3>
        {eventError && <div className="notice error compact">事件同步失败：{eventError}</div>}
        {events.length ? <ol className="events">{events.slice().reverse().map(event => <EventItem key={event.seq} event={event}/>)}</ol> : <p className="no-events">尚无已同步事件。事件来自真实后台，不从界面推断。</p>}
        {events.length >= 300 && <p className="no-events">界面显示最近 300 条；完整事件保存在后台账本。</p>}
      </div><footer className="detail-actions"><button className="button danger" disabled={!online || busy || chosen.stopConfirmed || chosen.cancelRequested} onClick={() => { void control('cancel'); }}><Icon name="stop"/>{chosen.cancelRequested && !chosen.stopConfirmed ? '等待停止确认' : '取消执行'}</button>{(chosen.state === 'unknown' || chosen.state === 'interrupted' || (!active(chosen) && !chosen.stopConfirmed)) && <button className="button" disabled={!online || busy} onClick={() => { void control('reconcile'); }}>停止并核对进程</button>}</footer></aside>}
      </div><footer className="status-strip"><span>{capabilities ? `Codex ${capabilities.version}` : '本地 IPC'} · P2 受控单次执行</span><span>{lastSync ? `最近同步 ${time(lastSync)}` : '等待后台连接'} · 退出界面不会停止任务</span></footer>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App/>);
