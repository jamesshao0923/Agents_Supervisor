// Machine verifiers consume only frozen local inputs. Network evidence goes through
// the source verifier, which records URL, bytes, freshness and content digest.
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
const denied=():never=>{throw new Error('Network is not a declared command-verifier input; use a source verifier');};
net.Socket.prototype.connect=denied; net.connect=denied; net.createConnection=denied;
http.request=denied;http.get=denied;https.request=denied;https.get=denied;dgram.createSocket=denied;
globalThis.fetch=denied;globalThis.WebSocket=denied as unknown as typeof WebSocket;
syncBuiltinESMExports();
