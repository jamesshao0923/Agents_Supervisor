import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import type { Request, Response } from '../../packages/contracts/p1.js';

export function request(dataDir: string, value: Request): Promise<Response> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(join(resolve(dataDir), 'supervisor.sock'));
    let result = Buffer.alloc(0);
    let completed = false;
    socket.setTimeout(30_000, () => socket.destroy(new Error('Supervisor request timed out; query or retry the same commandId to reconcile')));
    socket.once('connect', () => socket.end(JSON.stringify(value) + '\n'));
    socket.once('error', reject);
    socket.on('data', chunk => {
      result = Buffer.concat([result, chunk]);
      if (result.length > 16 * 1024 * 1024) socket.destroy(new Error('Response too large'));
    });
    socket.once('end', () => {
      try {
        const response = JSON.parse(result.toString('utf8')) as Response;
        if (response.id !== value.id || typeof response.ok !== 'boolean') throw new Error('Malformed or mismatched Supervisor response');
        completed = true;
        resolvePromise(response);
      } catch (error) { reject(error); }
    });
    socket.once('close', () => { if (!completed) reject(new Error('Connection closed without a complete response; reconcile commandId before retry')); });
  });
}
