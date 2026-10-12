import { TOKEN_TIERS, formatTokenLimit, tokenCapacity, type TokenTier } from '../../packages/contracts/token-policy.js';
import { TokenTierSelector } from './token-tier-selector.js';
import {TaskClarification, TaskComposer} from './task-conversation.js';
import {validateTaskAttachments, type TaskAttachment} from '../../packages/contracts/task-attachments.js';
import {ResearchGroupsProposal} from './research-groups-panel.js';
import {ExplorationSelector,ExplorationProposal,ExplorationPanel,type ExplorationDesktopAPI} from './exploration-panel.js';
import type {ExplorationTier} from '../../packages/contracts/p7-scheduler.js';
import {VerificationVersionsPanel,type DeliveryDesktopAPI} from './verification-versions-panel.js';
import {AgentWorkbench} from './agent-workbench.js';
import type {WorkbenchSnapshot} from '../../packages/contracts/p8-workbench.js';
import {SupervisionPanel,type SupervisionDesktopAPI} from './supervision-panel.js';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ExecutionEvent, ExecutionRecord, ExecutionState, ExecutorCapabilities } from '../../packages/contracts/p2.js';

import type { RuntimeRecord, RuntimePhase, RuntimeOperation, RuntimeCheckpoint, RuntimeEvent } from '../../packages/contracts/p3.js';
import type { Run } from '../../packages/contracts/p1.js';
import type { Delivery, FrozenPlan, ModelConfig, Proposal, VerificationAction, VerificationJob } from '../../packages/verification/records.js';
import { buildTimeline, describeGoalProblem, describeTaskError, describeVerificationProblem, describeDeliveryAssessment, goalPhaseLabels, goalSessionId, mergeGoalSessions, conversationTaskViews, activeConversationTaskId, conversationStateLabels, preferredTaskModel, taskModelOptions, goalCanAnswer, goalCanRestore } from './presentation.js';
import type { DeliveryAssessment } from '../../packages/contracts/p4-delivery-status.js';
import type { DesktopTask as TaskRecord, TimelineEntry } from './presentation.js';

import { parseOrchestrationAction } from '../../packages/contracts/p5.js';
import type { ConversationAction, ConversationInspection } from '../../packages/contracts/p6-actions.js';
import type { ConversationRound } from '../../packages/contracts/p6.js';
import type { GoalInspection, GoalSession, OrchestrationAction } from '../../packages/contracts/p5.js';

type GoalStart = Extract<OrchestrationAction, { type: 'start' }>;
type StartInput = Omit<GoalStart, 'type'>;
type StartResult = { accepted: true; record: GoalInspection } | { accepted: false; error: string };
type GoalMutation = Exclude<OrchestrationAction, { type: 'start' | 'list' | 'inspect' }>;
interface RuntimeInspection { runtime: RuntimeRecord; run: Run; operations: RuntimeOperation[]; checkpoints: { checkpoint: RuntimeCheckpoint; digest: string; valid: boolean }[] }
interface VerificationStatus { proposals: Proposal[]; plans: FrozenPlan[]; jobs: VerificationJob[]; deliveries: Delivery[]; currentDelivery: { current: boolean; reason: string; delivery: Delivery | null; assessment?: DeliveryAssessment | null } }
type VerificationMutation = Exclude<VerificationAction, { type: 'status' | 'job' | 'open' | 'close-open' | 'open-session' }>;
type ConversationSend = Omit<Extract<ConversationAction, {type: 'send'}>, 'type'>;
interface DesktopAPI extends SupervisionDesktopAPI,DeliveryDesktopAPI,ExplorationDesktopAPI {
  conversationList(): Promise<ConversationInspection[]>;
  conversationForSession(sessionId: string): Promise<ConversationInspection>;
  conversationInspect(conversationId: string): Promise<ConversationInspection>;
  conversationSend(input: ConversationSend): Promise<ConversationInspection>;
  conversationCancelAssessment(input: Omit<Extract<ConversationAction, {type: 'cancelAssessment'}>, 'type'>): Promise<ConversationInspection>;
  conversationRetry(input: Omit<Extract<ConversationAction, {type: 'retry'}>, 'type'>): Promise<ConversationInspection>;
  health(): Promise<unknown>;
  orchestrationList(): Promise<GoalSession[]>;
  orchestrationInspect(id: string): Promise<GoalInspection>;
  orchestrationStart(input: StartInput): Promise<StartResult>;
  orchestrationAnswer(input: Omit<Extract<GoalMutation, { type: 'answer' }>, 'type'>): Promise<GoalInspection>;
  orchestrationAdmit(input: Omit<Extract<GoalMutation, { type: 'admit' }>, 'type'>): Promise<GoalInspection>;
  orchestrationRestore(input: Omit<Extract<GoalMutation, { type: 'restore' }>, 'type'>): Promise<GoalInspection>;
  orchestrationCancel(input: Omit<Extract<GoalMutation, { type: 'cancel' }>, 'type'>): Promise<GoalInspection>;
  list(): Promise<ExecutionRecord[]>;
  inspect(id: string): Promise<ExecutionRecord>;
  events(id: string, after: number): Promise<ExecutionEvent[]>;
  capabilities(): Promise<ExecutorCapabilities>;
  workbenchRead(projectPath:string):Promise<WorkbenchSnapshot>;
  runtimeList(): Promise<RuntimeRecord[]>;
  runtimeInspect(id: string): Promise<RuntimeInspection>;
  runtimeEvents(id: string, after: number): Promise<RuntimeEvent[]>;
  runtimePause(id: string, commandId: string): Promise<RuntimeRecord>;
  runtimeResume(id: string, commandId: string): Promise<RuntimeRecord>;
  runtimeCancel(id: string, commandId: string): Promise<RuntimeRecord>;
  runtimeReconcile(id: string, commandId: string): Promise<RuntimeRecord>;
  runtimeInput(id: string, commandId: string, stepId: string, text: string): Promise<RuntimeRecord>;
  verificationStatus(id: string): Promise<VerificationStatus>;
  verificationPropose(id: string, commandId: string, specPath: string): Promise<Proposal>;
  verificationReview(proposalId: string, commandId: string, config: ModelConfig): Promise<VerificationJob>;
  verificationPublish(proposalId: string, reviewId: string, commandId: string): Promise<Proposal>;
  verificationFreeze(id: string, commandId: string): Promise<FrozenPlan>;
  verificationRun(planId: string, commandId: string, config: ModelConfig): Promise<VerificationJob>;
  verificationDeliver(jobId: string, commandId: string): Promise<Delivery>;
  verificationCancel(jobId: string): Promise<VerificationJob>;
  chooseVerificationSpec(): Promise<string | null>;
  cancel(id: string): Promise<ExecutionRecord>;
  reconcile(id: string): Promise<ExecutionRecord>;
  chooseWorkspace(): Promise<string | null>;
  openProjectDirectory(path: string): Promise<void>;
  openWorkspace(id: string): Promise<void>;
  chooseTaskAttachments(sessionId: string): Promise<TaskAttachment[]>;
  chooseImages(): Promise<string[]>;
}
declare global { interface Window { supervisor: DesktopAPI } }
const api = window.supervisor;
const labels: Record<ExecutionState | RuntimePhase, string> = {
  queued: '已排队', starting: '启动中', running: '执行中', waiting: '等待执行器', cancelling: '取消中 · 核对进程',
  ready: '等待派发', 'waiting-input': '等待输入', paused: '已暂停派发', blocked: '恢复阻塞 · 待核对', 'awaiting-verification': '步骤已结束 · 待独立验收',
  completed: '执行结束 · 待验收', cancelled: '已取消', failed: '执行失败', interrupted: '执行中断', unknown: '状态待核对'
};
const active = (record: TaskRecord) => record.session ? record.session.phase === 'thinking' : ['ready', 'queued', 'starting', 'running', 'waiting', 'cancelling'].includes(record.state) || Boolean(record.execution && !record.execution.stopConfirmed && ['starting', 'running', 'waiting', 'cancelling'].includes(record.execution.state));
const statusLabel = (record: TaskRecord) => record.session ? goalPhaseLabels[record.session.phase] : record.runtime?.cancelled && record.execution && !record.execution.stopConfirmed ? '取消已请求 · 待停止核对' : labels[record.state as ExecutionState | RuntimePhase];
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
function Status({ record, deliveryLabel = '' }: { record: TaskRecord; deliveryLabel?: string }) {
  const color = ['failed', 'unknown', 'interrupted', 'blocked'].includes(record.state) ? 'failed' : ['cancelled', 'completed', 'awaiting-verification', 'paused', 'waiting-input'].includes(record.state) ? 'stopped' : '';
  return <span className={`agent-status ${deliveryLabel ? deliveryLabel.includes('重新核验') ? 'failed' : 'stopped' : color}`}><i className="dot"/>{deliveryLabel || statusLabel(record)}</span>;
}
function EventItem({ entry }: { entry: TimelineEntry }) {
  return <li className={`event ${entry.tone || ''}`}><div className="event-meta"><span>{entry.source}</span><time dateTime={entry.at} title={date(entry.at)}>{time(entry.at)}</time></div><h4 className="event-title">{entry.title}</h4><p className="event-description">{entry.description}</p><details className="technical-details"><summary>查看此事件的技术详情</summary><p className="mono subtle">{entry.event.kind} · 事件 {entry.event.seq}</p><pre>{JSON.stringify(entry.event.payload, null, 2)}</pre></details></li>;
}
function App() {
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeRecord[]>([]);
  const [sessions, setSessions] = useState<GoalSession[]>([]);
  const [attachments, setAttachments] = useState<TaskAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [attachmentError, setAttachmentError] = useState('');
  const [conversations, setConversations] = useState<ConversationInspection[]>([]);
  const [conversationError, setConversationError] = useState('');
  const [conversationBusy, setConversationBusy] = useState(false);
  const [chatText, setChatText] = useState('');
  const [chatKind, setChatKind] = useState<ConversationSend['kind']>('unclassified');
  const [replyToMessageId, setReplyToMessageId] = useState<string | null>(null);
  const [chatPending, setChatPending] = useState<ConversationSend | null>(null);
  const chatPendingRef = useRef<ConversationSend | null>(null);
  const conversationGeneration = useRef(0);
  const [showGoalDetails, setShowGoalDetails] = useState(false);
  const [roundHistory, setRoundHistory] = useState<{round: ConversationRound; goal: GoalInspection; verification: VerificationStatus | null} | null>(null);
  const [historyError, setHistoryError] = useState('');

  const [goalDetail, setGoalDetail] = useState<GoalInspection | null>(null);
  const [goalReadError, setGoalReadError] = useState('');
  const [goalActionError, setGoalActionError] = useState('');
  const [goalLoading, setGoalLoading] = useState(false);
  const [answerText, setAnswerText] = useState('');
  const [goalPending, setGoalPending] = useState<GoalMutation | null>(null);
  const goalPendingRef = useRef<GoalMutation | null>(null);
  const pendingSessionIdRef = useRef<string | null>(null);
  const [runtimeDetail, setRuntimeDetail] = useState<RuntimeInspection | null>(null);
  const [runtimeEvents, setRuntimeEvents] = useState<RuntimeEvent[]>([]);
  const [inputText, setInputText] = useState('');
  const [verificationData, setVerificationData] = useState<{ runtimeId: string; value: VerificationStatus; checkedAt: string } | null>(null);
  const [verificationError, setVerificationError] = useState('');
  const [verificationReadError, setVerificationReadError] = useState('');
  const [verificationLoading, setVerificationLoading] = useState(false);
  const [verificationRevision, setVerificationRevision] = useState(0);
  const [specPath, setSpecPath] = useState('');
  const [proposalId, setProposalId] = useState('');
  const [planId, setPlanId] = useState('');
  const [reviewModel, setReviewModel] = useState('');
  const [reviewEffort, setReviewEffort] = useState('');
  const [reviewReservation, setReviewReservation] = useState(20000);
  const [reviewTimeout, setReviewTimeout] = useState(300);
  const [verificationPending, setVerificationPending] = useState<{ runtimeId: string; action: VerificationMutation } | null>(null);
  const records = conversationTaskViews(runtimes, executions.filter(record=>!record.scheduledBinding), sessions, conversations);
  const [connection, setConnection] = useState<'connecting' | 'online' | 'offline' | 'detached'>('connecting');
  const [monitoring, setMonitoring] = useState(true);
  const [revision, setRevision] = useState(0);
  const [connectionError, setConnectionError] = useState('');
  const [actionError, setActionError] = useState('');
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(true);
  const [project, setProject] = useState<string | null>(null);
  const [mountedPaths,setMountedPaths]=useState<string[]>([]);
  const mountedPathsRef=useRef<string[]>([]);
  const [workbenchData,setWorkbenchData]=useState<{path:string;snapshot:WorkbenchSnapshot|null;error:string}|null>(null);
  useEffect(()=>{let ended=false,timer:ReturnType<typeof globalThis.setTimeout>;setWorkbenchData(null);if(!project||!monitoring)return;const path=project;async function read(){try{const snapshot=await api.workbenchRead(path);if(!ended)setWorkbenchData({path,snapshot,error:''});}catch(error){if(!ended)setWorkbenchData({path,snapshot:null,error:errorText(error)});}if(!ended)timer=globalThis.setTimeout(read,2000);}void read();return()=>{ended=true;globalThis.clearTimeout(timer);};},[project,monitoring,revision]);
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
  const [maxContextChars, setMaxContextChars] = useState(60000);
  const [timeout, setTimeoutValue] = useState(300);
  const [tokenTier, setTokenTier] = useState<TokenTier>('medium');
  const {limit:tokenLimit,reservation,verificationReserve} = TOKEN_TIERS[tokenTier];
  const [pending, setPending] = useState<StartInput | null>(null);
  const pendingRef = useRef<StartInput | null>(null);
  const capabilityLoading = useRef(false);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const verificationPendingRef = useRef<typeof verificationPending>(null);
  const chosen = records.find(record => record.id === selected) ?? null;
  const selectedConversation = conversations.find(value => value.conversation.id === chosen?.conversationId || value.rounds.some(round => round.sessionId === selected || round.runId === selected)) ?? null;
  const selectedConversationRef = useRef<string | null>(null); selectedConversationRef.current = selectedConversation?.conversation.id ?? null;
  const selectedSession = sessions.find(session => session.id === selected) ?? null;
  const selectedGoal = goalDetail?.session.id === selected ? goalDetail : null;
  const goalSession = chosen?.runtime && !showGoalDetails ? null : selectedSession && (!selectedGoal || selectedSession.revision > selectedGoal.session.revision) ? selectedSession : selectedGoal?.session ?? selectedSession;
  const latestRestore = goalSession?.jobs.filter(job => job.purpose === 'restore' && job.status === 'finished' && job.stopConfirmed && job.usage !== null && !job.error && job.proposal?.summary.trim()).slice().sort((a, b) => (b.finishedAt || b.startedAt).localeCompare(a.finishedAt || a.startedAt))[0];
  const chosenRuntime = chosen?.runtime;
  const associatedSession = sessions.find(session => session.runtimeId === chosenRuntime?.id);
  const sessionRuntime = runtimes.find(runtime => runtime.id === goalSession?.runtimeId);
  const chosenExecution = chosen?.execution;
  const detail = runtimeDetail?.runtime.id === selected ? runtimeDetail : null;
  const waitingStep = chosenRuntime?.definition.steps[chosenRuntime.cursor];
  const isRuntime = Boolean(chosenRuntime);
  const childExecutionId = chosenExecution?.id;
  const verification = verificationData?.runtimeId === selected ? verificationData.value : null;
  const timeline = buildTimeline(runtimeEvents, events, chosenRuntime, detail?.operations);
  const newest = <T extends { createdAt: string }>(values: T[]): T[] => values.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const proposal = verification?.proposals.find(value => value.id === proposalId) ?? (verification ? newest(verification.proposals)[0] : undefined);
  const plan = verification?.plans.find(value => value.id === planId) ?? (verification ? newest(verification.plans)[0] : undefined);
  const jobs = verification?.jobs.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt)) ?? [];
  const reviewJob = jobs.find(job => job.kind === 'review' && job.proposalId === proposal?.id);
  const verificationJob = jobs.find(job => job.kind === 'verification' && job.planId === plan?.id);
  const activeVerificationJob = jobs.find(job => job.status === 'running');
  const modelOptions = taskModelOptions(capabilities?.models ?? []);
  const reviewCapability = modelOptions.find(value => value.id === reviewModel)?.capability;
  const unavailableModelLabels = modelOptions.filter(value => !value.capability).map(value => value.label).join("、");
  const availableBudget = detail ? Math.max(0, tokenCapacity(detail.run.budget.limit) - detail.run.budget.spent - detail.run.attempts.filter(attempt => !attempt.settled).reduce((sum, attempt) => sum + attempt.reservation, 0)) : null;
  const visible = records.filter(record => record.workspace === project);
  const projects = Array.from(new Set([...mountedPaths,...records.map(record => record.workspace)])).map(path => ({
    path, tasks: records.filter(record => record.workspace === path),
    managed: records.some(record => record.workspace === path && record.workspaceKind === 'managed')
  }));
  const currentProject = projects.find(item => item.path === project);
  const projectName = (item: typeof projects[number]) => {
    if (!item.managed) return basename(item.path);
    const title = item.tasks.at(-1)!.prompt.split(/[\n：:。]/)[0]!.trim();
    return title.length > 28 ? title.slice(0, 28) + '…' : title || '暂存工作区';
  };
  const selectedModel = modelOptions.find(item => item.id === model)?.capability;
  const loadCapabilities = useCallback(async () => {
    if (capabilityLoading.current) return;
    capabilityLoading.current = true; setCapLoading(true); setCapError('');
    try {
      const result = await api.capabilities(); setCapabilities(result);
      const first = taskModelOptions(result.models).find(item => item.id === preferredTaskModel)?.capability;
      if (first) { setModel(current => current || first.id); setEffort(current => current || first.defaultEffort || first.reasoningEfforts[0] || ''); }
      if (!taskModelOptions(result.models).some(item => item.capability)) setCapError('Codex CLI 尚未公布这四个型号中的任何可用模型。请核对 CLI 与账户后重启后台。');
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
        const generation = conversationGeneration.current;
        const [result, durable, goals, chats] = await Promise.all([api.list(), api.runtimeList(), api.orchestrationList(), api.conversationList()]);
        if (ended) return;
        const ordered = conversationTaskViews(durable, result.filter(record=>!record.scheduledBinding), goals, chats);
        setExecutions(result); setRuntimes(durable); setSessions(current => mergeGoalSessions(current, [...goals, ...chats.map(value => value.active.session)]));
        if (generation === conversationGeneration.current) {
          setConversations(chats);
          setSelected(current => current ? activeConversationTaskId(chats, current) : current);
          const pendingMessage = chatPendingRef.current;
          if (pendingMessage && chats.some(value => value.messages.some(message => message.commandId === pendingMessage.commandId))) {
            chatPendingRef.current = null; setChatPending(null);
            if (selectedConversationRef.current === pendingMessage.conversationId) { setChatText(''); setAttachments([]); setReplyToMessageId(null); setConversationError(''); }
          }
        }

        setProject(current => current && (mountedPathsRef.current.includes(current)||ordered.some(item => item.workspace === current)) ? current : null);
        setConnection('online'); setConnectionError(''); setLastSync(new Date().toISOString());
        const pendingRecord = pendingRef.current && goals.find(item => item.id === pendingSessionIdRef.current);
        if (pendingRecord) { pendingRef.current = null; pendingSessionIdRef.current = null; setPending(null); setComposer(false); setSelected(pendingRecord.id); setDetailOpen(true); setProject(pendingRecord.workspace); setCollapsed(current => { const next = new Set(current); next.delete(pendingRecord.workspace); return next; }); setActionError(''); }
      } catch (error) { if (!ended) { setConnection('offline'); setConnectionError(errorText(error)); } }
      if (!ended) timer = globalThis.setTimeout(poll, 2000);
    }
    void poll();
    return () => { ended = true; globalThis.clearTimeout(timer); };
  }, [monitoring, revision]);
  useEffect(() => { if (connection === 'online' && composer && !capabilities && !capError) void loadCapabilities(); }, [connection, composer, capabilities, capError, loadCapabilities]);
  useEffect(() => {
    setGoalDetail(null); setGoalReadError(''); setGoalActionError(''); setAnswerText(''); setAttachments([]); setAttachmentError(''); setShowGoalDetails(false); setChatText(''); setReplyToMessageId(null); setRoundHistory(null); setHistoryError(''); setConversationError('');
  }, [selected]);
  useEffect(() => {
    if (!selected?.startsWith('goal-') || !monitoring || connection !== 'online') { setGoalLoading(false); return; }
    const sessionId = selected; let ended = false;
    let timer: ReturnType<typeof globalThis.setTimeout>;
    async function poll() {
      setGoalLoading(true);
      try {
        const inspection = await api.orchestrationInspect(sessionId);
        if (ended) return;
        setGoalDetail(current => current?.session.id === sessionId && current.session.revision > inspection.session.revision ? current : inspection);
        setSessions(current => mergeGoalSessions(current, [inspection.session])); setGoalReadError('');
      } catch (error) { if (!ended) setGoalReadError(errorText(error)); }
      finally { if (!ended) setGoalLoading(false); }
      if (!ended) timer = globalThis.setTimeout(poll, 2000);
    }
    void poll(); return () => { ended = true; globalThis.clearTimeout(timer); };
  }, [selected, monitoring, connection, revision]);
  useEffect(() => {
    if (!selectedSession || selectedConversation || !monitoring || connection !== 'online') return;
    let ended = false;
    void api.conversationForSession(selectedSession.id).then(value => {if (!ended) rememberConversation(value);}).catch(error => {if (!ended) setConversationError(`跟进记录读取失败：${errorText(error)}`);});
    return () => {ended = true;};
  }, [selectedSession?.id, selectedConversation?.conversation.id, monitoring, connection, revision]);
  useEffect(() => {
    setSpecPath(''); setProposalId(''); setPlanId(''); setVerificationError(''); setVerificationReadError(''); setVerificationData(null);
    setReviewModel(chosenExecution?.model || model); setReviewEffort(chosenExecution?.effort || effort);
    setReviewReservation(chosenRuntime?.definition.verificationReserve || 20000);
  }, [selected]);
  useEffect(() => {
    if (connection === 'online' && chosenRuntime?.phase === 'awaiting-verification' && !capabilities && !capError) void loadCapabilities();
    if (!reviewModel && model) { setReviewModel(model); setReviewEffort(effort); }
  }, [connection, chosenRuntime?.phase, capabilities, capError, loadCapabilities, model, effort, reviewModel]);
  useEffect(() => {
    if (!selected || !isRuntime || !monitoring || connection !== 'online') { setVerificationLoading(false); return; }
    const runtimeId = selected; let ended = false;
    let timer: ReturnType<typeof globalThis.setTimeout>;
    async function poll() {
      setVerificationLoading(true);
      try {
        const value = await api.verificationStatus(runtimeId);
        if (ended) return;
        setVerificationData({ runtimeId, value, checkedAt: new Date().toISOString() }); setVerificationReadError('');
        const pendingAction = verificationPendingRef.current;
        const pendingCommandId = pendingAction && 'commandId' in pendingAction.action ? pendingAction.action.commandId : null;
        if (pendingAction?.runtimeId === runtimeId && pendingCommandId && value.jobs.some(job => (job.request as { commandId?: string } | null)?.commandId === pendingCommandId)) {
          verificationPendingRef.current = null; setVerificationPending(null);
        }
      } catch (error) { if (!ended) setVerificationReadError(errorText(error)); }
      finally { if (!ended) setVerificationLoading(false); }
      if (!ended) timer = globalThis.setTimeout(poll, 15000);
    }
    void poll(); return () => { ended = true; globalThis.clearTimeout(timer); };
  }, [selected, isRuntime, monitoring, connection, verificationRevision]);
  useEffect(() => {
    setEvents([]); setRuntimeEvents([]); setRuntimeDetail(null); setInputText(''); setEventError('');
    if (!selected || !monitoring || goalSession) return;
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
  }, [selected, isRuntime, childExecutionId, monitoring, revision, Boolean(goalSession)]);
  const refresh = () => { setMonitoring(true); setConnection('connecting'); setRevision(value => value + 1); };
  function rememberGoal(inspection: GoalInspection) {
    setSessions(current => mergeGoalSessions(current, [inspection.session]));
    if (selectedRef.current === inspection.session.id) setGoalDetail(current => current?.session.id === inspection.session.id && current.session.revision > inspection.session.revision ? current : inspection);
  }
  async function start(event: React.FormEvent) {
    event.preventDefault(); setActionError('');
    let input: StartInput;
    try {
      if (!pending && (!selectedModel || !selectedModel.reasoningEfforts.includes(effort))) throw new Error('请选择当前 CLI 已公布的模型和思考深度。');
      const action = parseOrchestrationAction({ type: 'start', ...(pending ?? { commandId: crypto.randomUUID(), ...(workspace.trim() ? { workspace: workspace.trim() } : {}), goal: prompt.trim(), tokenLimit, verificationReserve, model, effort, timeoutMs: timeout * 1000, reservation, maxContextChars }) });
      if (action.type !== 'start') throw new Error('Invalid goal request');
      if (action.workspace && !action.workspace.startsWith('/')) throw new Error('项目目录须使用绝对路径。');
      const { type: _type, ...value } = action; input = value;
    } catch (error) { setActionError(`请核对目标、模型、深度、超时与额度：${errorText(error)}`); return; }
    pendingRef.current = input; setPending(input); setBusy(true);
    try {
      pendingSessionIdRef.current = await goalSessionId(input.commandId);
      const result = await api.orchestrationStart(input);
      if (!result.accepted) {
        pendingRef.current = null; pendingSessionIdRef.current = null; setPending(null);
        setActionError(`${result.error}。后台已拒绝本次请求；请修改后重新提交。`); return;
      }
      const record = result.record.session;
      setSessions(current => mergeGoalSessions(current, [record])); setGoalDetail(result.record);
      pendingRef.current = null; pendingSessionIdRef.current = null; setPending(null); setSelected(record.id); setDetailOpen(true); setProject(record.workspace); setCollapsed(current => { const next = new Set(current); next.delete(record.workspace); return next; }); setComposer(false);
      setRevision(value => value + 1);
    } catch (error) { setActionError(`${errorText(error)}。请求编号已保留；请先重连核对，重试将使用同一编号。`); }
    finally { setBusy(false); }
  }
  async function openSessionRuntime(session: GoalSession) {
    if (!session.runtimeId) return;
    try {
      const inspection = await api.runtimeInspect(session.runtimeId);
      setRuntimes(current => [inspection.runtime, ...current.filter(item => item.id !== inspection.runtime.id)]);
      setRuntimeDetail(inspection); setShowGoalDetails(false); setSelected(inspection.runtime.id); setDetailOpen(true); setProject(session.workspace); setComposer(false);
    } catch (error) { setGoalActionError(`已准入的执行任务暂未读到，请重新核对：${errorText(error)}`); }
  }
  function rememberConversation(inspection: ConversationInspection) {
    setConversations(current => [inspection, ...current.filter(value => value.conversation.id !== inspection.conversation.id)]);
    setSessions(current => mergeGoalSessions(current, [inspection.active.session]));
    setSelected(current => current ? activeConversationTaskId([inspection], current) : current);
  }
  const unresolvedClarification = selectedConversation?.messages.findLast(m=>m.state==='clarifying'&&!selectedConversation.messages.some(reply=>reply.replyToMessageId===m.id));
  async function chooseTaskAttachments() {
    const sessionId = selectedConversation?.active.session.id ?? selectedSession?.id;
    if (!sessionId || attaching) return;
    const taskId = selectedRef.current;
    setAttaching(true); setAttachmentError('');
    try {
      const chosenFiles = await api.chooseTaskAttachments(sessionId);
      if (selectedRef.current !== taskId) return;
      const combined = [...attachments, ...chosenFiles]; validateTaskAttachments(combined); setAttachments(combined);
    } catch (error) { if(selectedRef.current===taskId) setAttachmentError(errorText(error)); }
    finally { setAttaching(false); }
  }
  async function sendChat(request?: ConversationSend) {
    if (!selectedConversation || conversationBusy) return;
    const input = request ?? {conversationId: selectedConversation.conversation.id, commandId: crypto.randomUUID(), kind: (unresolvedClarification || replyToMessageId || goalSession?.phase==='clarifying') ? 'unclassified' as const : chatKind, text: chatText.trim() || '请结合附件补充本次需求。', ...(attachments.length?{attachments}: {}), ...((replyToMessageId || unresolvedClarification?.id) ? {replyToMessageId: replyToMessageId || unresolvedClarification!.id} : {})};
    if (!input.text || (chatPendingRef.current && chatPendingRef.current.commandId !== input.commandId)) return;
    chatPendingRef.current = input; setChatPending(input); setConversationBusy(true); setConversationError(''); conversationGeneration.current++;
    try {
      const inspection = await api.conversationSend(input); conversationGeneration.current++; rememberConversation(inspection);
      chatPendingRef.current = null; setChatPending(null);
      if (selectedConversationRef.current === input.conversationId) { setChatText(''); setAttachments([]); setReplyToMessageId(null); }
      setRevision(value => value + 1);
    } catch (error) { if (selectedConversationRef.current === input.conversationId) setConversationError(`消息提交结果待核对：${errorText(error)}。请求编号已保留，重试会使用同一编号。`); }
    finally { setConversationBusy(false); }
  }
  async function retryChat(messageId: string) {
    if (!selectedConversation || conversationBusy) return;
    const conversationId = selectedConversation.conversation.id;
    setConversationBusy(true); setConversationError(''); conversationGeneration.current++;
    try { const value = await api.conversationRetry({conversationId, messageId, reason: '用户点击重试处理，请保留原问题与既有必要验收覆盖'}); conversationGeneration.current++; rememberConversation(value); setRevision(value => value + 1); }
    catch (error) { if (selectedConversationRef.current === conversationId) setConversationError(`重试处理未能确认，请重新核对消息状态：${errorText(error)}`); }
    finally { setConversationBusy(false); }
  }
  async function cancelAssessment(messageId: string, assessmentId: string) {
    if (!selectedConversation || conversationBusy) return;
    const conversationId = selectedConversation.conversation.id;
    setConversationBusy(true); setConversationError(''); conversationGeneration.current++;
    try { const value = await api.conversationCancelAssessment({conversationId,messageId,assessmentId}); conversationGeneration.current++; rememberConversation(value); setRevision(v => v+1); }
    catch (error) { if (selectedConversationRef.current === conversationId) setConversationError(`停止询问结果待核对：${errorText(error)}`); }
    finally { setConversationBusy(false); }
  }
  async function inspectRound(round: ConversationRound) {
    setHistoryError(''); setRoundHistory(null);
    const conversationId = selectedConversation?.conversation.id;
    try {
      const goal = await api.orchestrationInspect(round.sessionId);
      const verification = goal.session.runtimeId ? await api.verificationStatus(goal.session.runtimeId) : null;
      if (selectedConversationRef.current === conversationId) setRoundHistory({round, goal, verification});
    } catch (error) { if (selectedConversationRef.current === conversationId) setHistoryError(`历史记录读取失败：${errorText(error)}`); }
  }
  function conversationPanel() {
    if (!selectedConversation) return selectedSession ? <div className={`notice compact ${conversationError ? 'error' : ''}`} role="status">{conversationError || '正在读取此任务的持续跟进记录…'}</div> : null;
    const value = selectedConversation;
    const pendingHere = chatPending?.conversationId === value.conversation.id ? chatPending : null;
    const pendingElsewhere = Boolean(chatPending && !pendingHere);
    return <section className="conversation-panel" aria-label="同一任务持续跟进">
      <h3 className="section-title">任务对话<span className="pill">第 {value.rounds.length} 轮</span></h3>
      <p className="form-hint">执行中也可发送补充要求。后台会等待安全时机再应用；询问仅答复，交付后追加工作会保留历史交付并开启下一轮。</p>
      <details className="conversation-accounting"><summary>查看累计用量</summary><dl className="facts conversation-budget"><dt>累计授权</dt><dd>{formatTokenLimit(value.budget.limit)} tokens</dd><dt>实际支出</dt><dd>{count(value.budget.spent)} tokens</dd><dt>待结算预留</dt><dd>{count(value.budget.reserved)} tokens</dd><dt>当前可用</dt><dd>{formatTokenLimit(value.budget.available)} tokens</dd></dl></details>
      {!online && <div className="notice compact">后台连接已断开，消息与预算为上次已知状态；重连后继续核对。</div>}
      {(value.budget.reasoningSpent > 0 || value.budget.reasoningReserved > 0) && <p className="form-hint">其中交付后询问已花费 {count(value.budget.reasoningSpent)} tokens，待结算 {count(value.budget.reasoningReserved)} tokens；已计入上方累计费用。</p>}
      <ol className="conversation-messages" aria-label="持续跟进消息">{value.messages.map(message => <li key={message.id} className={`conversation-message ${message.state}`}>
        <div className="event-meta"><span>{message.kind === 'question' ? '仅询问' : message.kind === 'change' ? '补充要求' : '用户消息'}</span><time dateTime={message.createdAt}>{date(message.createdAt)}</time></div>
        <p>{message.text}</p>{message.attachments?.map(file=><p className="form-hint" key={file.path}>附件：{file.name}</p>)}<span className="pill" role="status">{conversationStateLabels[message.state]}{message.appliedContractVersion !== null ? ` · 要求 v${message.appliedContractVersion}` : ''}</span>
        {message.response && <div className="conversation-response"><strong>主控答复</strong><p>{message.response}</p></div>}
        {message.history.at(-1)?.reason && (message.state==='failed'?<div><p className="form-hint">{describeGoalProblem(message.history.at(-1)!.reason!)}</p><details><summary>查看处理失败详情</summary><p className="form-hint">{message.history.at(-1)!.reason}</p></details></div>:<p className="form-hint">{message.history.at(-1)?.reason}</p>)}
        {value.assessmentJobs.filter(job => job.messageId === message.id && job.status === 'running').map(job => <button key={job.id} className="button danger" disabled={!online || conversationBusy || job.cancelRequested} onClick={() => {void cancelAssessment(message.id,job.id);}}>{job.cancelRequested ? '正在停止询问…' : '停止这次询问'}</button>)}
        {message.state === 'clarifying' && <button className="button" disabled={!online || conversationBusy || Boolean(chatPending)} onClick={() => { setReplyToMessageId(message.id); setChatKind('unclassified'); }}>回答这条澄清</button>}
        {message.state === 'failed' && <button className="button" disabled={!online || conversationBusy || Boolean(chatPending)} onClick={() => { void retryChat(message.id); }}>重试处理</button>}
      </li>)}</ol>

      {value.rounds.length > 1 && <details className="conversation-history"><summary>历史轮次与交付（{value.rounds.length - 1} 轮）</summary>{value.rounds.filter(round => round.runId !== value.conversation.activeRunId).map(round => <button key={round.runId} className="button ghost" disabled={!online || conversationBusy} onClick={() => {void inspectRound(round);}}>查看第 {round.ordinal} 轮</button>)}</details>}
      {historyError && <div className="notice error compact" role="alert">{historyError}</div>}
      {roundHistory && <div className="conversation-history-detail"><h4>第 {roundHistory.round.ordinal} 轮历史记录</h4><p>{roundHistory.goal.run.contract.goal}</p><p className="form-hint">要求 v{roundHistory.goal.run.contract.version} · 实际支出 {count(roundHistory.goal.run.budget.spent)} tokens · {roundHistory.goal.run.status === 'succeeded' ? '已有独立交付记录' : '未完成交付'}</p>{roundHistory.verification?.deliveries.map(delivery => <dl key={delivery.id} className="facts"><dt>保留交付</dt><dd className="mono">{delivery.id}</dd><dt>时间</dt><dd>{date(delivery.createdAt)}</dd><dt>候选摘要</dt><dd className="mono">{delivery.candidateDigest}</dd></dl>)}<p className="form-hint">历史通过不表示当前轮次已通过；当前操作始终针对第 {value.rounds.length} 轮。</p></div>}
    </section>;
  }
  async function cancelSessionRuntime() {
    if (!goalSession?.runtimeId) return;
    setBusy(true); setGoalActionError('');
    try {
      const record = await api.runtimeCancel(goalSession.runtimeId, crypto.randomUUID());
      setRuntimes(current => [record, ...current.filter(item => item.id !== record.id)]);
      setRevision(value => value + 1);
    } catch (error) { setGoalActionError(errorText(error)); }
    finally { setBusy(false); }
  }
  async function performGoalAction(action: GoalMutation) {
    if (goalPendingRef.current && goalPendingRef.current !== action) { setGoalActionError('有待核对请求，请先重试同一请求或清除待核对记录。'); return; }
    goalPendingRef.current = action; setGoalPending(action); setBusy(true); setGoalActionError('');
    try {
      const { type, ...input } = action;
      let inspection: GoalInspection;
      switch (type) {
        case 'answer': inspection = await api.orchestrationAnswer(input as Omit<Extract<GoalMutation, { type: 'answer' }>, 'type'>); break;
        case 'admit': inspection = await api.orchestrationAdmit(input as Omit<Extract<GoalMutation, { type: 'admit' }>, 'type'>); break;
        case 'restore': inspection = await api.orchestrationRestore(input as Omit<Extract<GoalMutation, { type: 'restore' }>, 'type'>); break;
        case 'cancel': inspection = await api.orchestrationCancel(input); break;
      }
      goalPendingRef.current = null; setGoalPending(null); rememberGoal(inspection);
      if (selectedRef.current === action.sessionId) {
        if (type === 'answer') {setAnswerText('');setAttachments([]);}
        if (type === 'admit') await openSessionRuntime(inspection.session);
        setRevision(value => value + 1);
      }
    } catch (error) { if (selectedRef.current === action.sessionId) setGoalActionError(errorText(error)); }
    finally { setBusy(false); }
  }
  const [explorationTier,setExplorationTier]=useState<ExplorationTier>('medium');
  useEffect(()=>{setExplorationTier('medium');},[goalSession?.id]);
  function goalAction(type: 'answer' | 'admit' | 'restore' | 'cancel') {
    if (!goalSession) return;
    const base = { commandId: crypto.randomUUID(), sessionId: goalSession.id };
    const action: GoalMutation = type === 'cancel' ? { type, ...base } : type === 'answer' ? { type, ...base, expectedRevision: goalSession.revision, text: answerText.trim() || '请结合附件补充本次需求。', ...(attachments.length?{attachments}: {}) } : { type, ...base, expectedRevision: goalSession.revision, ...(type==='admit'?{explorationTier}:{}) };
    void performGoalAction(action);
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
    setProject(path);
    setWorkspace(path ?? ''); setPrompt('');
  }
  function renewTask() {
    if (!chosen) return;
    const goal = chosen.prompt, path = chosen.workspace;
    newTask(path);
    if (!pendingRef.current) setPrompt(goal);
  }
  function selectTask(record: TaskRecord) { setSelected(record.id); setDetailOpen(true); setProject(record.workspace); setComposer(false); }
  async function openProjectDirectory(path:string) { try { await api.openProjectDirectory(path); } catch(error) { setActionError(errorText(error)); } }
  async function openWorkspace(id: string) { try { await api.openWorkspace(id); } catch (error) { setActionError(errorText(error)); } }
  async function mountProject(){try{const path=await api.chooseWorkspace();if(!path)return;if(!path.startsWith('/'))throw Error('项目目录须使用绝对路径。');const observation=await api.workbenchRead(path),canonicalPath=observation.project.path;const mounted=[...new Set([...mountedPathsRef.current,canonicalPath])];mountedPathsRef.current=mounted;setMountedPaths(mounted);setProject(canonicalPath);setSelected(null);setComposer(false);}catch(error){setActionError(errorText(error));}}
  async function chooseWorkspace() { try { const path = await api.chooseWorkspace(); if (path) setWorkspace(path); } catch (error) { setActionError(errorText(error)); } }
  async function chooseSpec() { try { const path = await api.chooseVerificationSpec(); if (path) setSpecPath(path); } catch (error) { setVerificationError(errorText(error)); } }
  function modelConfig(): ModelConfig {
    if (!reviewCapability || !reviewCapability.reasoningEfforts.includes(reviewEffort) || !Number.isSafeInteger(reviewReservation) || reviewReservation < 1 || !Number.isSafeInteger(reviewTimeout) || reviewTimeout < 1 || reviewTimeout > 3600 || availableBudget !== null && reviewReservation > availableBudget) throw new Error('请选择实际模型和深度，设置可用累计额度内的验收预留，以及 1–3600 秒的超时。');
    return { model: reviewModel, effort: reviewEffort, reservation: reviewReservation, timeoutMs: reviewTimeout * 1000 };
  }
  async function performVerification(action: VerificationMutation, runtimeId = chosenRuntime?.id) {
    if (!runtimeId) return;
    if (verificationPendingRef.current && verificationPendingRef.current.action !== action) { setVerificationError('有待核对请求，请先重试同一请求或清除待核对记录。'); return; }
    const pendingAction = { runtimeId, action }; verificationPendingRef.current = pendingAction; setVerificationPending(pendingAction); setBusy(true); setVerificationError('');
    try {
      let response: Proposal | FrozenPlan | VerificationJob | Delivery;
      switch (action.type) {
        case 'propose': response = await api.verificationPropose(action.runtimeId, action.commandId, action.specPath); break;
        case 'review': response = await api.verificationReview(action.proposalId, action.commandId, { model: action.model, effort: action.effort, reservation: action.reservation, timeoutMs: action.timeoutMs }); break;
        case 'publish': response = await api.verificationPublish(action.proposalId, action.reviewId, action.commandId); break;
        case 'freeze': response = await api.verificationFreeze(action.runtimeId, action.commandId); break;
        case 'run': response = await api.verificationRun(action.planId, action.commandId, { model: action.model, effort: action.effort, reservation: action.reservation, timeoutMs: action.timeoutMs }); break;
        case 'deliver': response = await api.verificationDeliver(action.jobId, action.commandId); break;
        case 'cancel': response = await api.verificationCancel(action.jobId); break;
      }
      verificationPendingRef.current = null; setVerificationPending(null);
      if (selectedRef.current === runtimeId) {
        if (action.type === 'propose' || action.type === 'publish') setProposalId(response.id);
        if (action.type === 'freeze') setPlanId(response.id);
        setVerificationRevision(value => value + 1); setRevision(value => value + 1);
      }
    } catch (error) { if (selectedRef.current === runtimeId) setVerificationError(`${errorText(error)}。请求已保留，可核对后台后重试同一请求。`); }
    finally { setBusy(false); }
  }
  function verificationAction(kind: 'propose' | 'review' | 'publish' | 'freeze' | 'run' | 'deliver' | 'cancel') {
    if (!chosenRuntime) return;
    if (kind !== 'cancel' && detail && ['succeeded', 'cancelled'].includes(detail.run.status)) { setVerificationError('此任务已结束，不能再派发新的验收。请在同项目新建任务，重新执行并验收当前候选。'); return; }
    const commandId = crypto.randomUUID();
    try {
      let action: VerificationMutation;
      switch (kind) {
        case 'propose': if (!specPath) throw new Error('请选择验收定义 JSON。'); action = { type: kind, runtimeId: chosenRuntime.id, commandId, specPath }; break;
        case 'review': if (!proposal) return; action = { type: kind, proposalId: proposal.id, commandId, ...modelConfig() }; break;
        case 'publish': if (!proposal || !reviewJob) return; action = { type: kind, proposalId: proposal.id, reviewId: reviewJob.id, commandId }; break;
        case 'freeze': action = { type: kind, runtimeId: chosenRuntime.id, mode: 'final', commandId }; break;
        case 'run': if (!plan) return; action = { type: kind, planId: plan.id, commandId, ...modelConfig() }; break;
        case 'deliver': if (!verificationJob) return; action = { type: kind, jobId: verificationJob.id, commandId }; break;
        case 'cancel': if (!activeVerificationJob) return; action = { type: kind, jobId: activeVerificationJob.id }; break;
      }
      void performVerification(action);
    } catch (error) { setVerificationError(errorText(error)); }
  }
  const online = connection === 'online';
  const goalReady = online && !busy && !goalPending && !goalReadError && Boolean(selectedGoal) && Boolean(goalSession && selectedGoal?.session.revision === goalSession.revision);
  const goalTerminal = Boolean(selectedGoal && ['succeeded', 'cancelled'].includes(selectedGoal.run.status));
  const restoreReady = goalReady && Boolean(goalSession && selectedGoal && goalCanRestore(goalSession, selectedGoal.run, sessionRuntime));
  const verificationTerminal = Boolean(detail && ['succeeded', 'cancelled'].includes(detail.run.status));
  const verificationReady = online && !busy && !verificationLoading && !verificationReadError && Boolean(detail) && !verificationTerminal && !activeVerificationJob && !verificationPending && chosenRuntime?.phase === 'awaiting-verification' && !chosenRuntime.paused && !chosenRuntime.cancelled;
  const currentDeliveryKnown = online && Boolean(verification) && !verificationReadError;
  const deliveryCurrent = Boolean(currentDeliveryKnown && !verificationLoading && verification?.currentDelivery.current);
  const hasDelivery = Boolean(verification?.currentDelivery.delivery) || detail?.run.status === 'succeeded';
  const deliveryHistory = currentDeliveryKnown && !verificationLoading && verification?.currentDelivery.assessment ? describeDeliveryAssessment(verification.currentDelivery.assessment) : null;
  const deliveryLabel = !hasDelivery ? '' : !currentDeliveryKnown ? '交付记录待核对' : verificationLoading ? '已保存交付记录 · 正在核对' : deliveryHistory?.title ?? (deliveryCurrent ? '当前交付有效 · 独立验收通过' : '交付需重新核验');
  const deliveryProblem = verification ? describeVerificationProblem(verification.currentDelivery.reason) : null;
  const verificationLabels = { passed: '通过', failed: '失败', unknown: '无法判断', 'not-applicable': '不适用' };
  const executionLabels = { executed: '已执行', 'environment-blocked': '环境阻塞', 'verifier-error': '验收器错误', 'not-run': '未执行' };
  function jobSummary(job: VerificationJob | undefined, title: string) {
    if (!job) return <p className="no-events">{title}尚未执行。</p>;
    return <div className="verification-job"><h4>{title}<span className="pill">{job.status === 'running' ? '正在执行' : job.approved ? hasDelivery ? '历史作业通过' : '本次作业通过' : job.error ? '错误 · 未通过' : '本次未通过'}</span></h4>
      {job.status === 'finished' && job.approved && <p className="form-hint">通过结果对应 {date(job.finishedAt || job.startedAt)} 的候选、定义与环境。当前交付有效性以本页最新核对为准。</p>}
      <p className="form-hint">{job.config.model} / {job.config.effort} · {job.usageUnknown ? `已知 ${count(job.usage)} tokens · 用量仍有未知部分` : job.status === 'running' ? `当前账本 ${count(job.usage)} tokens · 尚未结算` : `${count(job.usage)} tokens`} · 预留 {count(job.config.reservation)}</p>
      {job.error && <div className="notice error compact"><strong>{describeVerificationProblem(job.error).title}</strong><p>{describeVerificationProblem(job.error).description}</p><details className="technical-details"><summary>查看作业错误原文</summary><pre>{job.error}</pre></details></div>}
      {job.controls.length > 0 && <p className="form-hint">正反控制：{job.controls.filter(control => control.passed).length} / {job.controls.length} 符合预期</p>}
      {job.evaluation && <p className="form-hint">{job.evaluation.complete ? '必要范围完整' : '必要范围尚不完整'}{job.evaluation.reasons.length > 0 ? ` · ${job.evaluation.reasons.join('；')}` : ''}</p>}
      {job.results.length > 0 && <details><summary>查看必要条款结果</summary><ul className="verification-checks">{job.results.map(record => <li key={record.instanceId}><strong>{record.instanceId} · {executionLabels[record.executionStatus]}</strong><p>{record.reason}</p>{record.checks.map(check => <p key={check.obligationId}>{check.obligationId}：{verificationLabels[check.verdict]} · {check.reason}</p>)}</li>)}</ul></details>}
      <details><summary>查看证据与作业编号</summary><p className="mono form-hint">{job.id}</p><p className="form-hint">{Object.keys(job.proofs).length} 份摘要绑定的证据 · {job.modelStarted ? '已派发独立模型' : '尚未派发模型'}</p>{Object.entries(job.proofs).map(([path, digest]) => <p className="verification-proof mono" key={path} title={path}>{path}<br/>{digest}</p>)}</details>
    </div>;
  }
  return <div className="shell">
    <aside className="sidebar" aria-label="项目与任务">
      <button className="brand" aria-label="返回首页" onClick={() => { setProject(null); setSelected(null); setComposer(false); }}><span className="brand-mark"><Icon name="agent" size={21}/></span>Supervisor</button>
      <button className="nav-item new-task" onClick={() => newTask()}><Icon name="plus"/><span>新任务</span></button>
      <button className="nav-item" onClick={()=>{void mountProject();}}><Icon name="folder"/><span>挂载项目目录</span></button>
      <div className="eyebrow">Projects / 项目</div>
      <nav className="project-list" aria-label="按工作目录管理任务">{projects.length ? projects.map(item => <section className="project-group" key={item.path}>
        <div className={`project-row ${project === item.path ? 'active' : ''}`}>
          <button className="project-toggle" aria-label={`${collapsed.has(item.path) ? '展开' : '折叠'}项目 ${projectName(item)}`} aria-expanded={!collapsed.has(item.path)} onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(item.path)) next.delete(item.path); else next.add(item.path); return next; })}>{collapsed.has(item.path) ? '›' : '⌄'}</button>
          <button className="project-button" title={item.path} onClick={() => { setProject(item.path); setSelected(null); setComposer(false); }}><Icon name="folder"/><span>{projectName(item)}</span>{item.managed && <small>暂存</small>}<span className="count">{item.tasks.length}</span></button>
        </div>
        {!collapsed.has(item.path) && <div className="project-tasks">{item.tasks.map(record => <button className={`task-button ${selected === record.id ? 'selected' : ''}`} key={record.id} title={record.prompt} onClick={() => selectTask(record)}><strong>{record.prompt}</strong><small><i className={`dot ${active(record) ? '' : 'inactive'}`}/>{selected === record.id && deliveryLabel ? deliveryLabel : statusLabel(record)} · {date(record.createdAt)}</small></button>)}</div>}
      </section>) : <p className="subtle">任务将归入所选项目；未选择目录时自动创建暂存工作区。</p>}</nav>
      <div className="sidebar-footer"><strong>本地监督服务</strong><br/>关闭窗口或退出界面，<br/>后台任务继续运行。</div>
    </aside>
    <main className="workspace">
      <div className="titlebar">SUPERVISOR / LOCAL WORKSPACE</div>
      <header className={`topbar ${currentProject ? 'project-topbar' : ''}`}><div className="heading">{currentProject ? <><div className="project-title"><Icon name="folder" size={21}/><h1 title={projectName(currentProject)}>{projectName(currentProject)}</h1>{currentProject.managed && <span className="pill">暂存工作区</span>}</div><p className="project-directory mono" title={currentProject.path}>{currentProject.path}</p></> : composer ? <><h1>新任务</h1><p>选择项目目录，或使用独立暂存工作区。</p></> : <><div className="eyebrow">Supervisor</div><h1>让每一次执行，都有迹可循。</h1><p>持久任务 · 恢复核对 · 独立验收前不宣告交付</p></>}</div>
        <div className="toolbar"><span className="connection" role="status"><i className={`dot ${online ? '' : 'offline'}`}/>{online ? '后台已连接' : connection === 'connecting' ? '正在连接' : connection === 'detached' ? '界面已断开' : '后台暂不可达'}</span>
          {currentProject && <button className="button ghost" onClick={() => { void openProjectDirectory(currentProject.path); }}><Icon name="folder"/>打开目录</button>}
          <button className="button ghost" onClick={refresh} aria-label="重新连接后台"><Icon name="refresh"/>重连</button>
          {online && <button className="button ghost" onClick={() => setMonitoring(false)}>断开界面</button>}
          <button className="button primary" onClick={() => newTask(project)}><Icon name="plus"/>{project ? '在此项目新建' : '新任务'}</button>
        </div></header>
      <div className="content"><div className="task-main"><section className="board" aria-label="Agent 工作台">
        {connection === 'offline' && <div className="notice error" role="alert">后台暂不可达，保留上次已知状态。请启动独立后台后重连。<br/>{connectionError}</div>}
        {connection === 'detached' && <div className="notice">界面已停止同步。后台任务继续由独立服务管理；重新连接后核对持久状态。</div>}
        {actionError && <div className="notice error" role="alert">{actionError}</div>}
        {composer && <form className="composer" onSubmit={event => { void start(event); }} aria-label="新建真实 Codex 任务">
          <div className="composer-head"><h2>{workspace.trim() ? '在项目中创建任务' : '创建新任务'}</h2><button type="button" className="icon-button" aria-label="关闭新任务面板" onClick={() => setComposer(false)}><Icon name="close"/></button></div>
          <p className="form-hint">先由主控分析目标、提出澄清问题与执行计划，点击开始执行后才派发任务。当前需求分析接收文字；选择项目目录或留空使用独立暂存工作区。</p>
          <fieldset disabled={busy || Boolean(pending)}>
            <label className="field"><span>项目目录（可选）</span><div className="input-action"><input aria-label="工作区路径" value={workspace} onChange={event => setWorkspace(event.target.value)} placeholder="留空，自动创建暂存工作区"/><button type="button" className="button" onClick={() => { void chooseWorkspace(); }}><Icon name="folder"/>选择文件夹</button></div></label>
            <div className="workspace-hint">{workspace.trim() ? <><p className="form-hint">任务将挂载到此目录对应的项目。</p><button type="button" className="button ghost" onClick={() => setWorkspace('')}>改用独立暂存目录</button></> : <p className="form-hint">自动创建 ~/.supervisor/workspace/…，用于保存本次任务的文件与资料。退出应用后仍保留。</p>}</div>
            <label className="field"><span>本次目标</span><textarea aria-label="本次目标" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="描述需要解决的问题、已有条件与期望结果；主控将先分析需求…" maxLength={40000} required/></label>
            <div className="field-row"><label className="field"><span>主控模型</span><select aria-label="主控模型" value={model} onChange={event => { const next = modelOptions.find(item => item.id === event.target.value)?.capability; setModel(event.target.value); setEffort(next?.defaultEffort || next?.reasoningEfforts[0] || ''); }} disabled={!capabilities}><option value="" disabled>{capLoading ? '正在发现真实模型…' : '请选择模型'}</option>{modelOptions.map(item => <option key={item.id} value={item.id} disabled={!item.capability}>{item.label}{!item.capability ? ' · CLI 未公布' : ''}</option>)}</select></label>
            <label className="field"><span>思考深度</span><select aria-label="思考深度" value={effort} onChange={event => setEffort(event.target.value)} disabled={!selectedModel}><option value="" disabled>由执行器提供</option>{selectedModel?.reasoningEfforts.map(item => <option key={item} value={item}>{item}</option>)}</select></label></div>
            <TokenTierSelector value={tokenTier} onChange={setTokenTier}/>
            <details className="advanced"><summary>主控分析边界</summary><div className="advanced-grid">
              <label className="field"><span>超时（秒）</span><input aria-label="超时秒数" type="number" min="1" max="3600" value={timeout} onChange={event => setTimeoutValue(Number(event.target.value))}/></label>
              <label className="field"><span>上下文容量（字符）</span><input aria-label="上下文容量" type="number" min="8000" max="200000" value={maxContextChars} onChange={event => setMaxContextChars(Number(event.target.value))}/></label>
            </div><p className="form-hint">上下文容量与单次超时独立于 Token 档位。用量未知时仍需核对，不会计作零。</p></details>
          </fieldset>
          {capabilities && unavailableModelLabels && <p className="form-hint" role="status">{unavailableModelLabels} 尚未由当前 Codex CLI 公布，暂不可选。请选择可用型号；CLI 更新后需重启后台重新探测，不会自动替换模型。</p>}
          {capError && <div className="validation" role="alert">模型能力发现失败：{capError} <button type="button" className="plain-button" onClick={() => { void loadCapabilities(); }} disabled={!online || capLoading}>重新发现</button></div>}
          {pending && <p className="form-hint mono">待核对请求：{pending.commandId}</p>}
          <div className="composer-footer"><p>主控输出是需求与计划提案。<br/>执行及独立验收通过后才可确认交付。</p><button className="button primary" type="submit" disabled={!online || busy || (!pending && (!selectedModel || !selectedModel.reasoningEfforts.includes(effort) || !prompt.trim()))}>{busy ? '正在提交…' : pending ? '重试同一请求' : '分析需求'}<Icon name="arrow"/></button></div>
        </form>}
        <div className="board-head"><h2>{currentProject ? '项目任务' : '项目'}<span className="pill">{currentProject ? `${visible.length} 个任务` : `${projects.length} 个项目`}</span></h2>{currentProject && <span className="subtle">{visible.filter(active).length} 执行中</span>}</div>
        {!currentProject && projects.length > 0 ? <div className="project-grid">{projects.map(item => <button className="project-card" key={item.path} onClick={() => { setProject(item.path); setSelected(null); setComposer(false); }} aria-label={`打开项目 ${projectName(item)}`}><div className="project-card-title"><Icon name="folder" size={20}/><strong>{projectName(item)}</strong>{item.managed && <span className="pill">暂存</span>}<Icon name="arrow"/></div><p className="mono" title={item.path}>{item.path}</p><span>{item.tasks.length} 个任务 · {item.tasks.filter(active).length} 执行中</span></button>)}</div> : visible.length ? <AgentWorkbench conversations={conversations} projectPath={project!} parents={visible} executions={executions} snapshot={workbenchData?.path===project?workbenchData.snapshot:null} readError={workbenchData?.path===project?workbenchData.error:''} connection={connection} selected={selected} onSelect={selectTask}/>

          : <div className="empty"><Icon name="agent" size={36}/><h2>{project?'项目尚无任务':'从一个明确的目标开始'}</h2><p>{project?'该目录已在本窗口挂载；尚未创建持久任务。':'选择已有项目，或直接描述目标。没有项目目录时，Supervisor 会自动创建暂存工作区。'}</p><button className="button primary" onClick={() => newTask(project)}><Icon name="plus"/>创建第一个任务</button></div>}
        {!currentProject && !composer && <div className="single-note"><i className="dot"/>任务按项目目录管理；选择项目继续工作。</div>}
        {chosen && !composer && <TaskClarification session={goalSession ?? associatedSession ?? null} conversation={selectedConversation}/>}
        {chosen && !composer && conversationPanel()}
      </section>
      {chosen && !composer && <TaskComposer
        text={selectedConversation ? (chatPending?.conversationId===selectedConversation.conversation.id ? chatPending.text : chatText) : answerText}
        attachments={chatPending?.conversationId===selectedConversation?.conversation.id && chatPending ? chatPending.attachments ?? [] : attachments}
        disabled={!online || conversationBusy || busy || Boolean(chatPending) || Boolean(goalPending) || attaching || (!selectedConversation && (!goalSession || !goalCanAnswer(goalSession)))}
        canSend={online && !conversationBusy && !busy && !attaching && (selectedConversation ? (!chatPending || chatPending.conversationId===selectedConversation.conversation.id) && Boolean(chatPending || chatText.trim() || attachments.length) : Boolean(goalSession && goalCanAnswer(goalSession) && goalReady && !goalPending && (answerText.trim() || attachments.length)))}
        sending={conversationBusy || busy} attaching={attaching} pending={Boolean(chatPending?.conversationId===selectedConversation?.conversation.id && chatPending)}
        clarifying={Boolean(goalSession?.phase==='clarifying'||unresolvedClarification||replyToMessageId)} kind={chatKind}
        hint={!online ? '后台未连接，草稿保留。重连后可以发送。' : chatPending && chatPending.conversationId!==selectedConversation?.conversation.id ? '另一任务有待核对消息，请先回到该任务核对。' : !selectedConversation && !goalSession ? '正在读取此任务的会话记录…' : ''}
        error={attachmentError || conversationError || goalActionError}
        onText={selectedConversation ? setChatText : setAnswerText} onKind={setChatKind}
        onAttach={()=>{void chooseTaskAttachments();}} onRemove={index=>setAttachments(current=>current.filter((_,i)=>i!==index))}
        onSend={()=>{if(selectedConversation) void sendChat(chatPending??undefined);else goalAction('answer');}}
      />}
      </div>
      {detailOpen && goalSession && <aside className="detail goal-detail" aria-label="主控需求会话"><header className="detail-header"><div className="detail-title"><h2>需求与执行计划</h2><button className="icon-button" aria-label="关闭需求详情" onClick={() => setDetailOpen(false)}><Icon name="close"/></button></div><p className="detail-goal">{goalSession.goal}</p><span className={`agent-status ${goalSession.phase === 'blocked' ? 'failed' : goalSession.phase === 'thinking' ? '' : 'stopped'}`}><i className="dot"/>{goalSession.phase === 'thinking' && goalSession.runtimeId ? '主控恢复分析中' : goalPhaseLabels[goalSession.phase]}</span></header><div className="detail-body">
        <dl className="facts"><dt>项目目录</dt><dd>{goalSession.workspace}<br/><span className="subtle">{goalSession.workspaceKind === 'managed' ? 'Supervisor 暂存工作区' : '本地项目'}</span></dd><dt>主控模型</dt><dd>{goalSession.config.model} / {goalSession.config.effort}</dd><dt>累计额度</dt><dd>{selectedGoal ? `${count(selectedGoal.run.budget.spent)} / ${formatTokenLimit(selectedGoal.run.budget.limit)} tokens` : '正在读取账本'}<br/>{selectedGoal ? `${selectedGoal.run.attempts.filter(attempt => !attempt.settled).length} 次用量待结算` : ''}</dd><dt>上下文容量</dt><dd>{count(goalSession.maxContextChars)} 字符</dd></dl>
        {!online && <div className="notice compact">界面未连接后台，以下为上次已知需求记录；重新连接后核对再操作。</div>}
        {goalReadError && <div className="notice error compact" role="alert">需求记录同步失败，操作已暂停。<details className="technical-details"><summary>查看同步错误</summary><pre>{goalReadError}</pre></details></div>}
        {goalActionError && <div className="notice error compact" role="alert"><strong>{describeGoalProblem(goalActionError)}</strong><details className="technical-details"><summary>查看操作错误原文</summary><pre>{goalActionError}</pre></details></div>}
        {goalSession.phase === 'thinking' && <div className="notice compact" role="status">{goalSession.runtimeId ? '主控正在新会话中读取当前任务与项目记忆。恢复分析不会自动重跑已经准入的执行步骤。' : '主控正在分析目标与已有条件。若必要信息不足，将提出问题；计划就绪后由你点击开始执行。'}</div>}
        {goalSession.phase === 'blocked' && <div className="notice error compact"><strong>{describeGoalProblem(goalSession.error || '')}</strong><p>当前没有新增执行授权；请核对具体原因与账本，不会将阻塞计为完成。</p><details className="technical-details"><summary>查看主控错误与证据</summary><pre>{goalSession.error || '后台未提供具体错误，需重新核对。'}</pre></details></div>}
        {goalSession.phase === 'cancelled' && <div className="notice compact">需求会话已取消。已保存的输入与分析记录仍保留。</div>}
        {latestRestore?.proposal && <section className="goal-runtime" aria-label="最近恢复分析"><h3 className="section-title">最近恢复分析<time dateTime={latestRestore.finishedAt || latestRestore.startedAt} title={date(latestRestore.finishedAt || latestRestore.startedAt)}>{date(latestRestore.finishedAt || latestRestore.startedAt)}</time></h3><p className="goal-summary">{latestRestore.proposal.summary}</p><p className="form-hint">{goalSession.phase === 'thinking' ? '这是上次已完成的恢复分析，当前仍在分析。' : '这份摘要记录恢复时的任务判断。'}执行与验收继续沿用已准入方案。</p></section>}
        {goalSession.proposal && <section className="goal-proposal" aria-label="主控需求与计划提案"><h3 className="section-title">主控提案<span className="pill">{goalSession.proposal.decision === 'ready' ? '计划就绪' : '需要澄清'}</span></h3><p className="goal-summary">{goalSession.proposal.summary}</p><p className="form-hint">这是主控提出的需求与计划；不会据此宣称执行完成或独立验收通过。</p>
          {goalSession.proposal.questions.length > 0 && <><h3 className="section-title">待补充信息</h3><ol className="goal-questions">{goalSession.proposal.questions.map((question, index) => <li key={index}>{question}</li>)}</ol></>}
          {goalSession.proposal.facts.length > 0 && <details className="goal-section"><summary>需求事实与来源（{goalSession.proposal.facts.length} 项）</summary><ul className="goal-list">{goalSession.proposal.facts.map((fact, index) => { const source = goalSession.messages.find(message => message.id === fact.sourceId); return <li key={index}><span className="pill">{fact.origin === 'explicit' ? '明确输入' : '主控推断 · 待核对'}</span><p>{fact.text}</p><details className="technical-details"><summary>查看依据</summary><p className="goal-source">{source?.text || '该引用未对应到已保存的用户输入，须由主控核对。'}</p><p className="mono subtle">{fact.sourceId}</p></details></li>; })}</ul></details>}
          {goalSession.proposal.constraints.length > 0 && <><h3 className="section-title">执行边界</h3><ul className="goal-list">{goalSession.proposal.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul></>}
          {goalSession.proposal.style.length > 0 && <><h3 className="section-title">风格与偏好</h3><ul className="goal-list">{goalSession.proposal.style.map((style, index) => <li key={index}>{style}</li>)}</ul></>}
          {goalSession.phase==='ready'&&<ExplorationSelector value={explorationTier} onChange={setExplorationTier} disabled={busy}/>}<ExplorationProposal proposal={goalSession.proposal}/><ResearchGroupsProposal proposal={goalSession.proposal} {...(goalSession.researchGrouping?{decision:goalSession.researchGrouping}:{})}/>{goalSession.proposal.steps.length > 0 && <><h3 className="section-title">执行步骤</h3><ol className="goal-plan">{goalSession.proposal.steps.map((step, index) => <li key={step.id}><strong>{index + 1} · {step.description}</strong><p className="form-hint">{step.dependencies.length ? `依赖：${step.dependencies.map(id => { const dependency = goalSession.proposal?.steps.findIndex(item => item.id === id); return dependency !== undefined && dependency >= 0 ? `第 ${dependency + 1} 步` : id; }).join('、')}` : '起始步骤，无前置依赖'} · 验收 {step.acceptanceIds.length} 项</p></li>)}</ol></>}
          {goalSession.proposal.criteria.length > 0 && <><h3 className="section-title">具体验收要求</h3><ol className="goal-criteria">{goalSession.proposal.criteria.map(item => <li key={item.id}><strong>{item.description}</strong><p className="form-hint">{item.kind === 'command' ? '工程检查' : item.kind === 'ui' ? '界面操作' : '来源核验'} · {item.target}</p><ul>{item.checks.map((check, index) => <li key={index}>{check}</li>)}</ul></li>)}</ol><p className="form-hint">这些是拟定的业务验收要求。准入后仍须独立复核并发布项目验收定义，冻结必要清单并实际验收。</p></>}
        </section>}
        {goalSession.graphAdmission&&<ExplorationPanel key={goalSession.graphAdmission.policy.schedulerId} schedulerId={goalSession.graphAdmission.policy.schedulerId} api={api} online={online}/>}

        {goalSession.phase === 'ready' && <div className="notice compact"><p>计划就绪。点击开始执行后，后台将按该提案准入并派发步骤；这一步不会跳过独立验收。</p><button className="button primary" disabled={!goalReady || goalSession.proposal?.decision !== 'ready'} onClick={() => goalAction('admit')}>开始执行</button></div>}
        {goalSession.runtimeId && <section className="goal-runtime"><h3 className="section-title">已准入的执行任务</h3><p className="form-hint">需求记录与执行共用累计账本。恢复主控只读取保存的任务和记忆，不会自动重跑已准入步骤。</p><div className="verification-buttons"><button className="button primary" disabled={!online || busy} onClick={() => { void openSessionRuntime(goalSession); }}>查看执行任务</button><button className="button" disabled={!restoreReady} onClick={() => goalAction('restore')}>恢复主控会话</button></div>{!restoreReady && goalSession.phase !== 'thinking' && <p className="form-hint">{goalTerminal ? '此轮已结束；可在本任务的对话框继续询问或提出新要求。继续开发会保留原交付并建立关联轮次。' : '恢复前需核对执行已暂停、阻塞或进入待验收阶段，且没有仍在运行或用量未结算的尝试。'}</p>}</section>}
        <details className="goal-section"><summary>查看用户输入记录（{goalSession.messages.length} 条）</summary><ol className="goal-messages">{goalSession.messages.map(message => <li key={message.id}><time dateTime={message.createdAt}>{date(message.createdAt)}</time><p>{message.text}</p></li>)}</ol></details>
        <details className="goal-section"><summary>查看主控调用与恢复证据（{goalSession.jobs.length} 次）</summary>{goalSession.jobs.map(job => <div className="verification-job" key={job.id}><h4>{job.purpose === 'restore' ? '记忆恢复分析' : '需求分析'}<span className="pill">{job.status === 'running' ? '分析中' : job.error ? '分析失败' : job.proposal ? '提案已记录' : '未形成提案'}</span></h4>{job.proposal && <p className="goal-summary">{job.proposal.summary}</p>}<p className="form-hint">{date(job.startedAt)} · {job.config.model} / {job.config.effort}<br/>{job.usage === null ? '用量未知 · 尚不能计作零' : `${count(job.usage)} tokens`} · {job.stopConfirmed ? '进程已确认停止' : '停止仍待核对'}</p>{job.error && <div className="notice error compact"><strong>{describeGoalProblem(job.error)}</strong><details className="technical-details"><summary>查看分析错误原文</summary><pre>{job.error}</pre></details></div>}<details className="technical-details"><summary>查看会话编号与摘要绑定的证据</summary><p className="mono subtle">会话 {job.threadId || '尚未创建'}<br/>作业 {job.id}</p>{Object.entries(job.proofs).map(([path, digest]) => <p className="verification-proof mono" key={path}>{path}<br/>{digest}</p>)}<pre>{JSON.stringify(job.context, null, 2)}</pre></details></div>)}</details>
        {goalPending && goalPending.sessionId === goalSession.id && <div className="notice compact"><p>有待核对的主控请求。重试复用同一请求编号与原记录版本；不会创建第二次派发。</p><div className="verification-buttons"><button className="button" disabled={!online || busy} onClick={() => { void performGoalAction(goalPending); }}>重试同一主控请求</button><button className="button ghost" disabled={busy} onClick={() => { goalPendingRef.current = null; setGoalPending(null); setGoalActionError(''); }}>清除主控待核对记录</button></div><p className="form-hint">清除不会取消后台分析；请先核对实际状态。</p></div>}
      </div><footer className="detail-actions"><button className="button ghost" disabled={!online || busy || goalLoading} onClick={() => setRevision(value => value + 1)}><Icon name="refresh"/>核对需求记录</button>{goalSession.runtimeId && goalSession.phase === 'thinking' && <button className="button danger" disabled={!online || busy || Boolean(goalPending) || sessionRuntime?.cancelled || selectedGoal?.run.status === 'succeeded'} onClick={() => { void cancelSessionRuntime(); }}><Icon name="stop"/>取消任务与主控分析</button>}{!goalSession.runtimeId && goalSession.phase !== 'cancelled' && <button className="button danger" disabled={!online || busy || Boolean(goalPending)} onClick={() => goalAction('cancel')}><Icon name="stop"/>取消需求会话</button>}<button className="button" disabled={busy} onClick={() => { void openWorkspace(goalSession.id); }}><Icon name="folder"/>打开目录</button></footer></aside>}
      {detailOpen && chosen && !goalSession && <aside className="detail" aria-label="任务详情"><header className="detail-header"><div className="detail-title"><h2>{chosenRuntime ? '任务详情' : '尝试详情'}</h2><button className="icon-button" aria-label="关闭任务详情" onClick={() => setDetailOpen(false)}><Icon name="close"/></button></div><p className="detail-goal">{chosen.prompt}</p><Status record={chosen} deliveryLabel={deliveryLabel}/></header><div className="detail-body">
        <dl className="facts"><dt>项目目录</dt><dd>{chosen.workspace}<br/><span className="subtle">{chosen.workspaceKind === 'managed' ? 'Supervisor 暂存工作区 · 持续保留' : '本地项目'}</span></dd><dt>创建时间</dt><dd>{date(chosen.createdAt)}</dd>
          {chosenRuntime && <><dt>步骤位置</dt><dd>{Math.min(chosenRuntime.cursor + 1, chosenRuntime.definition.steps.length)} / {chosenRuntime.definition.steps.length} · {waitingStep?.kind || '全部步骤结束'}</dd><dt>累计用量</dt><dd>{detail ? `${count(detail.run.budget.spent)} tokens · ${detail.run.attempts.filter(attempt => !attempt.settled).length} 次用量待结算` : '等待后台账本'}</dd><dt>预算</dt><dd>{formatTokenLimit(chosenRuntime.definition.tokenLimit)} tokens · 验收预留 {count(chosenRuntime.definition.verificationReserve)}</dd></>}
          {chosenExecution && <><dt>模型 / 深度</dt><dd>{chosenExecution.model} / {chosenExecution.effort}</dd><dt>当前尝试</dt><dd>{chosenExecution.state === 'completed' ? '模型执行已结束' : labels[chosenExecution.state]}</dd><dt>进程状态</dt><dd>{chosenExecution.stopConfirmed ? '已确认停止' : '尚未确认停止'}{chosenExecution.pid ? ` · PID ${chosenExecution.pid}` : ''}</dd><dt>超时期限</dt><dd>{date(chosenExecution.deadline)}</dd>{!chosenRuntime && <><dt>用量</dt><dd>{chosenExecution.usageStatus === 'reported' && chosenExecution.usage ? `${count(chosenExecution.usage.totalTokens)} tokens` : '未知 · 待执行器回报'}</dd><dt>预算</dt><dd>{formatTokenLimit(chosenExecution.tokenLimit)} tokens · 验收预留 {count(chosenExecution.verificationReserve)}</dd></>}</>}
        </dl>
        {associatedSession && <section className="goal-origin"><h3 className="section-title">主控需求与项目记忆</h3><p className="form-hint">{associatedSession.proposal?.summary || '已保存需求准入记录。'}</p><button className="button" onClick={() => { setShowGoalDetails(true); setSelected(associatedSession.id); setDetailOpen(true); setProject(associatedSession.workspace); setComposer(false); }}>查看需求记录与恢复主控</button></section>}
        {chosenRuntime?.paused && <div className="notice compact">已暂停新的步骤派发。在途执行继续运行，可另行取消任务。</div>}
        {['completed', 'awaiting-verification'].includes(chosen.state) && !hasDelivery && <div className="notice compact">步骤或执行已结束，待独立验收。尚未判定为已交付。</div>}
        {chosenRuntime?.phase === 'blocked' && <div className="notice compact">恢复核对尚未完成。未知副作用不会自动重复执行。</div>}
        {chosen.error && <div className="notice error compact"><strong>{describeTaskError(chosen.error)}</strong><details className="technical-details"><summary>查看执行或恢复错误原文</summary><pre>{chosen.error}</pre></details></div>}
        {chosenRuntime && <SupervisionPanel key={chosenRuntime.id} api={api} runtime={chosenRuntime} config={sessions.find(session=>session.runtimeId===chosenRuntime.id)?.config??null} maxContextChars={sessions.find(session=>session.runtimeId===chosenRuntime.id)?.maxContextChars??60000} online={online} terminal={detail?.run.status==='succeeded'}/> }
        {chosenRuntime && (chosenRuntime.phase === 'awaiting-verification' || Boolean(verification?.proposals.length || verification?.jobs.length)) && <section className="verification-panel" aria-label="独立验收与交付">
          <div className="verification-heading"><h3>独立验收与交付</h3><button className="button ghost" disabled={!online || verificationLoading} onClick={() => setVerificationRevision(value => value + 1)} aria-label="重新核对验收状态"><Icon name="refresh"/>核对</button></div>
          <p className="form-hint">先独立复核验收定义，再发布、冻结并实际验收；每一步单独确认。UI 验证当前支持候选目录内的本地 HTML 页面操作和截图。</p>
          {!online && <div className="notice compact">界面未连接后台，以下为上次已知验收状态；当前交付有效性待重新核对。</div>}
          {verificationError && <div className="notice error compact" role="alert">{verificationError}</div>}
          {verificationReadError && <div className="notice error compact" role="alert">验收状态同步失败，当前交付有效性待核对：{verificationReadError}</div>}
          {verification?.currentDelivery.delivery ? <div className={`notice compact ${deliveryHistory?.error || (!deliveryHistory && currentDeliveryKnown && !verificationLoading && !verification.currentDelivery.current) ? 'error' : ''}`} role="status">
            <strong>{deliveryHistory?.title ?? deliveryLabel}</strong>
            {deliveryHistory ? <><p>{deliveryHistory.detail}</p>{deliveryHistory.notes.length > 0 && <ul>{deliveryHistory.notes.map(note => <li key={note}>{note}</li>)}</ul>}</> : currentDeliveryKnown && !verificationLoading && !deliveryCurrent && <><p>{deliveryProblem?.description}</p><p>下一步：{verificationTerminal ? '此轮已有交付记录，可在持续跟进中发送新要求，开启下一轮独立交付。' : deliveryProblem?.next}</p></>}
            {(!currentDeliveryKnown || verificationLoading) && <p>这里保留上次交付记录；当前有效性等待本轮后台证据核对。</p>}
            <details className="technical-details"><summary>查看交付记录与技术原因</summary><dl className="facts"><dt>交付编号</dt><dd className="mono">{verification.currentDelivery.delivery.id}</dd><dt>候选摘要</dt><dd className="mono">{verification.currentDelivery.delivery.candidateDigest}</dd><dt>后台原因</dt><dd>{verification.currentDelivery.reason || '上次核对未返回失效原因。'}</dd></dl></details>
          </div> : <p className="form-hint">尚无已确认交付；运行结束不会自动完成验收。</p>}
          {verificationTerminal && <div className="notice compact"><p>{hasDelivery ? '此任务已有交付记录；原任务已结束，不能再次派发验收。' : '此任务已结束，不能再派发新的验收。'}可在上方持续跟进中发送新要求。</p><button className="button primary" disabled={busy || Boolean(pending)} onClick={renewTask}>在同项目新建任务</button><p className="form-hint">将预填项目目录和原目标，确认后才会提交执行。</p></div>}
          {verificationData?.runtimeId === selected && <p className="form-hint">{verificationLoading ? '正在核对后台证据…' : `最近核对 ${time(verificationData.checkedAt)} · 选中任务每 15 秒同步`}</p>}
          <VerificationVersionsPanel key={chosenRuntime.id} api={api} runtimeId={chosenRuntime.id} status={verification??null} online={online} readError={verificationReadError}/>
          <details className="advanced-verification"><summary>高级：提交定义与逐步验收</summary>
          <label className="field"><span>1 · 项目验收定义 JSON</span><div className="input-action"><input aria-label="验收定义路径" value={specPath} readOnly placeholder="通过系统文件选择器选择定义"/><button type="button" className="button" disabled={!online || busy || Boolean(verificationPending)} onClick={() => { void chooseSpec(); }}>选择 JSON</button></div></label>
          <button className="button" disabled={!verificationReady || !specPath} onClick={() => verificationAction('propose')}>提交验收提案</button>
          <label className="field verification-select"><span>当前提案</span><select aria-label="当前验收提案" value={proposal?.id || ''} onChange={event => setProposalId(event.target.value)} disabled={!verification?.proposals.length || busy || Boolean(verificationPending)}><option value="" disabled>尚无提案</option>{verification && newest(verification.proposals).map(item => <option key={item.id} value={item.id}>{item.status === 'published' ? `已发布 v${item.version}` : '待独立复核'} · {date(item.createdAt)}</option>)}</select></label>
          {proposal && <details className="technical-details"><summary>查看当前提案的定义与候选摘要</summary><dl className="facts"><dt>定义摘要</dt><dd className="mono">{proposal.bundle.digest}</dd><dt>候选摘要</dt><dd className="mono">{proposal.candidate.digest}</dd><dt>提案编号</dt><dd className="mono">{proposal.id}</dd></dl></details>}
          <details className="verification-config" open={!reviewModel}><summary>独立模型与验收预算</summary><fieldset disabled={busy || Boolean(verificationPending)}>
            <label className="field"><span>评审模型</span><select aria-label="验收评审模型" value={reviewModel} onChange={event => { const next = modelOptions.find(item => item.id === event.target.value)?.capability; setReviewModel(event.target.value); setReviewEffort(next?.defaultEffort || next?.reasoningEfforts[0] || ''); }} disabled={!capabilities}><option value="" disabled>发现实际模型后选择</option>{reviewModel && !modelOptions.some(item => item.id === reviewModel) && <option value={reviewModel} disabled>{reviewModel} · 请重新选择</option>}{modelOptions.map(item => <option key={item.id} value={item.id} disabled={!item.capability}>{item.label}{!item.capability ? ' · CLI 未公布' : ''}</option>)}</select></label>
            {capabilities && unavailableModelLabels && <p className="form-hint">{unavailableModelLabels} 尚未由当前 Codex CLI 公布。</p>}
            <label className="field"><span>评审深度</span><select aria-label="验收评审深度" value={reviewEffort} onChange={event => setReviewEffort(event.target.value)} disabled={!reviewCapability}><option value="" disabled>请选择</option>{reviewCapability?.reasoningEfforts.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
            <label className="field"><span>本次验收预留（tokens）</span><input aria-label="本次验收预留" type="number" min="1" max={availableBudget !== null && Number.isFinite(availableBudget) ? availableBudget : undefined} value={reviewReservation} onChange={event => setReviewReservation(Number(event.target.value))}/></label>
            <label className="field"><span>本次验收超时（秒）</span><input aria-label="本次验收超时" type="number" min="1" max="3600" value={reviewTimeout} onChange={event => setReviewTimeout(Number(event.target.value))}/></label>
          </fieldset><p className="form-hint">沿用任务累计账本；{availableBudget === null ? '正在读取可用额度' : `当前可用 ${Number.isFinite(availableBudget)?count(availableBudget):'无限'} tokens`}。未知用量不会计作零。独立复核会执行定义中的正反控制。</p></details>
          {capError && <div className="validation">评审模型发现失败：{capError} <button className="button ghost" disabled={!online || capLoading} onClick={() => { void loadCapabilities(); }}>重新发现模型</button></div>}
          <div className="verification-buttons"><button className="button primary" disabled={!verificationReady || !proposal || proposal.status === 'published' || !reviewCapability || !reviewCapability.reasoningEfforts.includes(reviewEffort)} onClick={() => verificationAction('review')}>2 · 独立复核定义</button><button className="button" disabled={!verificationReady || !proposal || proposal.status === 'published' || !reviewJob?.approved || reviewJob.status !== 'finished'} onClick={() => verificationAction('publish')}>3 · 发布已复核定义</button></div>
          {jobSummary(reviewJob, '定义复核')}
          <button className="button" disabled={!verificationReady || proposal?.status !== 'published'} onClick={() => verificationAction('freeze')}>4 · 冻结完整必要清单</button>
          <label className="field verification-select"><span>冻结清单</span><select aria-label="当前冻结验收清单" value={plan?.id || ''} onChange={event => setPlanId(event.target.value)} disabled={!verification?.plans.length || busy || Boolean(verificationPending)}><option value="" disabled>尚未冻结</option>{verification && newest(verification.plans).map(item => <option key={item.id} value={item.id}>库 v{item.catalogVersion} · {item.selection.mode === 'final' ? '完整验收' : '影响范围'} · {date(item.createdAt)}</option>)}</select></label>
          {plan && <><p className="form-hint">冻结 {plan.selection.instances.length} 项 · {plan.selection.completeScope ? '包含完整必要范围' : '未覆盖完整交付范围'}</p><details className="technical-details"><summary>查看冻结清单与候选摘要</summary><dl className="facts"><dt>清单编号</dt><dd className="mono">{plan.id}</dd><dt>候选摘要</dt><dd className="mono">{plan.candidate.digest}</dd></dl></details></>}
          <div className="verification-buttons"><button className="button primary" disabled={!verificationReady || !plan || !reviewCapability || !reviewCapability.reasoningEfforts.includes(reviewEffort)} onClick={() => verificationAction('run')}>5 · 执行独立验收</button><button className="button" disabled={!verificationReady || !verificationJob?.approved || verificationJob.status !== 'finished' || !verificationJob.evaluation?.complete || deliveryCurrent} onClick={() => verificationAction('deliver')}>6 · 确认当前交付</button></div>
          {jobSummary(verificationJob, '候选验收')}
          {activeVerificationJob && <button className="button danger" disabled={!online || busy || Boolean(verificationPending)} onClick={() => verificationAction('cancel')}>取消正在执行的验收</button>}
          {verificationPending && <div className="notice compact"><p>有待核对的 {verificationPending.action.type} 请求。重试会复用同一请求，避免再次派发。</p><div className="verification-buttons"><button className="button" disabled={!online || busy} onClick={() => { void performVerification(verificationPending.action, verificationPending.runtimeId); }}>重试同一请求</button><button className="button ghost" disabled={busy} onClick={() => { verificationPendingRef.current = null; setVerificationPending(null); }}>清除待核对记录</button></div><p className="form-hint">清除记录不会取消后台作业。</p></div>}
          </details>
        </section>}
        {chosenRuntime && waitingStep?.kind === 'input' && !Object.hasOwn(chosenRuntime.inputs, waitingStep.id) && <form onSubmit={event => { void sendInput(event); }} className="runtime-input"><label className="field"><span>{waitingStep.prompt}</span><textarea aria-label="等待步骤输入" value={inputText} onChange={event => setInputText(event.target.value)} maxLength={200000} required disabled={!online || busy || chosenRuntime.cancelled}/></label><button className="button primary" disabled={!online || busy || chosenRuntime.cancelled || !inputText.trim()} type="submit">提交输入</button></form>}
        {chosen.message && <><h3 className="section-title">执行器输出</h3><div className="result">{chosen.message}</div></>}
        {chosenExecution?.diff && <details><summary className="section-title">查看变更差异</summary><pre className="result mono">{chosenExecution.diff}</pre></details>}
        {chosenRuntime && <details><summary className="section-title">恢复信息</summary><dl className="facts"><dt>检查点</dt><dd className="mono">{chosenRuntime.checkpointId || '尚未记录'}</dd><dt>游标 / 版本</dt><dd>{chosenRuntime.cursor} · 编排 v{chosenRuntime.workflowVersion} · 投影 v{chosenRuntime.projectionVersion}</dd><dt>任务编号</dt><dd className="mono">{chosenRuntime.id}</dd><dt>未决操作</dt><dd>{detail ? detail.operations.filter(operation => !['confirmed', 'cancelled'].includes(operation.state)).length : '等待核对'}</dd><dt>检查点摘要</dt><dd>{detail?.checkpoints.at(-1) ? (detail.checkpoints.at(-1)!.valid ? '核对一致' : '不一致 · 恢复阻塞') : '等待核对'}</dd></dl></details>}
        {chosenExecution && <details><summary className="section-title">当前尝试会话</summary><dl className="facts"><dt>会话</dt><dd className="mono">{chosenExecution.threadId || '尚未建立'}</dd><dt>Turn</dt><dd className="mono">{chosenExecution.turnId || '尚未建立'}</dd><dt>尝试编号</dt><dd className="mono">{chosenExecution.id}</dd></dl></details>}
        {eventError && <div className="notice error compact">状态与事件同步失败：{eventError}</div>}
        <h3 className="section-title">活动时间线<span className="subtle">最新在前</span></h3>
        <p className="form-hint">任务调度与模型执行按时间排列；执行结束后仍需独立验收。{timeline.folded > 0 && `已将 ${timeline.folded} 条重复通信、输出片段及进度更新收进原始记录。`}</p>
        {timeline.entries.length ? <ol className="events" aria-label="任务与执行活动">{timeline.entries.map(entry => <EventItem key={entry.key} entry={entry}/>)}</ol> : <p className="no-events">尚无已同步活动。任务可先等待输入或派发；原始通信可在技术记录中核对。</p>}
        {(runtimeEvents.length > 0 || events.length > 0) && <details className="technical-details raw-events"><summary>查看已同步的原始事件（{runtimeEvents.length + events.length} 条）</summary><p className="form-hint">含概览折叠的输出片段与原始通信；界面最多保留最近 100 条任务事件及 300 条执行事件，完整证据保存在后台账本。</p>{chosenRuntime && <p className="mono subtle">任务事件游标 {runtimeEvents.at(-1)?.seq ?? 0}</p>}{runtimeEvents.slice().reverse().map(event => <details key={`raw-runtime-${event.seq}`}><summary>任务 · {event.kind} · {time(event.createdAt)} · #{event.seq}</summary><pre className="result mono">{JSON.stringify(event.payload, null, 2)}</pre></details>)}<p className="mono subtle">执行事件游标 {events.at(-1)?.seq ?? 0}</p>{events.slice().reverse().map(event => <details key={`raw-execution-${event.seq}`}><summary>执行 · {event.kind} · {time(event.receivedAt)} · #{event.seq}</summary><pre className="result mono">{JSON.stringify(event.payload, null, 2)}</pre></details>)}</details>}
        {(events.length >= 300 || runtimeEvents.length >= 100) && <p className="no-events">界面仅保留最近事件；完整事件保存在后台账本。</p>}
      </div><footer className="detail-actions">{chosenRuntime ? <>
        {chosenRuntime.paused ? <button className="button" disabled={!online || busy || chosenRuntime.cancelled} onClick={() => { void control('resume'); }}>恢复派发</button> : <button className="button" disabled={!online || busy || ['cancelled', 'awaiting-verification'].includes(chosenRuntime.phase)} onClick={() => { void control('pause'); }}>暂停派发</button>}
        <button className="button danger" disabled={!online || busy || chosenRuntime.cancelled || chosenRuntime.phase === 'awaiting-verification'} onClick={() => { void control('cancel'); }}><Icon name="stop"/>取消任务</button>
        <button className="button" disabled={!online || busy} onClick={() => { void control('reconcile'); }}>核对恢复状态</button>
      </> : chosenExecution && <><button className="button danger" disabled={!online || busy || chosenExecution.stopConfirmed || chosenExecution.cancelRequested} onClick={() => { void control('cancel'); }}><Icon name="stop"/>{chosenExecution.cancelRequested && !chosenExecution.stopConfirmed ? '等待停止确认' : '取消执行'}</button>{(chosenExecution.state === 'unknown' || chosenExecution.state === 'interrupted' || (!active(chosen) && !chosenExecution.stopConfirmed)) && <button className="button" disabled={!online || busy} onClick={() => { void control('reconcile'); }}>停止并核对进程</button>}</>}</footer></aside>}
      </div><footer className="status-strip"><span>{capabilities ? `Codex ${capabilities.version}` : '本地 IPC'} · 持久任务与独立验收</span><span>{lastSync ? `最近同步 ${time(lastSync)}` : '等待后台连接'} · 退出界面不会停止任务</span></footer>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App/>);
