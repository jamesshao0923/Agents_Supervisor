import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const p4CorrectSource = 'export function discountedPrice(amount:number,percent:number):number { if(!Number.isFinite(amount)||!Number.isFinite(percent)||amount<0||percent<0||percent>100)throw new RangeError("Invalid discount input"); return amount*(1-percent/100); }\n';
export const p4BrokenSource = 'export function discountedPrice(amount:number,percent:number):number { return amount*percent; }\n';
export const p4SourceUrl = 'https://www.rfc-editor.org/rfc/rfc9110.txt';
export const p4SourceExcerpt = 'OPTIONS, and TRACE methods are defined to be safe.';
export const p4CorrectClaim = 'RFC 9110 section 9.2.1 defines GET, HEAD, OPTIONS and TRACE as safe methods. Safe describes their requested read-only semantics; it does not prohibit incidental server logging.\n';
export const p4BrokenClaim = 'RFC 9110 section 9.2.1 says DELETE is a safe read-only method and GET is unsafe. Therefore GET always modifies origin resources and DELETE never does.\n';

export async function writeP4Project(workspace: string, broken = false): Promise<void> {
  await mkdir(join(workspace, 'src'), { recursive: true });
  await writeFile(join(workspace, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(workspace, 'src/price.ts'), broken ? p4BrokenSource : p4CorrectSource);
  await execute(process.execPath, [resolve('node_modules/typescript/bin/tsc'), 'src/price.ts', '--target', 'es2022', '--module', 'nodenext', '--strict', '--outDir', 'build', '--types', 'node', '--typeRoots', resolve('node_modules/@types')], { cwd: workspace, timeout: 15_000 });
  await writeFile(join(workspace, 'claim.txt'), broken ? p4BrokenClaim : p4CorrectClaim);
  await writeFile(join(workspace, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Discount calculator</title>
<style>body{font:20px system-ui;background:#f5f7fa;color:#192c3e;padding:60px;max-width:760px;margin:auto}h1{font-size:38px}label{display:block;margin:24px 0 6px}input,button{font:inherit;padding:12px;border:2px solid #57697a;border-radius:5px}button{display:block;margin:28px 0;background:#1645a0;color:white;border:0;cursor:pointer}#result{display:block;padding:18px;background:white;border:2px solid #57697a;min-height:28px}</style>
</head><body><h1>Discount calculator</h1><p>Enter an amount and a percentage from 0 to 100.</p>
<label for="amount">Amount</label><input id="amount" type="text" inputmode="decimal" value="200">
<label for="percent">Discount percent</label><input id="percent" type="text" inputmode="decimal" value="25">
<button id="calculate" type="button">Calculate price</button><output id="result" aria-live="polite">Ready to calculate</output>
<script type="module">import {discountedPrice} from './build/price.js';document.querySelector('#calculate').addEventListener('click',()=>{const result=document.querySelector('#result');try{result.textContent=discountedPrice(Number(document.querySelector('#amount').value),Number(document.querySelector('#percent').value)).toFixed(2);}catch(error){result.textContent=error instanceof RangeError?'Invalid discount input':'Unexpected calculation error';}});</script>
</body></html>\n`);
}
