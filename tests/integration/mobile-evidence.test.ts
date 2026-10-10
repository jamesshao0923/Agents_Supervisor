import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,chmod,symlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {captureCandidate,digest} from '../../packages/verification/candidate.js';
import {copyArtifact,copyExact,closeMobileCaptures,artifactInventory,type MobileEvidence} from '../../packages/verification/mobile-evidence.js';
import {createMobileDelivery,assertMobileDelivery} from '../../packages/verification/mobile-delivery.js';
import {assertMobileFinalBinding} from '../../packages/verification/mobile-proof-reader.js';
import type {FrozenPlan,VerificationJob,Proposal} from '../../packages/verification/records.js';
async function directory(){const parent=resolve(process.env.SUPERVISOR_EVIDENCE_DIR??'.supervisor-dev/p8-mobile-p4-work','file-mechanisms');await mkdir(parent,{recursive:true});return mkdtemp(join(parent,'case-'));}
// Real FS fixtures check transport/integrity only. They are not compiled APKs, model judgments or P4 authority.
test('P8M-P4-I02 closed mobile captures retain partial originals and reject changed or linked bytes',async()=>{
 const root=await directory(),original=join(root,'actual-command-directory'),out=join(root,'closed');await mkdir(original);await mkdir(out);
 const owner=join(original,'owner.json'),png=join(original,'partial.png'),xml=join(original,'partial.xml');await writeFile(owner,'{"uuid":"explicit-fixture"}');await writeFile(png,Buffer.from([137,80,78,71]));await writeFile(xml,'<hierarchy/>');
 const facts:any={platform:'android',directory:original,proofFiles:{[owner]:digest(await readFile(owner))},screenshot:null,hierarchy:null,interactions:[{status:'failed',captures:[{screenshot:{path:png,sha256:digest(await readFile(png))},hierarchy:{path:xml,sha256:digest(await readFile(xml))}}]}]};
 const closed=await closeMobileCaptures(facts,out);assert.equal(Object.keys(closed).length,3);for(const [path,binding] of Object.entries(closed))assert.deepEqual(await readFile(path),await readFile(binding.copy));
 await writeFile(png,'changed');await assert.rejects(copyExact(png,join(root,'changed-copy'),closed[png]!.sha256),/digest changed/);await symlink(xml,join(root,'linked'));await assert.rejects(copyExact(join(root,'linked'),join(root,'linked-copy')),/noncanonical/);
});
test('P8M-P4-I03 final native package preserves exact bytes and modes and detects later replacement',async()=>{
 const root=await directory(),source=join(root,'source');await mkdir(source);await writeFile(join(source,'MainActivity.java'),'// Explicit source fixture, not a built application');await chmod(join(source,'MainActivity.java'),0o755);const candidate=await captureCandidate(source,join(root,'frozen'));
 const apk=join(root,'not-a-real-apk');await writeFile(apk,Buffer.from([0,1,2,3]));await chmod(apk,0o640);const artifact=await copyArtifact(apk,join(root,'closed-artifact'),'android','dev.fixture.App');const evidence={label:'candidate',instanceId:'function-1',artifact,frames:[],stopped:true,error:null} as unknown as MobileEvidence;
 const plan={id:'explicit-fixture-no-plan-authority',candidate} as FrozenPlan;const job={id:'explicit-fixture-no-job-authority',mobileEvidence:[evidence,{...evidence,instanceId:'function-2'}]} as VerificationJob;
 const pkg=(await createMobileDelivery(root,'fixture-package',plan,job))!;await assertMobileDelivery(pkg);assert.equal(pkg.artifacts.length,1);assert.deepEqual(await artifactInventory(pkg.artifacts[0]!.path),artifact.files);assert.match(await readFile(join(pkg.path,'OPEN.md'),'utf8'),/owned-device/);
 await chmod(join(pkg.artifacts[0]!.path,'application.apk'),0o600);await assert.rejects(assertMobileDelivery(pkg),/artifact changed/);await chmod(join(pkg.artifacts[0]!.path,'application.apk'),0o640);await writeFile(join(pkg.artifacts[0]!.path,'application.apk'),'replaced');await assert.rejects(assertMobileDelivery(pkg),/bytes\/mode changed/);
});
test('P8M-P4-I04 final binding rejects omitted functions altered candidates and mixed native artifacts',async()=>{
 const declaration={kind:'mobile',platform:'android',sourceRoot:'.',appIdentifier:'dev.fixture.App',frames:[{stepId:'save',phase:'after',expectation:'value'}]};const plan={candidate:{digest:'candidate'},selection:{instances:[{id:'i1',caseId:'c1',revision:1},{id:'i2',caseId:'c2',revision:1}]}} as unknown as FrozenPlan;const proposal={spec:{cases:[{id:'c1',revision:1,verifier:declaration},{id:'c2',revision:1,verifier:declaration}]}} as unknown as Proposal;
 const entry=(instanceId:string)=>({label:'candidate',instanceId,candidateDigest:'candidate',sourceRoot:'.',appIdentifier:'dev.fixture.App',artifact:{platform:'android',digest:'same'},frames:declaration.frames});const job={mobileEvidence:[entry('i1'),entry('i2')]} as unknown as VerificationJob;assertMobileFinalBinding(plan,job,proposal);
 assert.throws(()=>assertMobileFinalBinding(plan,{...job,mobileEvidence:[entry('i1')]} as unknown as VerificationJob,proposal),/exact tested artifact/);assert.throws(()=>assertMobileFinalBinding(plan,{...job,mobileEvidence:[entry('i1'),{...entry('i2'),candidateDigest:'other'}]} as unknown as VerificationJob,proposal),/binding changed/);assert.throws(()=>assertMobileFinalBinding(plan,{...job,mobileEvidence:[entry('i1'),{...entry('i2'),artifact:{platform:'android',digest:'different'}}]} as unknown as VerificationJob,proposal),/different mobile artifact/);
});
