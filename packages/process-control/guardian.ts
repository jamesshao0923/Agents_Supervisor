/** A separate, detached group leader keeps ownership verifiable during TERM grace. */
export const guardianSource = String.raw`
const { spawn, spawnSync } = require('node:child_process');
let target, started = false, exiting = false, outputsDrained = true, resultSent = true;
function send(message, callback) {
  if (process.connected) process.send(message, error => { if (callback) callback(error); });
  else if (callback) callback();
}
function relay(source, destination) {
  return new Promise(resolve => {
    let ended = false, settled = false, failed = false;
    const finish = () => { if (!settled) { settled = true; resolve(!failed); } };
    const disconnected = () => {
      failed = true;
      source.unpipe(destination);
      // An intentionally detached controller must not kill a surviving writer.
      // Consume its bytes without retaining an unbounded queue.
      source.resume();
      if (ended) finish();
    };
    destination.on('error', disconnected);
    destination.on('close', disconnected);
    source.once('error', () => { failed = true; finish(); });
    source.once('end', () => {
      ended = true;
      if (destination.destroyed || failed) return finish();
      // A zero-byte write callback is ordered behind every forwarded chunk.
      // Target exit alone does not prove those queued chunks reached the pipe.
      destination.write(Buffer.alloc(0), error => { if (error) failed = true; finish(); });
    });
    source.once('close', () => { if (!ended) { failed = true; finish(); } });
    source.pipe(destination, { end: false });
  });
}
function membersRemain() {
  try {
    const scan = spawnSync('/bin/ps', ['-ax', '-o', 'pid=', '-o', 'pgid=', '-o', 'stat='], { encoding: 'utf8' });
    if (scan.status !== 0) return true;
    const rows = scan.stdout;
    return rows.split('\n').some(row => {
      const [pid, group, state] = row.trim().split(/\s+/);
      return Number(group) === process.pid && Number(pid) !== process.pid && Number(pid) !== scan.pid && state && !state.startsWith('Z');
    });
  } catch { return true; }
}
function waitForGroup() {
  if (exiting) return;
  exiting = true;
  const timer = setInterval(() => {
    if (outputsDrained && resultSent && !membersRemain()) { clearInterval(timer); process.exit(0); }
  }, 25);
}
process.on('SIGTERM', () => { if (!started || !target || target.exitCode !== null || target.signalCode !== null) waitForGroup(); });
process.on('disconnect', () => { if (!started) process.exit(0); });
process.on('message', message => {
  if (!message || message.type !== 'start' || started) return;
  started = true;
  outputsDrained = false;
  resultSent = false;
  // Native writers receive their own blocking pipe descriptors. Inheriting a
  // Node stdout descriptor can expose O_NONBLOCK and fail native writes EAGAIN.
  target = spawn(message.command, message.args, { cwd: message.cwd, env: message.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const outputs = Promise.all([relay(target.stdout, process.stdout), relay(target.stderr, process.stderr)]);
  process.stdin.pipe(target.stdin);
  target.stdin.on('error', () => {});
  target.once('spawn', () => { send({ type: 'started', pid: target.pid }); });
  target.once('error', error => {
    send({ type: 'spawnError', message: error.message });
    outputs.then(() => { outputsDrained = true; resultSent = true; });
    waitForGroup();
  });
  target.once('exit', (exitCode, signal) => {
    // Descendants can retain the target's output descriptors. Let the fenced
    // controller stop them before waiting for EOF; keep this relay alive.
    send({ type: 'target-exit', exitCode, signal });
    outputs.then(success => {
      outputsDrained = true;
      send({ type: success.every(Boolean) ? 'result' : 'transportError', exitCode, signal }, () => { resultSent = true; });
    });
    waitForGroup();
  });
});
send({ type: 'ready' });
`;
