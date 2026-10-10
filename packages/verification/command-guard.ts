// Machine verifiers consume only frozen local inputs. Network evidence goes through
// the source verifier, which records URL, bytes, freshness and content digest.
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
const denied=():never=>{throw new Error('Network is not a declared command-verifier input; use a source verifier');};
net.Socket.prototype.connect=denied; net.connect=denied; net.createConnection=denied;
net.Server.prototype.listen=denied;
http.request=denied;http.get=denied;https.request=denied;https.get=denied;dgram.createSocket=denied;
globalThis.fetch=denied;globalThis.WebSocket=denied as unknown as typeof WebSocket;
for(const target of [dns,dns.promises,dns.Resolver.prototype,dns.promises.Resolver.prototype])for(const key of Object.getOwnPropertyNames(target))if(key==='lookup'||key==='lookupService'||key==='reverse'||key.startsWith('resolve'))Object.defineProperty(target,key,{value:denied,writable:false,configurable:false});
syncBuiltinESMExports();
