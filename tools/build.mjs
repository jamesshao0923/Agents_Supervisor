import { rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.versions.node !== '24.20.0') {
  console.error('Supervisor pins Node 24.20.0; select the version in .nvmrc before building.');
  process.exit(1);
}
rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true });
const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], {
  cwd: root, stdio: 'inherit', shell: false,
});
if (result.error) console.error(result.error.message);
if (result.status !== 0) process.exit(result.status ?? 1);
const desktop = new URL('../dist/apps/desktop/', import.meta.url);
mkdirSync(desktop, { recursive: true });
for (const file of ['main.cjs', 'preload.cjs', 'index.html', 'styles.css']) {
  copyFileSync(new URL(`../apps/desktop/${file}`, import.meta.url), new URL(file, desktop));
}
await build({ entryPoints: [fileURLToPath(new URL('../apps/desktop/renderer.tsx', import.meta.url))], outfile: fileURLToPath(new URL('renderer.js', desktop)), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', sourcemap: true, define: { 'process.env.NODE_ENV': '"production"' } });

const verificationUi = new URL('../dist/apps/verification-ui/', import.meta.url);
mkdirSync(verificationUi, {recursive:true});
copyFileSync(new URL('../apps/verification-ui/main.cjs',import.meta.url),new URL('main.cjs',verificationUi));
