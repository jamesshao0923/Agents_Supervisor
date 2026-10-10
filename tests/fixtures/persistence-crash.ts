import { SupervisorStore } from '../../packages/persistence/store.js';
import type { Command } from '../../packages/contracts/p1.js';
import { writeSync } from 'node:fs';

const directory = process.argv[2]!;
const faultPoint = process.argv[3]!;
const command = JSON.parse(process.argv[4]!) as Command;
const barrier = new Int32Array(new SharedArrayBuffer(4));
const store = new SupervisorStore(directory, {
  fault(point) {
    if (point === faultPoint) {
      // A synchronous pipe write acknowledges the exact boundary before this real
      // writer blocks. It cannot run COMMIT until parent terminates the process.
      writeSync(1, `${JSON.stringify({ point })}\n`);
      Atomics.wait(barrier, 0, 0);
    }
  },
});
try {
  const result = store.command(command);
  process.stdout.write(`${JSON.stringify({ result })}\n`);
  store.close();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  store.close();
  process.exitCode = 1;
}
