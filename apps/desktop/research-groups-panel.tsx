import type {GoalProposal} from '../../packages/contracts/p5.js';
import type {GoalResearchGroupingDecision} from '../../packages/contracts/p8-research-group-planning.js';
export function ResearchGroupsProposal({proposal, decision}: {
  proposal: GoalProposal; decision?: GoalResearchGroupingDecision;
}) {
  const groups = proposal.researchGroups?.groups;
  if (!groups?.length && !decision) return null;
  return <section className="goal-section" aria-label="研究分组建议与执行决定">
    <h3 className="section-title">研究分组{decision ? ' · 宿主决定' : ' · 提案'}</h3>
    {decision ? <p className="form-hint" data-mode={decision.mode}>
      {decision.mode === 'grouped' ? `已注册 ${decision.groupCount} 组，最多同时执行 ${decision.maxActive} 组。` : '采用原单分析路径。'}
      {decision.mode === 'grouped' ? '已核对原预算与全部材料覆盖。' : decision.reason.includes('cannot fund every proposed group') ? '原预算可完成完整分析与验收，但不足以增加全部分组。' : decision.reason.includes('structural parallel') ? '该分组没有结构上可并行的机会，保留原完整分析。' : decision.reason.includes('follow-up') ? '本轮继续完整分析，旧分组及其费用、证据只保留为历史。' : '保留原完整分析，不追加分组调用。'}
    </p> : <p className="form-hint">以下是执行分组建议。开始执行时会核对原预算和覆盖；建议尚未派发，不代表已经提升效率。</p>}
    {decision ? <details className="technical-details"><summary>查看宿主决定原文</summary><p>{decision.reason}</p></details> : null}
    {groups?.length ? <ol className="goal-plan">{groups.map(group => <li key={group.id}>
      <strong>{group.purpose}</strong><p className="form-hint">材料：{group.materialIds.join('、')} · 保留 {group.criterionIds.length} 项验收要求</p>
    </li>)}</ol> : null}
    <p className="form-hint">全部原材料和问题仍进入最终完整分析。分组摘录不是独立投票，也不是验收或交付。</p>
  </section>;
}
