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
  const visible = records.filter(record => !project || record.workspace === project);
  const projects = Array.from(new Set(records.map(record => record.workspace)));
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
        setRecords(result.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
        setConnection('online'); setConnectionError(''); setLastSync(new Date().toISOString());
        const pendingRecord = pendingRef.current && result.find(item => item.commandId === pendingRef.current?.commandId);
        if (pendingRecord) { pendingRef.current = null; setPending(null); setComposer(false); setSelected(pendingRecord.id); setActionError(''); }
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
    const input: StartInput = pending ?? { commandId: crypto.randomUUID(), workspace: workspace.trim(), prompt: prompt.trim(), model, effort, timeoutMs: timeout * 1000, tokenLimit, reservation, verificationReserve, images };
    if (!input.workspace.startsWith('/') || !input.prompt || !input.model || !input.effort) { setActionError('请选择绝对路径工作区，并填写目标、模型和思考深度。'); return; }
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
      pendingRef.current = null; setPending(null); setSelected(record.id); setProject(null); setComposer(false);
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
  async function chooseWorkspace() { try { const path = await api.chooseWorkspace(); if (path) setWorkspace(path); } catch (error) { setActionError(errorText(error)); } }
  async function chooseImages() { try { const paths = await api.chooseImages(); setImages(current => Array.from(new Set([...current, ...paths])).slice(0, 5)); } catch (error) { setActionError(errorText(error)); } }
  const online = connection === 'online';
  const modelSupportsImages = Boolean(capabilities?.imageInput && selectedModel?.inputModalities.includes('image'));
  return <div className="shell">
    <aside className="sidebar" aria-label="项目与运行历史">
      <div className="brand"><span className="brand-mark"><Icon name="agent" size={21}/></span>Supervisor</div>
      <button className={`nav-item ${project === null ? 'active' : ''}`} onClick={() => setProject(null)}><Icon name="grid"/><span>执行工作台</span><span className="count">{records.length}</span></button>
      <div className="eyebrow">Projects / 项目</div>
      <div className="project-list">{projects.length ? projects.map(path => <button className={`nav-item ${project === path ? 'active' : ''}`} key={path} title={path} onClick={() => setProject(path)}><Icon name="folder"/><span>{basename(path)}</span></button>) : <p className="subtle" style={undefined}>任务启动后按工作区归档</p>}</div>
      <div className="eyebrow">History / 运行历史</div>
      <div className="history-list">{records.map(record => <button className={`history-button ${selected === record.id ? 'selected' : ''}`} key={record.id} onClick={() => { setSelected(record.id); setProject(null); }}><strong>{record.prompt}</strong><small>{date(record.createdAt)} · {labels[record.state]}</small></button>)}</div>
      <div className="sidebar-footer"><strong>本地监督服务</strong><br/>关闭窗口或退出界面，<br/>后台任务继续运行。</div>
    </aside>
    <main className="workspace">
      <div className="titlebar">SUPERVISOR / LOCAL WORKSPACE</div>
      <header className="topbar"><div className="heading"><div className="eyebrow">Execution control</div><h1>让每一次执行，都有迹可循。</h1><p>受控单次执行 · 真实事件 · 独立验收前不宣告交付</p></div>
        <div className="toolbar"><span className="connection" role="status"><i className={`dot ${online ? '' : 'offline'}`}/>{online ? '后台已连接' : connection === 'connecting' ? '正在连接' : connection === 'detached' ? '界面已断开' : '后台离线'}</span>
          <button className="button ghost" onClick={refresh} aria-label="重新连接后台"><Icon name="refresh"/>重连</button>
          {online && <button className="button ghost" onClick={() => setMonitoring(false)}>断开界面</button>}
          <button className="button primary" onClick={() => { setComposer(true); setSelected(null); }}><Icon name="plus"/>新任务</button>
        </div></header>
      <div className="content"><section className="board" aria-label="Agent 工作台">
        {connection === 'offline' && <div className="notice error" role="alert">后台暂不可达，保留上次已知状态。请启动独立后台后重连。<br/>{connectionError}</div>}
        {connection === 'detached' && <div className="notice">界面已停止同步。后台执行不受影响；重新连接后从真实事件账本恢复。</div>}
        {actionError && <div className="notice error" role="alert">{actionError}</div>}
        {composer && <form className="composer" onSubmit={event => { void start(event); }} aria-label="新建真实 Codex 任务">
          <div className="composer-head"><h2>开始一次受控执行</h2><button type="button" className="icon-button" aria-label="关闭新任务面板" onClick={() => setComposer(false)}><Icon name="close"/></button></div>
          <p className="form-hint">Codex 会在选定工作区实际读写文件。将目标写成可核对的变更；本阶段只执行一次，不自动重试。</p>
          <fieldset disabled={busy || Boolean(pending)}>
            <label className="field"><span>工作区</span><div className="input-action"><input aria-label="工作区路径" value={workspace} onChange={event => setWorkspace(event.target.value)} placeholder="/绝对路径/你的项目" required/><button type="button" className="button" onClick={() => { void chooseWorkspace(); }}><Icon name="folder"/>选择文件夹</button></div></label>
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
          <div className="composer-footer"><p>执行结束仅表示本次尝试结束。<br/>交付仍须独立验收，本阶段不自动放行。</p><button className="button primary" type="submit" disabled={!online || busy || (!pending && (!model || !effort || !prompt.trim() || !workspace.trim()))}>{busy ? '正在提交…' : pending ? '重试同一请求' : '启动 Codex'}<Icon name="arrow"/></button></div>
        </form>}
        <div className="board-head"><h2>{project ? basename(project) : 'Agent 工作区'}<span className="pill">{visible.length} 次尝试</span></h2><span className="subtle">{records.filter(active).length} 执行中 · 单次控制</span></div>
        {visible.length ? <div className="grid">{visible.map(record => <button key={record.id} className={`agent-card ${selected === record.id ? 'selected' : ''}`} onClick={() => setSelected(record.id)} aria-label={`查看任务：${record.prompt}`}><div className="agent-top"><span className="agent-icon"><Icon name="agent" size={25}/></span><span className="pill">Codex</span></div><div className="agent-role">执行 Agent / 单次尝试</div><h3>{record.prompt}</h3><Status record={record}/><div className="agent-excerpt">{record.error || record.message || (record.state === 'queued' ? '等待控制器建立受管执行。' : '等待执行器事件。')}</div><div className="agent-bottom"><span>{basename(record.workspace)}</span><span>{record.usageStatus === 'reported' && record.usage ? `${count(record.usage.totalTokens)} tokens` : '用量待回报'}</span></div></button>)}</div>
          : <div className="empty"><Icon name="agent" size={36}/><h2>从一个明确的目标开始</h2><p>选择真实项目，让 Codex 执行一次可核对的修改。执行过程、取消结果与用量都留在本地。</p><button className="button primary" onClick={() => setComposer(true)}><Icon name="plus"/>创建第一个任务</button></div>}
        <div className="single-note"><i className="dot"/>卡片展示可观测执行状态；完成标记由独立验收决定。</div>
      </section>
      {chosen && <aside className="detail" aria-label="任务详情"><header className="detail-header"><div className="detail-title"><h2>尝试详情</h2><button className="icon-button" aria-label="关闭任务详情" onClick={() => setSelected(null)}><Icon name="close"/></button></div><p className="detail-goal">{chosen.prompt}</p><Status record={chosen}/></header><div className="detail-body">
        <dl className="facts"><dt>工作区</dt><dd>{chosen.workspace}</dd><dt>模型 / 深度</dt><dd>{chosen.model} / {chosen.effort}</dd><dt>开始时间</dt><dd>{date(chosen.createdAt)}</dd><dt>超时期限</dt><dd>{date(chosen.deadline)}</dd><dt>累计用量</dt><dd>{chosen.usageStatus === 'reported' && chosen.usage ? `${count(chosen.usage.totalTokens)} tokens` : '未知 · 待执行器回报'}</dd><dt>预算</dt><dd>{count(chosen.tokenLimit)} tokens · 验收预留 {count(chosen.verificationReserve)}</dd><dt>进程状态</dt><dd>{chosen.stopConfirmed ? '已确认停止' : '尚未确认停止'}{chosen.pid ? ` · PID ${chosen.pid}` : ''}</dd><dt>会话</dt><dd className="mono">{chosen.threadId || '尚未建立'}</dd><dt>Turn</dt><dd className="mono">{chosen.turnId || '尚未建立'}</dd><dt>尝试编号</dt><dd className="mono">{chosen.id}</dd></dl>
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
