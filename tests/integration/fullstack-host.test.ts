import {createServer} from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FullstackHost,assertOwnedApplication} from '../../packages/verification/fullstack-host.js';
import {captureCandidate,assertCandidate} from '../../packages/verification/candidate.js';
const application=String.raw`import {createServer} from 'node:http';import {DatabaseSync} from 'node:sqlite';
export function createApplication({databasePath}){const db=new DatabaseSync(databasePath);db.exec('CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, text TEXT NOT NULL)');const server=createServer(async(req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/notes'&&req.method==='GET'){res.end(JSON.stringify(db.prepare('SELECT text FROM notes ORDER BY id').all()));return;}if(req.url==='/notes'&&req.method==='POST'){let raw='';for await(const b of req)raw+=b;const v=JSON.parse(raw);if(typeof v.text!=='string'||!v.text.trim()){res.statusCode=400;res.end(JSON.stringify({error:'text required'}));return;}db.prepare('INSERT INTO notes(text) VALUES(?)').run(v.text);res.statusCode=201;res.end(JSON.stringify({saved:true}));return;}res.statusCode=404;res.end('{}');});server.once('close',()=>db.close());return server;}`;
async function setup(){const root=await realpath(await mkdtemp(join(tmpdir(),'supervisor-fullstack-'))),project=join(root,'project');await mkdir(project);await writeFile(join(project,'server.mjs'),application);const candidate=await captureCandidate(project,join(root,'candidate'));return {root,project,candidate};}
test('P8-FULLSTACK-I01 actual HTTP SQLite write read error and owned restart preserve data and frozen source',{timeout:60000},async t=>{
 const {root,candidate}=await setup(),host=new FullstackHost(candidate,'server.mjs',join(root,'host'),45000);t.after(()=>host.close());
 const origin=await host.start();await assertOwnedApplication(origin,host.processes[0]!.identity!);assert.equal((await host.request({method:'POST',path:'/notes',body:{text:'Actual database value'}})).status,201);assert.equal((await host.request({method:'POST',path:'/notes',body:{text:''}})).status,400);assert.deepEqual(JSON.parse((await host.request({method:'GET',path:'/notes'})).body),[{text:'Actual database value'}]);
 await host.restart();assert.deepEqual(JSON.parse((await host.request({method:'GET',path:'/notes'})).body),[{text:'Actual database value'}]);await host.close();await assert.rejects(assertOwnedApplication(origin,host.processes[0]!.identity!),/ownership/);assert.equal(host.processes.length,2);assert.ok(host.processes.every(p=>p.result?.stopped));const db=await readFile(join(root,'host/database/application.sqlite'));assert.equal(db.subarray(0,15).toString(),'SQLite format 3');await assertCandidate(candidate);t.diagnostic(root);
});
test('P8-FULLSTACK-I02 changed source and foreign request origin cannot establish verified execution',{timeout:30000},async t=>{
 const {root,candidate}=await setup(),host=new FullstackHost(candidate,'server.mjs',join(root,'host'),20000);t.after(()=>host.close());await host.start();await assert.rejects(host.request({method:'GET',path:'//example.com'}),/Unsupported/);await host.close();await writeFile(join(candidate.tree,'server.mjs'),application+'\n// changed');const next=new FullstackHost(candidate,'server.mjs',join(root,'other'),10000);await assert.rejects(next.start(),/invalid/);assert.equal(next.processes.length,0);t.diagnostic(root);
});
test('P8-FULLSTACK-I03 actual abort stops owned service and cannot be restarted',{timeout:30000},async t=>{
 const {root,candidate}=await setup(),abort=new AbortController(),host=new FullstackHost(candidate,'server.mjs',join(root,'host'),20000,abort.signal);t.after(()=>host.close());await host.start();abort.abort();await host.close();assert.ok(host.processes.every(p=>p.result?.stopped));await assert.rejects(host.start(),/closed/);t.diagnostic(root);
});

test('P8-FULLSTACK-I04 foreign listener replacement rejects before response acceptance',{timeout:30000},async t=>{
 const {root,project}=await setup();await writeFile(join(project,'server.mjs'),`import{createServer}from'node:http';export function createApplication(){setInterval(()=>{},1000);const server=createServer((req,res)=>{res.setHeader('connection','close');res.end('OWNED');if(req.url==='/release')server.close();});return server;}`);
 const candidate=await captureCandidate(project,join(root,'replacement-candidate')),host=new FullstackHost(candidate,'server.mjs',join(root,'replacement-host'),20000);let foreign:ReturnType<typeof createServer>|null=null;
 try{const origin=await host.start();const release=await fetch(origin+'/release',{headers:{connection:'close'}});assert.equal(await release.text(),'OWNED');foreign=createServer((_req,res)=>res.end('ACTUAL FOREIGN LISTENER'));await new Promise<void>((yes,no)=>{foreign!.once('error',no);foreign!.listen(Number(new URL(origin).port),'127.0.0.1',yes);});await assert.rejects(host.request({method:'GET',path:'/value'}),/outside actual managed ownership/);assert.equal(host.requests.length,0);}finally{if(foreign)await new Promise<void>(yes=>{foreign!.closeAllConnections();foreign!.close(()=>yes());});await host.close();}assert.ok(host.processes.every(p=>p.result?.stopped));t.diagnostic(root);
});
test('P8-FULLSTACK-I05 listener loss during request prevents response acceptance',{timeout:30000},async t=>{
 const {root,project}=await setup();await writeFile(join(project,'server.mjs'),`import{createServer}from'node:http';export function createApplication(){setInterval(()=>{},1000);const server=createServer((req,res)=>{server.close();res.setHeader('connection','close');setTimeout(()=>res.end('UNOWNED AFTER REQUEST'),50);});return server;}`);
 const candidate=await captureCandidate(project,join(root,'loss-candidate')),host=new FullstackHost(candidate,'server.mjs',join(root,'loss-host'),20000);try{await host.start();await assert.rejects(host.request({method:'GET',path:'/value'}),/outside actual managed ownership/);assert.equal(host.requests.length,0);}finally{await host.close();}assert.ok(host.processes.every(p=>p.result?.stopped));t.diagnostic(root);
});
