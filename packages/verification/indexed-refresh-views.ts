import {join} from 'node:path';
import {bytesDigest} from '../workspace/research-runtime-files.js';
import {readMaterialBindingSync} from './material.js';
import type {MaterialVerifierBinding} from '../contracts/p4-material.js';
import type {SourceRefreshControlContext} from '../contracts/p4-source-refresh.js';
import type {IndexedResearchViewEntry,PreparedResearchViewSet} from '../contracts/p8-research-reader.js';
import {readMaterialBinding} from './material.js';
import {assertHistoricalMaterialEpoch} from './source-refresh-controls.js';
import {prepareResearchReader} from '../workspace/research-reader.js';
import {prepareResearchViewSet} from '../workspace/research-reader-views.js';
import {researchDigest} from '../workspace/research-materials.js';

/** Integrity construction only. The consumer compares this inventory with its
 * actual frozen author/matrix authority, never accepts caller epoch permissions. */
export async function captureIndexedRefreshViews(currentBinding:MaterialVerifierBinding,
  refresh:SourceRefreshControlContext):Promise<PreparedResearchViewSet> {
  if(researchDigest(currentBinding)!==researchDigest(refresh.currentBinding))throw Error('Indexed refresh current producer differs');
  const current=await readMaterialBinding(currentBinding);
  if(current.input.schemaVersion!==2||!current.input.indexed)throw Error('Explicit indexed current generation required');
  const root=currentBinding.inputPath.slice(0,currentBinding.inputPath.lastIndexOf('/research-inputs/'));
  const views:IndexedResearchViewEntry[]=[{viewId:'current',reader:current.input.indexed,
    reference:{role:'current',bindingDigest:researchDigest(currentBinding)}}];
  const epochs=new Set<string>();
  for(const epoch of refresh.historicalEpochs){
    assertHistoricalMaterialEpoch(epoch);if(epochs.has(epoch.digest))continue;epochs.add(epoch.digest);
    const original=await readMaterialBinding(epoch.binding);
    if(original.input.schemaVersion!==2||!original.input.indexed||!epoch.indexed)throw Error('Mixed/legacy indexed history unsupported');
    const reader=await prepareResearchReader({intake:original.intake,context:original.input.context,
      materialIds:original.input.indexed.view.allowedMaterialIds,role:'historical',dataRoot:root,
      limits:original.input.indexed.view.limits});
    views.push({viewId:'old-'+epoch.digest.slice(0,60),reader,reference:{role:'historical',epochDigest:epoch.digest}});
  }
  return prepareResearchViewSet(root,views);
}

/** The inventory's bytes/roles/limits come solely from the frozen refresh context.
 * Callers must obtain that context from the actual job/draft/matrix repository. */
export function indexedRefreshViewEntriesSync(currentBinding:MaterialVerifierBinding,
 refresh:SourceRefreshControlContext):IndexedResearchViewEntry[]{
 if(researchDigest(currentBinding)!==researchDigest(refresh.currentBinding))throw Error('Exact refresh producer required');
 const current=readMaterialBindingSync(currentBinding);
 if(current.input.schemaVersion!==2||!current.input.indexed)throw Error('Explicit indexed current input required');
 const root=currentBinding.inputPath.slice(0,currentBinding.inputPath.lastIndexOf('/research-inputs/'));
 const entries:IndexedResearchViewEntry[]=[{viewId:'current',reader:current.input.indexed,reference:{role:'current',bindingDigest:researchDigest(currentBinding)}}];
 const seen=new Set<string>();
 for(const epoch of refresh.historicalEpochs){
  assertHistoricalMaterialEpoch(epoch);if(seen.has(epoch.digest))continue;seen.add(epoch.digest);
  const input=readMaterialBindingSync(epoch.binding).input;
  if(input.schemaVersion!==2||!input.indexed||!epoch.indexed)throw Error('Mixed/legacy indexed historical epoch unsupported');
  const {digest:oldDigest,...oldView}=input.indexed.view;
  const viewBody={...oldView,role:'historical' as const},view={...viewBody,digest:researchDigest(viewBody)};
  const body={schemaVersion:1 as const,protocol:'indexed-material-v1' as const,
   path:join(root,'indexed-material-views',bytesDigest(view.digest),'view.json'),view,context:input.context};
  entries.push({viewId:'old-'+epoch.digest.slice(0,60),reader:{...body,digest:researchDigest(body)},reference:{role:'historical',epochDigest:epoch.digest}});
 }
 return entries;
}
