import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { calculateProtocolSchemaDigest, PROTOCOL_SCHEMA_FILES, PROTOCOL_VERSION, type JsonObject } from './index.js';

/** Reviewed baseline updates must use the same JSON number normalization as runtime checks. */
export function renderReviewedBaseline(version: string, schemas: JsonObject): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected an exact Codex release version');
  const digest = calculateProtocolSchemaDigest(schemas);
  return `// Generated from codex-cli ${version} app-server generate-json-schema.\n// Only digests are committed; full local vendor schemas are development evidence.\nexport const PROTOCOL_VERSION = ${JSON.stringify(version)};\nexport const PROTOCOL_SCHEMA_DIGEST = ${JSON.stringify(digest)};\nexport const PROTOCOL_SCHEMA_FILES = ${JSON.stringify(PROTOCOL_SCHEMA_FILES, null, 2)} as const;\n`;
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const directory = process.argv[2];
  const version = process.argv[3] ?? PROTOCOL_VERSION;
  if (directory === undefined) throw new Error('Usage: node dist/packages/executor-codex/generate-baseline.js <generated-schema-directory> [reviewed-version]');
  const schemas: JsonObject = {};
  for (const file of PROTOCOL_SCHEMA_FILES) schemas[file] = JSON.parse(await readFile(join(directory, file), 'utf8')) as unknown;
  await writeFile('packages/executor-codex/baseline.ts', renderReviewedBaseline(version, schemas));
}
