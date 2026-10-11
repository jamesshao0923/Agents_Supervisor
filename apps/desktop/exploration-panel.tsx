import React, { useEffect, useRef, useState } from 'react';
import { EXPLORATION_TIERS, type ExplorationAction, type ExplorationInspection } from '../../packages/contracts/p7-exploration.js';
import type { ExplorationTier } from '../../packages/contracts/p7-scheduler.js';
import type { GoalProposal } from '../../packages/contracts/p5.js';

export interface ExplorationDesktopAPI {
  exploration(action: ExplorationAction): Promise<ExplorationInspection>;
}
const labels: Record<ExplorationTier, string> = {
  low: '低 · 只纳入依据最充分的候选',
  medium: '中 · 纳入有支持依据的候选',
  high: '高 · 允许探索性候选',
  unlimited: '不限 · 保留基本相关性与授权检查',
};

const basisLabels = { strong: '依据充分', supported: '有依据支持', exploratory: '探索性判断', uncertain: '尚不确定' };
function notice(reason: string): string {
  const matches: [string, string][] = [
    ['timed out', '请求尚未确认结果，请重试同一请求。'],
    ['Timed out', '请求尚未确认结果，请重试同一请求。'],
    ['CAS', '任务状态已变化，请读取最新状态后重新选择。'],
    ['command conflict', '此前请求与本次内容不一致，请保留原请求并重新核对。'],
    ['unknown shared accounting', '尚有费用未确认，所有新任务暂缓派发。'],
    ['below exploration tier', '依据尚未达到当前探索档位。'],
    ['optional dependency excluded by admission', '前置可选候选未通过当前档位准入，本候选一并暂不纳入。'],
    ['dependency unfinished or unknown', '等待前置任务完成并确认状态。'],
    ['dependency has no frozen result', '等待前置任务发布完整结果。'],
    ['node not pending', '此任务已派发或已有终态记录。'],
    ['task already claimed', '此任务已有执行记录，不会重复派发。'],
    ['shared budget', '剩余预算或保护额度暂不允许派发。'],
    ['active capacity', '等待并发名额。'],
    ['resource conflict', '等待占用中的资源释放。'],
    ['deadline', '已到本轮时限，不能继续派发。'],
    ['Runtime is paused', '任务已暂停，可调整未派发候选的档位；恢复后才会执行。'],
    ['Runtime is cancelled', '任务已取消，不会派发新候选。'],
    ['Integration has started', '最终集成已开始；新增工作请通过对话追加。'],
    ['No optional exploration', '没有可选探索候选；必要任务保持原有执行方式。'],
    ['within loop programs', '当前循环程序暂不支持运行中调整探索档位。'],
    ['cannot reopen', '本轮已结束或进入集成，不能通过调档重新开启。'],
    ['contract changed', '任务要求已变更，请重新读取当前轮次。'],
    ['run does not authorize', '当前任务状态不允许新派发。'],
    ['outside authorization', '候选超出已授权范围。'],
    ['not executable', '候选暂不具备执行条件。'],
    ['not relevant', '候选未通过相关性检查。'],
    ['duplicate', '候选与既有工作重复，未获独立复核授权。'],
  ];
  return matches.find(([needle]) => reason.includes(needle))?.[1] ?? '暂时无法确认当前状态或操作结果，请查看技术详情；重试时保留原请求。';
}

export function ExplorationSelector({ value, onChange, disabled = false }: {
  value: ExplorationTier; onChange: (tier: ExplorationTier) => void; disabled?: boolean;
}) {
  return <label className="field">
    <span>探索档位</span>
    <select value={value} disabled={disabled} onChange={event => onChange(event.target.value as ExplorationTier)}>
      {EXPLORATION_TIERS.map(tier => <option key={tier} value={tier}>{labels[tier]}</option>)}
    </select>
    <small>越高，允许探索的候选越广。必要任务不受影响，预算、并发与时限保持不变。</small>
  </label>;
}

export function ExplorationProposal({ proposal }: { proposal: GoalProposal }) {
  return <section aria-label="可选探索候选">
    <h3>可选探索（{proposal.exploration?.length ?? 0}）</h3>
    <p className="form-hint">核心步骤和全部验收要求始终保留。以下依据是预测，不是事实核验结果。</p>
    {proposal.exploration?.map(candidate => <details key={candidate.id}>
      <summary>{candidate.description}</summary>
      <p>质量依据：{candidate.qualityReason}（{basisLabels[candidate.quality]}）</p>
      <p>预期价值：{candidate.valueReason}（{basisLabels[candidate.value]}）</p>
      <ul>{candidate.sources.map((source, index) => <li key={index}>{source.quote}</li>)}</ul>
      <p>补充输出：{candidate.writes.map(path => path.path).join('、')}</p>
    </details>)}
  </section>;
}

type PanelProps = { schedulerId: string; api: ExplorationDesktopAPI; online: boolean };
export function ExplorationPanel(props: PanelProps) {
  // A scheduler switch destroys pending requests and response handlers for the old panel.
  return <ExplorationPanelSession key={props.schedulerId} {...props} />;
}
function ExplorationPanelSession({ schedulerId, api, online }: PanelProps) {
  const [view, setView] = useState<ExplorationInspection | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<Extract<ExplorationAction, { type: 'set-tier' }> | null>(null);
  const alive = useRef(true), generation = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current++; };
  }, []);
  useEffect(() => {
    let ended = false, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const before = generation.current;
      try {
        const next = await api.exploration({ type: 'inspect', schedulerId });
        if (!ended && alive.current && before === generation.current) {
          setView(next);
          if (!pending.current) setError('');
        }
      } catch (reason) {
        if (!ended && alive.current && before === generation.current) setError(String(reason));
      } finally {
        if (!ended) timer = setTimeout(() => { void poll(); }, 5000);
      }
    }
    if (online) void poll();
    return () => { ended = true; clearTimeout(timer); };
  }, [schedulerId, online, api]);

  async function change(tier: ExplorationTier) {
    if (!view || busy || !online) return;
    pending.current ??= { type: 'set-tier', commandId: crypto.randomUUID(), schedulerId, expected: view.expected, tier };
    setBusy(true);
    generation.current++;
    try {
      const next = await api.exploration(pending.current);
      if (alive.current) {
        generation.current++;
        setView(next); setError(''); pending.current = null;
      }
    } catch (reason) {
      if (alive.current) { generation.current++; setError(String(reason)); }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function resetSelection() {
    pending.current = null;
    setView(null); // A stale CAS must receive a fresh read before a new command is created.
    setError('');
    generation.current++;
  }
  return <section aria-label="运行探索档位">
    <h3>探索与调度</h3>
    {view ? <>
      <ExplorationSelector value={pending.current?.tier ?? view.tier} onChange={tier => void change(tier)}
        disabled={!online || busy || !!pending.current || !view.canChangeTier} />
      <p>必要任务 {view.counts.required} · 可选候选 {view.counts.optional} · 已准入 {view.counts.admitted} · 等待 {view.counts.waiting} · 活跃 {view.counts.active}</p>
      <p className="form-hint">调档只重新评估尚未派发的候选；在途任务与已有结果保留。</p>
      {view.reason && <><p role="status">{notice(view.reason)}</p><details><summary>查看技术详情</summary><pre>{view.reason}</pre></details></>}
      {view.completion && view.completion.unperformedOptional.length > 0 && <section aria-label="本轮未执行的可选探索">
        <h4>本轮未执行的可选探索</h4>
        <p>分支执行已收束。以下候选因预算保护未启动，不计为完成或验收通过。</p>
        <ul>{view.completion.unperformedOptional.map(item => <li key={item.taskId}>
          {item.taskId}：{item.blockedBy.length ? `可选前置任务未执行（${item.blockedBy.join('、')}）` : '剩余预算不足以启动，同时需要保留最终集成与验收额度'}
          <details><summary>查看技术详情</summary><pre>{item.reason}</pre></details>
        </li>)}</ul>
      </section>}
      <ul>{view.decision?.nodes.filter(node => !view.completion?.unperformedOptional.some(item => item.taskId === node.taskId)).map(node => <li key={node.taskId}>
        {node.taskId}：{node.dispatch ? '可派发' : node.admitted ? '已准入' : '未达准入条件'}
        {node.reasons.length > 0 && <> — {[...new Set(node.reasons.map(notice))].join('；')}<details><summary>查看技术详情</summary><pre>{node.reasons.join('\n')}</pre></details></>}
      </li>)}</ul>
    </> : <p>正在读取实际调度状态</p>}
    {error && <><p role="alert">{notice(error)}</p><details><summary>查看错误原文</summary><pre>{error}</pre></details></>}
    {pending.current && <>
      <button disabled={busy || !online} onClick={() => void change(pending.current!.tier)}>重试同一调档请求</button>
      <button disabled={busy || !online} onClick={resetSelection}>重新选择</button>
    </>}
  </section>;
}
