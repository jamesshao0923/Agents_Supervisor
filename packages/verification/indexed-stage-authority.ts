import {join} from 'node:path';
import type {SupervisorStore} from '../persistence/store.js';
import type {MaterialVerifierBinding} from '../contracts/p4-material.js';
import type {SourceRefreshControlContext,HistoricalMaterialEpoch} from '../contracts/p4-source-refresh.js';
import type {AssembledControlQualification} from '../contracts/p4-control-draft.js';
import type {VerificationSpec} from '../contracts/p4.js';
import type {IndexedCallScope} from './indexed-call-scope.js';
import {indexedCallScopes,exactIndexedCallScope} from './indexed-call-scope.js';
import {verificationDirectory} from './scoped-environment.js';
import {researchDigest} from '../workspace/research-materials.js';
import {currentVerificationCases} from './rules.js';
import {readMaterialBindingSync} from './material.js';

export interface IndexedStageScope extends IndexedCallScope {
  binding?: MaterialVerifierBinding;
  historicalEpoch?: HistoricalMaterialEpoch;
  definitionDigest: string;
  refreshContext?: SourceRefreshControlContext;
  contextRole: 'current' | 'historical' | 'complete-evolution';
}
function ensure(v: unknown, m: string): asserts v {if (!v) throw Error('Indexed stage authority: ' + m);}
function material(spec: VerificationSpec): MaterialVerifierBinding | undefined {
  const values = currentVerificationCases(spec).flatMap(c => c.verifier.kind === 'material' ? [c.verifier.binding] : []);
  if (!values.length) return;
  ensure(values.every(b => researchDigest(b) === researchDigest(values[0])), 'one exact material producer required');
  return values[0];
}
/** Read only real frozen draft/stages. Models and transport adapters cannot
 * nominate a root, source role or matrix row. No verdict is created here. */
export function indexedStageScopes(store: Pick<SupervisorStore,'verification'|'controlQualification'>, jobId: string): IndexedStageScope[] {
  const job = store.verification.get('job', jobId), p = store.verification.get('proposal', job.proposalId);
  ensure(job.proposalId === p.id && job.runtimeId === p.runtimeId && job.projectId === p.projectId && job.runId === p.runId,
    'actual job/proposal scope differs');
  const binding = material(p.spec);
  if (!p.controlDraftDigest || job.kind === 'verification') {
    return indexedCallScopes(store.verification.dataDirectory(),job,p,job.planId ? store.verification.get('plan',job.planId) : undefined)
      .map(s => ({...s,...(binding ? {binding} : {}),definitionDigest:p.bundle.digest,contextRole:'current'}));
  }
  const stored = store.controlQualification.draftForProposal(p.id), draft = stored.draft;
  ensure(stored.draftDigest === p.controlDraftDigest && draft.proposalId === p.id && draft.target.bundle.digest === p.bundle.digest,
    'exact actual frozen draft required');
  const directory = verificationDirectory(store.verification.dataDirectory(),job);
  const scopes: IndexedStageScope[] = [{root:join(directory,'definition-review'),role:'definition-review',
    definitionDigest:p.bundle.digest,contextRole:draft.sourceRefresh ? 'complete-evolution' : 'current',...(draft.sourceRefresh?{refreshContext:draft.sourceRefresh}:{}),...(binding ? {binding} : {})}];
  for (const pair of draft.bootstrapPlan) {
    const detector = [draft.target,...draft.history.definitions].find(d => d.definition.definitionDigest === pair.definitionDigest);
    ensure(detector,'bootstrap detector absent');
    const b = material(detector.definition.spec);
    // Bootstrap is a CURRENT new-witness execution, never historical authority.
    if (b) ensure(binding && researchDigest(b) === researchDigest(binding),'bootstrap may not borrow a historical material basis');
    scopes.push({root:join(directory,'bootstrap',pair.id,pair.instance.id,'model'),role:'instance',instance:pair.instance,
      label:'bootstrap:'+pair.id,definitionDigest:pair.definitionDigest,contextRole:'current',...(b ? {binding:b} : {})});
  }
  const stage = store.controlQualification.stagesForReview(job.id).find(s => s.stage === 'matrix-frozen');
  if (stage) {
    const assembled = (stage.payload as {assembled:AssembledControlQualification}).assembled;
    ensure(stage.proposalId === p.id && stage.reviewJobId === job.id && assembled.matrix.targetDefinitionDigest === p.bundle.digest,
      'matrix does not belong to this actual review');
    for (const row of assembled.matrix.rows) {
      const d = assembled.definitions.find(d => d.definition.definitionDigest === row.definitionDigest); ensure(d,'matrix detector absent');
      const b = material(d.definition.spec), epoch = row.context?.role === 'historical' ? row.context.epoch : undefined;
      if (epoch) ensure(draft.sourceRefresh?.historicalEpochs.some(e => e.digest === epoch.digest) && b && researchDigest(b) === researchDigest(epoch.binding),
        'historical row not in exact frozen refresh inventory');
      else if (b) ensure(binding && researchDigest(b) === researchDigest(binding), 'current matrix row has a foreign material basis');
      scopes.push({root:join(directory,'qualification',row.id,row.instance.id,'model'),role:'instance',instance:row.instance,
        label:'qualification:'+row.id,definitionDigest:row.definitionDigest,contextRole:epoch ? 'historical' : 'current',
        ...(b ? {binding:b} : {}),...(epoch ? {historicalEpoch:epoch} : {})});
    }
  }
  return scopes;
}
export function exactIndexedStage(store:Pick<SupervisorStore,'verification'|'controlQualification'>,jobId:string,root:string):IndexedStageScope {
  const scopes=indexedStageScopes(store,jobId); exactIndexedCallScope(scopes,root);
  const scope=scopes.find(s=>s.root===root)!;
  ensure(scope.binding && readMaterialBindingSync(scope.binding).input.schemaVersion===2,
    'actual indexed producer required for an indexed call');
  return scope;
}
