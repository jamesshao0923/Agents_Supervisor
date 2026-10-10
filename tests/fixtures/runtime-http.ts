import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

// A separate real HTTP application owns its own SQLite effects, independent of Supervisor.
const database = new DatabaseSync(process.argv[2]!);
const options = JSON.parse(process.argv[3]!) as { hold: boolean; deduplicate: boolean };
database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE effects(seq INTEGER PRIMARY KEY,operation_id TEXT NOT NULL,payload_digest TEXT NOT NULL,result TEXT NOT NULL); CREATE TABLE requests(seq INTEGER PRIMARY KEY,method TEXT NOT NULL,operation_id TEXT NOT NULL,aborted INTEGER NOT NULL DEFAULT 0);');
const waiting = new Set<{ response: ServerResponse; receipt: unknown }>();
function answer(response: ServerResponse, receipt: unknown) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(receipt)); }
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://127.0.0.1');
  const id = String(req.headers['idempotency-key'] ?? url.searchParams.get('operationId') ?? url.searchParams.get('key') ?? '');
  const request = database.prepare('INSERT INTO requests(method,operation_id) VALUES (?,?)').run(req.method!, id);
  if (req.method === 'GET') {
    const row = database.prepare('SELECT * FROM effects WHERE operation_id=? ORDER BY seq LIMIT 1').get(id);
    if (!row) { res.writeHead(404); res.end('{}'); return; }
    answer(res, { operationId: id, payloadDigest: String(row.payload_digest), result: JSON.parse(String(row.result)) }); return;
  }
  let body = ''; for await (const chunk of req) body += String(chunk);
  const payloadDigest = createHash('sha256').update(body).digest('hex');
  const existing = options.deduplicate ? database.prepare('SELECT * FROM effects WHERE operation_id=? LIMIT 1').get(id) : undefined;
  if (existing && existing.payload_digest !== payloadDigest) { res.writeHead(409); res.end('{}'); return; }
  if (!existing) {
    database.prepare('INSERT INTO effects(operation_id,payload_digest,result) VALUES (?,?,?)').run(id, payloadDigest, JSON.stringify({ business: 'committed' }));
  }
  const receipt = { operationId: id, payloadDigest, result: { business: 'committed' } };
  process.send?.({ event: 'committed', operationId: id });
  res.once('close', () => { waiting.delete(pending); if (!res.writableEnded) { database.prepare('UPDATE requests SET aborted=1 WHERE seq=?').run(request.lastInsertRowid); process.send?.({ event: 'aborted', operationId: id }); } });
  const pending = { response: res, receipt };
  if (options.hold) waiting.add(pending); else answer(res, receipt);
});
process.on('message', message => { if ((message as { type?: string }).type === 'release') { options.hold = false; for (const pending of waiting) answer(pending.response, pending.receipt); waiting.clear(); } });
server.listen(0, '127.0.0.1', () => { const address = server.address(); if (address && typeof address !== 'string') process.send?.({ event: 'ready', port: address.port }); });
process.on('SIGTERM', () => { for (const { response } of waiting) response.destroy(); server.close(() => { database.close(); process.exit(0); }); });
