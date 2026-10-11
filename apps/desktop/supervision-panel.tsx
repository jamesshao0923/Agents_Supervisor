import React,{useEffect,useRef,useState} from 'react';
import type { RuntimeRecord } from '../../packages/contracts/p3.js';
import type { ReasonerConfig } from '../../packages/contracts/p5.js';
import type { SupervisionRecord } from '../../packages/contracts/p6-supervision.js';
import type { SupervisionAction,SupervisionInspection } from '../../packages/contracts/p6-supervision-actions.js';
import { describeTaskError } from './presentation.js';
export interface SupervisionView {loop:SupervisionRecord;routing?:SupervisionInspection['routing'];verification?:SupervisionInspection['verification'];monitor?:SupervisionInspection['monitor'];capabilities?:SupervisionInspection['capabilities']}
export interface SupervisionDesktopAPI {
  supervisionList():Promise<SupervisionView[]>;
  supervisionAttach(input:Omit<Extract<SupervisionAction,{type:'attach'}>,'type'>):Promise<SupervisionView>;
  supervisionPause(loopId:string):Promise<SupervisionView>;
  supervisionResume(loopId:string):Promise<SupervisionView>;
  supervisionStop(loopId:string):Promise<SupervisionView>;
}
const phases:Record<SupervisionRecord['phase'],string>={executing:'等待实施完成',authoring:'生成验收提案',reviewing:'独立复核验收定义',publishing:'发布已复核定义',freezing:'冻结当前候选',verifying:'执行独立验收',diagnosing:'分析失败原因',repairing:'准备按原标准修复',delivering:'核对最终交付',blocked:'等待问题处理',complete:'独立验收已交付'};
/** Mounted with a runtime key: late replies can never update another project's panel. */
export function SupervisionPanel({api,runtime,config,maxContextChars,online,terminal}:{api:SupervisionDesktopAPI;runtime:RuntimeRecord;config:ReasonerConfig|null;maxContextChars:number;online:boolean;terminal:boolean}){
  const [view,setView]=useState<SupervisionView|null>(null),[known,setKnown]=useState(false),[error,setError]=useState(''),[readError,setReadError]=useState(''),[busy,setBusy]=useState(false);
  const [maxRepairs,setMaxRepairs]=useState(3),[maxCalls,setMaxCalls]=useState(12),[hours,setHours]=useState(24);
  const alive=useRef(true),generation=useRef(0),pending=useRef<Parameters<SupervisionDesktopAPI['supervisionAttach']>[0]|null>(null);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
  useEffect(()=>{
    if(!online){setKnown(false);return;}
    let ended=false,timer:ReturnType<typeof setTimeout>;
    async function poll(){const revision=generation.current;try{const records=await api.supervisionList();if(!ended&&alive.current&&revision===generation.current){setView(records.find(value=>value.loop.runtimeId===runtime.id)??null);setKnown(true);setReadError('');}}catch(error){if(!ended&&alive.current&&revision===generation.current){setKnown(false);setReadError(String(error));}}finally{if(!ended)timer=setTimeout(()=>{void poll();},5000);}}
    void poll();return()=>{ended=true;clearTimeout(timer);};
  },[api,online,runtime.id]);
  async function act(kind:'attach'|'pause'|'resume'|'stop'){
    if(!online||busy)return;setBusy(true);setError('');generation.current++;
    try{
      let result:SupervisionView;
      if(kind==='attach'){
        if(!config)throw new Error('缺少已准入需求的主控配置');
        if(!Number.isInteger(maxRepairs)||maxRepairs<0||maxRepairs>100||!Number.isInteger(maxCalls)||maxCalls<1||maxCalls>1000||!Number.isInteger(hours)||hours<1||hours>720)throw new Error('请填写有效的监督次数与时限');
        pending.current??={commandId:crypto.randomUUID(),runtimeId:runtime.id,config,authoringProtocol:'acceptance-stages-v1',limits:{maxRepairs,maxReasoningCalls:maxCalls,maxDurationMs:hours*3600000,maxContextChars}};
        result=await api.supervisionAttach(pending.current);pending.current=null;
      }else{if(!view)throw new Error('监督状态尚未读取');result=await (kind==='pause'?api.supervisionPause:kind==='resume'?api.supervisionResume:api.supervisionStop)(view.loop.id);}
      if(alive.current){setView(result);setKnown(true);}
    }catch(error){if(alive.current)setError(String(error));}
    finally{if(alive.current)setBusy(false);}
  }
  const loop=view?.loop;
  const monitor=view?.monitor,latestWindow=monitor?.events.filter(event=>event.kind==='window'||event.kind==='transition').at(-1);
  const applied=monitor?.events.filter(event=>event.kind==='disposition'&&event.record.disposition==='applied').at(-1);
  const observation=applied?monitor?.jobs.find(job=>job.id===applied.jobId):null;
  const activeInspection=monitor?.jobs.find(job=>job.id===monitor.envelope?.activeJobId);
  const summary=observation?.result&&typeof observation.result==='object'&&'summary'in observation.result&&typeof observation.result.summary==='string'?observation.result.summary:null;
  const monitorStatus=!online||!known?'巡检状态待核对':activeInspection?.status==='finished'&&(activeInspection.usage===null||!activeInspection.stopConfirmed)?'巡检用量或停止状态待核对':loop?.stopped?'巡检已停止':loop?.paused?'巡检已暂停':loop?.phase==='complete'?'任务已交付，巡检结束':loop?.phase==='blocked'?'巡检等待问题处理':monitor?.envelope?.activeJobId?'正在核对运行进展':loop?.phase!=='executing'?'正在处理当前阶段，执行巡检待命':latestWindow?.record.decision==='skip'?'进展没有变化，本轮未调用模型':monitor?.envelope?'等待下一个巡检时点':'尚未进入执行巡检';
  return <section className="verification-panel" aria-label="自动监督">
    <h3 className="section-title">自动监督</h3>
    <p className="form-hint">实施完成后自动生成验收提案，独立复核、验证；产品缺陷按原标准修复后复验。所有调用共用任务累计预算。</p>
    {!online&&<p className="notice compact">后台未连接，当前监督状态待核对。</p>}
    {loop?<>
      <p role="status"><strong>{loop.stopped?'监督已停止':loop.paused?'监督已暂停':phases[loop.phase]}</strong></p>
      <p className="form-hint">已修复 {loop.repairCount} / {loop.limits.maxRepairs} 次 · 主控分析 {loop.reasoningCount} / {loop.limits.maxReasoningCalls} 次<br/>目标每 10–15 秒核对状态（忙时可能延后）；{view?.capabilities?.modelMonitoring?'执行期间每 5 分钟按进展变化巡检，阶段切换时另行分析。':'模型分析在阶段切换时触发。'}</p>
      {view?.capabilities?.modelMonitoring&&<div className="notice compact" aria-label="运行巡检"><p><strong>{monitorStatus}</strong></p>{summary&&<><p>{summary}</p><p className="form-hint">最近有效观察 · {new Date(applied!.record.observedAt).toLocaleString()}。巡检结论不代替独立验收。</p></>}</div>}
      {!!monitor?.concerns?.length&&<div className="notice compact" aria-label="巡检后续核对">{monitor.concerns.map(item=>{
        const job=item.binding?view?.verification?.jobs.find(job=>job.id===item.binding!.verificationJobId):null;
        const state=item.invalidation?(item.invalidation.reason==='contract-changed'?'需求已更新，保留此前观察':item.invalidation.reason==='cancelled'?'任务已停止，保留此前观察':'已交付任务的历史观察'):
          !item.binding?'已排入完整独立验收':!job?'验收状态待核对':job.status==='running'?'正在进行完整独立验收':job.error?'验收遇到问题，等待处理':job.approved&&job.evaluation?.complete?'完整验收通过；交付状态见任务':'完整验收未通过，仍需处理';
        return <p key={item.consumption.id}><strong>{state}</strong><br/>{item.consumption.observation.summary}</p>;
      })}</div>}
      {!!view?.routing?.routes.length&&<div className="notice compact" aria-label="模型调整记录">{view.routing.routes.map(route=><p key={route.id}><strong>按验收失败调整模型与思考强度</strong><br/>{route.baseline.model} / {route.baseline.effort} → {route.selected.model} / {route.selected.effort}<br/><span className="form-hint">沿用原任务要求与单次预留 {route.selected.reservation.toLocaleString()} tokens；仍须独立验收。</span></p>)}</div>}
      {loop.reason&&<div className="notice compact"><p>{/[\u3400-\u9fff]/.test(loop.reason)?loop.reason:describeTaskError(loop.reason)}</p><details className="technical-details"><summary>查看监督原因</summary><pre>{loop.reason}</pre></details></div>}
      {!loop.stopped&&loop.phase!=='complete'&&<div className="verification-buttons"><button className="button" disabled={!online||!known||busy} onClick={()=>{void act(loop.paused?'resume':'pause');}}>{loop.paused?'恢复监督':'暂停监督'}</button><button className="button danger" disabled={!online||!known||busy} onClick={()=>{void act('stop');}}>停止自动监督</button></div>}
      <p className="form-hint">监督控制只影响主控与验收；停止整个任务请使用下方“取消任务”。</p>
    </>:<>
      <details className="verification-config"><summary>监督边界</summary><fieldset disabled={busy||Boolean(pending.current)}>
        <label className="field"><span>最多修复次数</span><input type="number" min="0" max="100" value={maxRepairs} onChange={event=>setMaxRepairs(Number(event.target.value))}/></label>
        <label className="field"><span>最多主控分析次数</span><input type="number" min="1" max="1000" value={maxCalls} onChange={event=>setMaxCalls(Number(event.target.value))}/></label>
        <label className="field"><span>总时限（小时）</span><input type="number" min="1" max="720" value={hours} onChange={event=>setHours(Number(event.target.value))}/></label>
        <p className="form-hint">{config?`沿用需求主控 ${config.model} / ${config.effort}，单次预留 ${config.reservation.toLocaleString()} tokens。`:'需要已准入的明确需求与验收条款。'}</p>
      </fieldset></details>
      <button className="button primary" disabled={!online||!known||busy||!config||terminal||runtime.cancelled} onClick={()=>{void act('attach');}}>{pending.current?'核对同一监督请求':'开始自动监督'}</button>
    </>}
    {(error||readError)&&<div className="notice error compact" role="alert"><p>{describeTaskError(error||readError)}</p><details className="technical-details"><summary>查看错误原因</summary><pre>{error||readError}</pre></details></div>}
  </section>;
}
