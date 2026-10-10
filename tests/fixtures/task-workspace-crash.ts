import {readFileSync} from 'node:fs';
import {HostTaskWorkspaceManager,type WorkspaceRequest} from '../../packages/workspace/task-workspace.js';
const input=JSON.parse(readFileSync(process.argv[2]!,'utf8')) as {data:string;request:WorkspaceRequest};
await new HostTaskWorkspaceManager(input.data).create(input.request);
