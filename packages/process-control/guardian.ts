/** A separate, detached group leader keeps ownership verifiable during TERM grace. */
export const guardianSource = String.raw`
const { spawn, spawnSync } = require('node:child_process');
let target, started = false, exiting = false;
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
    if (!membersRemain()) { clearInterval(timer); process.exit(0); }
  }, 25);
}
process.on('SIGTERM', () => { if (!started || !target || target.exitCode !== null || target.signalCode !== null) waitForGroup(); });
process.on('disconnect', () => { if (!started) process.exit(0); });
process.on('message', message => {
  if (!message || message.type !== 'start' || started) return;
  started = true;
  target = spawn(message.command, message.args, { cwd: message.cwd, env: message.env, shell: false, stdio: ['pipe', 'inherit', 'inherit'] });
  process.stdin.pipe(target.stdin);
  target.stdin.on('error', () => {});
  target.once('spawn', () => { if (process.connected) process.send({ type: 'started', pid: target.pid }); });
  target.once('error', error => {
    if (process.connected) process.send({ type: 'spawnError', message: error.message });
    waitForGroup();
  });
  target.once('exit', (exitCode, signal) => {
    if (process.connected) process.send({ type: 'result', exitCode, signal });
    waitForGroup();
  });
});
if (process.connected) process.send({ type: 'ready' });
`;
