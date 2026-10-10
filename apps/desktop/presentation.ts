import type { ExecutionEvent, ExecutionRecord, ExecutionState, ModelCapability } from '../../packages/contracts/p2.js';
import type { Run } from '../../packages/contracts/p1.js';
import type { RuntimeEvent, RuntimeOperation, RuntimePhase, RuntimeRecord } from '../../packages/contracts/p3.js';
import type { GoalSession } from '../../packages/contracts/p5.js';

export const preferredTaskModel = 'gpt-6.1-sol';
export const taskModelCatalog = [
  { id: 'gpt-6-astra', label: '6 Astra' },
  { id: 'gpt-6.1-sol', label: '6.1 Sol' },
  { id: 'gpt-6-luna', label: '6 Luna' },
  { id: 'gpt-5.6-sol', label: '5.6 Sol' },
] as const;
export function taskModelOptions(models: readonly ModelCapability[]) {
  return taskModelCatalog.map(entry => ({ ...entry, capability: models.find(model => model.id === entry.id) ?? null }));
}
export function goalCanAnswer(session: GoalSession): boolean {
  return !session.runtimeId && ['clarifying', 'ready'].includes(session.phase);
}
export function goalCanRestore(session: GoalSession, run: Run, runtime: RuntimeRecord | undefined): boolean {
  return Boolean(session.runtimeId && runtime?.id === session.runtimeId && !['thinking', 'cancelled'].includes(session.phase)
    && !['succeeded', 'cancelled'].includes(run.status)
    && run.attempts.every(attempt => attempt.status !== 'running' && attempt.settled)
    && ['paused', 'blocked', 'awaiting-verification'].includes(runtime.phase));
}

export interface DesktopTask {
  id: string; workspace: string; workspaceKind: 'project' | 'managed'; prompt: string; createdAt: string;
  state: ExecutionState | RuntimePhase | GoalSession['phase']; error: string | null; message: string;
  usage: ExecutionRecord['usage']; usageStatus: ExecutionRecord['usageStatus'];
  runtime?: RuntimeRecord; execution?: ExecutionRecord; session?: GoalSession;
}
export function taskViews(runtimes: RuntimeRecord[], executions: ExecutionRecord[], sessions: GoalSession[] = []): DesktopTask[] {
  const durable = runtimes.map(runtime => {
    const execution = executions.filter(item => item.runtimeBinding?.runtimeId === runtime.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return { id: runtime.id, workspace: runtime.workspace, workspaceKind: runtime.workspaceKind, prompt: runtime.definition.goal, createdAt: runtime.createdAt, state: runtime.phase, error: runtime.error || execution?.error || null, message: execution?.message || '', usage: execution?.usage || null, usageStatus: execution?.usageStatus || 'unknown', runtime, ...(execution ? { execution } : {}) } satisfies DesktopTask;
  });
  const legacy = executions.filter(item => !item.runtimeBinding).map(execution => ({ ...execution, execution } satisfies DesktopTask));
  const requirements = sessions.filter(session => !session.runtimeId).map(session => ({ id: session.id, workspace: session.workspace, workspaceKind: session.workspaceKind, prompt: session.goal, createdAt: session.createdAt, state: session.phase, error: session.error, message: session.proposal?.summary || '', usage: null, usageStatus: 'unknown', session } satisfies DesktopTask));
  return [...durable, ...legacy, ...requirements].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function mergeGoalSessions(current: GoalSession[], incoming: GoalSession[]): GoalSession[] {
  const values = new Map(current.map(session => [session.id, session]));
  for (const session of incoming) {
    const previous = values.get(session.id);
    if (!previous || session.revision >= previous.revision) values.set(session.id, session);
  }
  return [...values.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export const goalPhaseLabels: Record<GoalSession['phase'], string> = {
  thinking: '主控分析中', clarifying: '需要补充需求', ready: '计划已提出 · 待开始执行', admitted: '已准入执行 · 待独立验收', blocked: '主控分析受阻', cancelled: '需求会话已取消'
};
export function describeGoalProblem(reason: string): string {
  if (/revision|stale/i.test(reason)) return '需求记录已有更新，请重新核对后再操作。';
  if (/budget|token|reservation|unsettled/i.test(reason)) return '累计额度或用量结算不满足继续分析的条件，请核对账本。';
  if (/active|quiescent|running|writer|stop/i.test(reason)) return '仍有执行或进程状态待核对，请暂停派发或处理未决操作后再恢复主控。';
  if (/context|capacity|memory|provenance/i.test(reason)) return '项目记忆或上下文无法满足恢复要求，请查看证据并补充必要信息。';
  if (/deadline|timeout/i.test(reason)) return '主控分析达到超时期限，提案尚未确认。';
  return '主控尚未形成可执行提案。请查看原因、核对后台状态后再处理。';
}
export async function goalSessionId(commandId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(commandId));
  return 'goal-' + [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const number = (value: unknown): string => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('zh-CN').format(value) : '待回报';
const excerpt = (value: string, limit = 260): string => value.length > limit ? value.slice(0, limit) + '…' : value;
const stepKinds: Record<string, string> = { codex: '模型执行', input: '等待输入', http: '外部请求' };

export interface EventSummary { title: string; description: string; tone?: 'error' | 'warning' }
export interface TimelineEntry extends EventSummary { key: string; at: string; source: '任务' | '执行'; event: RuntimeEvent | ExecutionEvent }

export function describeRuntimeEvent(event: RuntimeEvent, runtime: RuntimeRecord, operations: RuntimeOperation[]): EventSummary {
  const payload = object(event.payload);
  const operation = operations.find(value => value.id === payload.operationId);
  const step = operation ? `第 ${operation.stepIndex + 1} 步 · ${stepKinds[operation.step.kind] || operation.step.kind}` : '当前步骤';
  switch (event.kind) {
    case 'submitted': {
      const definition = object(payload.definition);
      const steps = Array.isArray(definition.steps) ? definition.steps : [];
      return { title: '任务已创建', description: `已保存 ${steps.length} 个执行步骤；总额度 ${number(definition.tokenLimit)} tokens，独立验收预留 ${number(definition.verificationReserve)} tokens。` };
    }
    case 'input': return { title: '已收到步骤输入', description: string(payload.text) ? excerpt(string(payload.text)) : '输入已持久保存，后续步骤将使用这份输入。' };
    case 'pause': return { title: '已暂停新步骤派发', description: '已在运行的步骤继续执行；恢复派发后再启动后续步骤。' };
    case 'resume': return { title: '已恢复步骤派发', description: '后台将按已保存的位置继续调度。' };
    case 'cancel': return { title: '已请求取消任务', description: '不再派发新步骤；在途进程和副作用仍需核对停止情况。', tone: 'warning' };
    case 'reconcile': return { title: '已请求恢复核对', description: '后台会核对已保存的进程与操作记录；结果尚待确认。' };
    case 'claimed': return { title: '后台已接手步骤', description: `${step}已领取，准备执行。` };
    case 'effect-intent': return { title: '已记录步骤执行意图', description: `${step}即将执行；此记录用于中断后的恢复核对。` };
    case 'recovery-adopted': return { title: '恢复工作进程已接手', description: `${step}将核对已有执行结果，模型请求不会自动重发。` };
    case 'recovery-blocked': return { title: '恢复核对受阻', description: '后台无法确认当前执行结果。请核对恢复状态，解决未决操作后再继续。', tone: 'error' };
    case 'reported': {
      const report = object(payload.report);
      const result = object(report.result);
      if (report.outcome === 'confirmed') {
        const finished = operation && operation.stepIndex + 1 >= runtime.definition.steps.length;
        return { title: '步骤结果已确认', description: `${step}已确认。${finished ? '全部执行步骤已结束，接下来需要独立验收。' : '后台将推进到下一步。'}${typeof result.status === 'number' ? ` HTTP 状态 ${result.status}。` : ''}` };
      }
      if (report.outcome === 'cancelled') return { title: '步骤取消已确认', description: `${step}已返回取消结果。`, tone: 'warning' };
      if (report.outcome === 'failed') return { title: '步骤执行失败', description: `${step}未成功完成，请查看技术详情并核对恢复状态。`, tone: 'error' };
      return { title: '步骤结果尚未确认', description: `${step}的结果仍有未知部分；后台将保留记录，避免重复执行。`, tone: 'warning' };
    }
    default: return { title: '任务记录已更新', description: '后台保存了一条任务记录，可展开查看原始事件。' };
  }
}

function codexParts(event: ExecutionEvent) {
  const payload = object(event.payload);
  const raw = object(payload.raw);
  const params = object(raw.params);
  return { payload, params, item: object(params.item), method: string(payload.method) };
}

export function describeExecutionEvent(event: ExecutionEvent): EventSummary {
  const payload = object(event.payload);
  switch (event.kind) {
    case 'execution-intent': {
      const input = object(payload.input);
      return { title: '模型执行已排队', description: `${string(input.model) || '已选模型'} / ${string(input.effort) || '已选深度'} · 预留 ${number(payload.reservation)} tokens。` };
    }
    case 'protocol-verified': return { title: '执行器协议已核对', description: `已核对本地 Codex ${string(payload.version) || '协议版本'} 的模型能力。` };
    case 'process-intent': return { title: '准备启动执行进程', description: '启动意图已保存，等待记录实际进程身份。' };
    case 'process-identity': return { title: '执行进程已启动', description: '实际进程身份已保存，可用于取消和恢复核对。' };
    case 'thread-created': return { title: '模型会话已建立', description: '已建立本次执行的独立会话。' };
    case 'turn-intent': return { title: '准备发送执行请求', description: '模型、输入和请求意图已保存，等待执行器确认。' };
    case 'turn-started': return { title: '执行器已确认请求', description: '已取得本次执行编号，正在跟踪模型输出。' };
    case 'execution-error': return { title: '执行遇到错误', description: '后台已记录错误；请核对执行与进程状态后处理。', tone: 'error' };
    case 'codex-stderr': return { title: '执行器诊断信息', description: '执行器写入了诊断日志；这条日志本身不代表任务失败。', tone: 'warning' };
    case 'cancel-requested': return { title: '已请求停止模型执行', description: /deadline|timeout/i.test(string(payload.reason)) ? '执行达到超时限制，后台正在停止并核对进程。' : /token|reserved attempt/i.test(string(payload.reason)) ? '已观测用量达到本次预留额度，后台正在停止并核对进程。' : '后台正在停止执行，仍需等待停止确认。', tone: 'warning' };
    case 'interrupt-unconfirmed': return { title: '中断请求尚未确认', description: '执行器未确认中断，后台仍需核对实际进程。', tone: 'warning' };
    case 'deadline-reached': return { title: '执行已达到超时期限', description: '请核对停止结果；超时不会被计为成功。', tone: 'error' };
    case 'process-stop-observed': return { title: '已观测到进程停止', description: '后台正在保存当前工作区内容，随后核对执行结果与用量。' };
    case 'workspace-captured': return payload.unavailable ? { title: '工作区快照未能完整获取', description: '后台记录了快照获取限制；请查看技术详情。此记录不能替代完整候选的独立验收。', tone: 'warning' } : { title: '工作区快照已记录', description: '已记录可获取的当前文件状态，后续独立验收仍需绑定完整候选。' };
    case 'execution-stopped': {
      const evidence = object(payload.evidence);
      const stop = object(evidence.stop);
      const status = string(evidence.terminalStatus);
      const outcome = status === 'completed' ? '模型执行已结束；这不代表独立验收已通过。' : status === 'failed' ? '模型返回失败结果，请查看技术详情。' : status === 'interrupted' ? '模型执行已中断，请核对剩余工作。' : '停止与执行结果已写入记录；当前任务状态以后台核对结果为准。';
      return { title: stop.stopped === false ? '执行停止尚未确认' : '执行收尾已记录', description: `${outcome}${payload.usageSettled === true ? ' 用量已结算。' : ' 用量仍待结算。'}`, ...(status === 'failed' || stop.stopped === false ? { tone: 'error' as const } : {}) };
    }
    case 'codex-raw': return { title: '执行器原始通信', description: '保留执行器收到的原始协议数据。' };
    case 'codex-event': {
      const { payload: value, params, item, method } = codexParts(event);
      const completed = method === 'item/completed';
      if (value.kind === 'waiting') return { title: value.waitingOnApproval ? '执行器正在等待审批' : '执行器正在等待补充输入', description: '当前执行暂未继续；请核对执行器请求。', tone: 'warning' };
      if (value.kind === 'thread-status') {
        const statuses: Record<string, string> = { active: '模型正在处理请求。', idle: '会话暂时空闲，仍以本次执行终态为准。', systemError: '会话报告系统错误，请核对执行结果。', notLoaded: '会话尚未加载。' };
        return { title: '模型会话状态已更新', description: statuses[string(value.status)] || '执行器返回了尚未识别的会话状态。', ...(value.status === 'systemError' ? { tone: 'error' as const } : {}) };
      }
      if (value.kind === 'turn-status') {
        const states: Record<string, EventSummary> = {
          inProgress: { title: '模型开始执行', description: '执行器正在处理本次请求。' },
          completed: { title: '模型返回执行终态', description: '模型执行已结束；后台仍需确认进程停止、用量结算与独立验收。' },
          failed: { title: '模型执行失败', description: '模型返回失败终态，后台将核对并保存结果。', tone: 'error' },
          interrupted: { title: '模型执行已中断', description: '模型返回中断终态，后台将核对停止结果。', tone: 'warning' }
        };
        return states[string(value.status)] || { title: '模型执行状态待核对', description: '执行器返回了尚未识别的执行状态。', tone: 'warning' };
      }
      if (value.kind === 'token-usage') return { title: '模型用量已更新', description: `累计报告 ${number(object(object(value.tokenUsage).total).totalTokens)} tokens；结算状态以后台账本为准。` };
      if (value.kind === 'diff') return { title: '文件差异已更新', description: '执行器报告了工作区变更，可在「查看变更差异」中查看。' };
      if (value.kind === 'message') return { title: item.phase === 'final' ? '模型已返回最终回复' : completed ? '模型进度说明' : '模型正在输出', description: excerpt(string(value.text)) || '输出内容正在生成，可在执行器输出中查看。' };
      if (value.kind === 'error') return { title: value.willRetry ? '模型遇到错误，正在重试' : '模型报告错误', description: value.willRetry ? '执行器声明会重试；最终结果仍需等待执行终态。' : '错误已记录；这条诊断不能替代实际执行终态。', tone: 'error' };
      if (value.kind === 'protocol-error' || value.kind === 'disconnected') return { title: '执行器连接需要核对', description: '连接或协议发生异常，后台将核对进程与执行结果，模型请求不会自动重发。', tone: 'error' };
      if (value.kind === 'server-request') return { title: '执行器发起交互请求', description: '请核对执行器请求内容与当前执行状态。', tone: 'warning' };
      if (item.type === 'commandExecution') {
        const status = string(item.status);
        if (status === 'declined') return { title: '命令执行被拒绝', description: `${excerpt(string(item.command), 180) || '本地命令'} · 执行器报告此命令被拒绝，不能计为已执行。`, tone: 'warning' };
        const failed = status === 'failed' || typeof item.exitCode === 'number' && item.exitCode !== 0;
        return { title: completed ? failed ? '命令执行失败' : '命令执行已结束' : '正在执行命令', description: `${excerpt(string(item.command), 180) || '本地命令'}${typeof item.exitCode === 'number' ? ` · 退出码 ${item.exitCode}` : ''}`, ...(failed ? { tone: 'error' as const } : {}) };
      }
      if (item.type === 'fileChange') {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const paths = changes.map(change => string(object(change).path)).filter(Boolean);
        if (item.status === 'declined') return { title: '文件修改被拒绝', description: `${paths.length ? excerpt(paths.join('、')) + ' · ' : ''}执行器报告此修改被拒绝，不能计为已完成修改。`, tone: 'warning' };
        const failed = item.status === 'failed';
        return { title: failed ? '文件修改失败' : completed ? '文件修改已记录' : '正在修改文件', description: paths.length ? excerpt(paths.join('、')) : '可在变更差异中查看具体内容。', ...(failed ? { tone: 'error' as const } : {}) };
      }
      if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') return { title: item.status === 'failed' ? '工具调用失败' : completed ? '工具调用已返回' : '正在调用工具', description: [string(item.server), string(item.tool)].filter(Boolean).join(' / ') || '执行器正在使用工具完成工作。', ...(item.status === 'failed' ? { tone: 'error' as const } : {}) };
      if (item.type === 'webSearch') return { title: completed ? '资料搜索已返回' : '正在搜索资料', description: excerpt(string(item.query)) || '执行器正在检索资料。' };
      if (item.type === 'reasoning') return { title: completed ? '模型分析阶段已结束' : '模型正在分析', description: '分析阶段的完成不代表任务已交付。' };
      if (item.type === 'userMessage') return { title: '模型已收到任务输入', description: '本次目标与监督任务输入已送达模型。' };
      if (method === 'thread/started') return { title: '执行器会话已就绪', description: '执行器已创建本次工作会话。' };
      if (method === 'mcpServer/startupStatus/updated') return { title: '工具服务状态已更新', description: `${string(params.name) || '工具服务'} · ${params.status === 'ready' ? '已就绪' : params.status === 'failed' ? '启动失败' : '启动中'}`, ...(params.status === 'failed' ? { tone: 'warning' as const } : {}) };
      return { title: '执行器记录已更新', description: '收到一条补充执行记录，可展开查看原始内容。' };
    }
    default: return { title: '执行记录已更新', description: '后台保存了一条执行记录，可展开查看原始内容。' };
  }
}

/** Hide communication duplicates and streaming fragments only in the overview.
 * All stored events remain available through the separate raw-event disclosure. */
export function buildTimeline(runtimeEvents: RuntimeEvent[], executionEvents: ExecutionEvent[], runtime?: RuntimeRecord, operations: RuntimeOperation[] = []): { entries: TimelineEntry[]; folded: number } {
  const last = new Map<string, number>();
  const completedMessages = new Set<string>();
  for (const event of executionEvents) {
    if (event.kind !== 'codex-event') continue;
    const { payload, params, item, method } = codexParts(event);
    if (['token-usage', 'diff'].includes(string(payload.kind))) last.set(`${string(payload.kind)}:${string(payload.turnId)}`, event.seq);
    if (method === 'item/agentMessage/delta') last.set(`message:${string(params.itemId)}`, event.seq);
    if (method === 'item/completed' && payload.kind === 'message') completedMessages.add(string(item.id));
  }
  let folded = 0;
  const entries: TimelineEntry[] = runtime ? runtimeEvents.map(event => ({ ...describeRuntimeEvent(event, runtime, operations), key: `runtime-${event.seq}`, at: event.createdAt, source: '任务', event })) : [];
  for (const event of executionEvents) {
    let hidden = event.kind === 'codex-raw';
    let summary = describeExecutionEvent(event);
    if (event.kind === 'codex-event') {
      const { payload, params, item, method } = codexParts(event);
      if (['token-usage', 'diff'].includes(string(payload.kind))) hidden ||= last.get(`${string(payload.kind)}:${string(payload.turnId)}`) !== event.seq;
      if (method === 'item/agentMessage/delta') {
        const id = string(params.itemId);
        hidden ||= completedMessages.has(id) || last.get(`message:${id}`) !== event.seq;
        // The latest delta is only a fragment. Do not present it as the full message.
        summary = { title: '模型正在输出', description: '回复正在逐段生成，可在执行器输出中查看当前内容。' };
      }
      hidden ||= payload.kind === 'message' && method === 'item/started';
      hidden ||= item.type === 'userMessage' && method === 'item/started';
      hidden ||= payload.kind === 'unknown' && method.endsWith('/delta');
      hidden ||= payload.kind === 'unknown' && method === 'remoteControl/status/changed';
      hidden ||= payload.kind === 'unknown' && method.startsWith('mcpServer/') && params.status !== 'failed';
    }
    if (hidden) { folded++; continue; }
    entries.push({ ...summary, key: `execution-${event.seq}`, at: event.receivedAt, source: '执行', event });
  }
  return { entries: entries.sort((a, b) => b.at.localeCompare(a.at) || b.event.seq - a.event.seq), folded };
}

export interface VerificationProblem { title: string; description: string; next: string }
export function describeVerificationProblem(reason: string): VerificationProblem {
  if (/environment changed|Environment changed|Verifier environment changed/.test(reason)) return { title: '验收环境已变化', description: '当前验收运行环境与定义复核或候选验收时不一致，旧结果无法证明当前交付有效。', next: '在当前环境重新提交验收提案，独立复核并发布，然后冻结清单、执行验收并确认交付。' };
  if (/Current workspace differs|Candidate changed|Frozen candidate snapshot is invalid/.test(reason)) return { title: '交付文件与已验收候选不一致', description: '当前文件或候选快照与原验收证据绑定的内容不一致。', next: '核对文件变更，重新提交当前候选的提案、独立复核并发布，然后冻结清单、执行验收并确认交付。' };
  if (/definition changed|implementation changed|bundle integrity|catalog changed|Contract changed|contract|Published catalog/i.test(reason)) return { title: '验收标准或任务约定需要重新核对', description: '当前任务约定、验收定义或已发布用例版本无法与旧验收结果保持一致。', next: '核对变更，提交并独立复核当前定义，发布后重新冻结完整必要清单并验收。' };
  if (/Source evidence expired|Source content changed/.test(reason)) return { title: '来源证据已过期或变化', description: '原验收依赖的来源证据无法继续证明当前结论。', next: '重新执行需要这些来源的验收，补齐当前证据后再确认交付。' };
  if (/active|writer|stop unresolved|still active|no stop identity|unresolved.*work|has not stopped/i.test(reason)) return { title: '仍有执行或进程状态待核对', description: '后台尚未确认相关写入和验收进程全部停止，交付有效性无法确认。', next: '先停止并核对相关进程，解除未决操作后重新核对交付。' };
  if (/evidence changed|Missing completed verifier evidence|usage unsettled|necessary instances|proof/i.test(reason)) return { title: '验收证据不再满足交付要求', description: '证据完整性、必要条款覆盖或用量结算无法通过当前核对。', next: '检查证据与必要清单，修复问题后重新实际验收并确认交付。' };
  return { title: '验收结果需要核对', description: '后台未能确认验收结果满足当前要求。具体原因保留在技术详情中。', next: '查看技术原因，处理对应问题后重新核对；需要时重新独立复核、冻结并验收。' };
}

export function describeTaskError(reason: string): string {
  if (/checkpoint/i.test(reason)) return '恢复检查点核对失败，任务暂不能安全继续。';
  if (/deadline|timeout/i.test(reason)) return '执行达到超时期限，请核对停止与执行结果。';
  if (/transport|connection|disconnected/i.test(reason)) return '执行器连接中断，执行结果需要恢复核对。';
  if (/budget|token|reservation/i.test(reason)) return '执行额度或用量需要核对，请检查累计账本。';
  if (/Workspace has|writer|unresolved/i.test(reason)) return '仍有执行或副作用未决，请先核对恢复状态。';
  return '执行或恢复核对报告了错误；原始原因保留在下方技术详情中。';
}
