import assert from 'node:assert/strict';
/** Test-harness topology only; detailed live proof/fees checks remain in L01. */
export function assertAuthorRouteChain(authors:readonly {id:string}[], routes:readonly {nextJobId:string;rejection:{previousJobId:string;kind:string}}[], finalId:string):void {
 assert.ok(authors.length>=1&&authors.length<=3);
 assert.equal(new Set(authors.map(job=>job.id)).size,authors.length);
 assert.equal(routes.length,authors.length-1);
 assert.ok(routes.filter(route=>route.rejection.kind==='review').length<=1);
 assert.ok(routes.filter(route=>route.rejection.kind==='schema'||route.rejection.kind==='semantic').length<=1);
 assert.ok(routes.every(route=>['review','schema','semantic'].includes(route.rejection.kind)));
 const byPrevious=new Map(routes.map(route=>[route.rejection.previousJobId,route]));
 assert.equal(byPrevious.size,routes.length,'No branching from an old author');
 const next=new Set(routes.map(route=>route.nextJobId));assert.equal(next.size,routes.length,'No duplicate successor');
 const roots=authors.filter(job=>!next.has(job.id));assert.equal(roots.length,1);
 let current=roots[0]!.id;const seen=new Set<string>();
 for(;;){assert.ok(authors.some(job=>job.id===current),'Route references missing author');assert.ok(!seen.has(current),'Author cycle');seen.add(current);const route=byPrevious.get(current);if(!route)break;current=route.nextJobId;}
 assert.equal(current,finalId,'Final author must be the last successor');assert.equal(seen.size,authors.length,'No orphan author or disconnected cycle');
}
