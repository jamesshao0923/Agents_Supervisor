import http from 'node:http';
import net from 'node:net';
import https from 'node:https';
import dgram from 'node:dgram';
import {syncBuiltinESMExports} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

// Fixed host ABI, declared in the admitted application contract. This launcher
// runs an actual application and SQLite database, not a simulated API.
const [entry,databasePath,readyPath,nonce]=process.argv.slice(2);
if(!entry||!databasePath||!readyPath||!nonce)throw Error('Missing application host arguments');
const denied=():never=>{throw Error('Outbound network is not part of this local application verification');};
net.Socket.prototype.connect=denied;net.connect=denied;net.createConnection=denied;
http.request=denied;http.get=denied;https.request=denied;https.get=denied;dgram.createSocket=denied;
globalThis.fetch=denied;globalThis.WebSocket=denied as unknown as typeof WebSocket;
const listen=net.Server.prototype.listen;
// Only the trusted host invokes the saved listen method. The application
// returns its unlistened HTTP server and cannot choose an external interface.
net.Server.prototype.listen=denied;
syncBuiltinESMExports();
const application=await import(pathToFileURL(entry).href);
if(typeof application.createApplication!=='function')throw Error('Expected createApplication({databasePath})');
const server=await application.createApplication({databasePath});
if(!(server instanceof http.Server)||server.listening)throw Error('Application must return an unlistened HTTP Server');
await new Promise<void>((resolve,reject)=>{server.once('error',reject);listen.call(server,{host:'127.0.0.1',port:0},resolve);});
const address=server.address();if(!address||typeof address==='string'||address.address!=='127.0.0.1')throw Error('Unexpected listener');
await writeFile(readyPath,JSON.stringify({schemaVersion:1,pid:process.pid,nonce,origin:'http://127.0.0.1:'+address.port,databasePath}),{flag:'wx',mode:0o600});
let closing=false;
const close=()=>{if(closing)return;closing=true;server.closeAllConnections();server.close(()=>{process.exitCode=0;});};
process.once('SIGTERM',close);process.once('SIGINT',close);
