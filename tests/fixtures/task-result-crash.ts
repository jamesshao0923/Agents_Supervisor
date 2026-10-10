import {readFileSync} from 'node:fs';
import {materializeResultPackage} from '../../packages/workspace/result-package.js';
// Real process dies after the durable FS seal, before any DB publication.
const input=JSON.parse(readFileSync(process.argv[2]!,'utf8')) as Parameters<typeof materializeResultPackage>[0];
materializeResultPackage(input);
process.kill(process.pid,'SIGKILL');
