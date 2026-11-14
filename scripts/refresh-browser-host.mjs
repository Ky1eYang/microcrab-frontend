// Explicit source refresh only. Runtime binaries are prepared and validated separately.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('npm run resources:refresh -- --ref <40-character-core-commit> [--write]');
  console.log('Fetch the fixed browser Host source/test allowlist from GitHub HTTPS. Without --write, validate and report only.');
  process.exit(0);
}
let revision;
let apply = false;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--write' && !apply) apply = true;
  else if (args[index] === '--ref' && !revision) revision = args[++index];
  else throw new Error(`Unknown or repeated argument: ${args[index]}`);
}
if (!/^[a-f0-9]{40}$/.test(revision ?? '')) {
  throw new Error('--ref requires a full lowercase 40-character commit from Ky1eYang/microcrab-core; the original snapshot commit is not a verified core commit');
}
const root = new URL('../', import.meta.url);
const metadataUrl = new URL('browser-host.sources.json', root);
const metadata = JSON.parse(await readFile(metadataUrl, 'utf8'));
if (metadata.schema !== 1 || metadata.repository !== 'https://github.com/Ky1eYang/microcrab-core'
    || metadata.sourceDirectory !== 'crates/host/frontend/browser') {
  throw new Error('browser-host.sources.json must identify schema 1 and the canonical core browser Host source directory');
}
const sourceDirectory = metadata.sourceDirectory;
const base = `https://raw.githubusercontent.com/Ky1eYang/microcrab-core/${revision}/${sourceDirectory}/`;
const names = [
  'capture.mjs', 'capture.test.mjs', 'descriptor.test.mjs', 'execution-worker.mjs',
  'lifecycle.test.mjs', 'mutation-receipts.test.mjs', 'mutations.mjs', 'mutations.test.mjs',
  'network-diagnostics.mjs', 'network-diagnostics.test.mjs', 'network.mjs', 'network.test.mjs',
  'realm.html', 'receipts.mjs', 'receipts.test.mjs', 'shell.test.mjs',
  'supervisor.mjs', 'worker.test.mjs', 'workspace.mjs',
];
const staged = [];
for (const name of names) {
  const url = new URL(name, base);
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) throw new Error(`Unexpected source size: ${name}: ${bytes.length}`);
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  staged.push({ name, bytes, sha256 });
  console.log(`${name} ${sha256} ${bytes.length}`);
}
// All remote files must succeed before the first local source replacement.
// This is an explicit source update, not a multi-file filesystem transaction.
if (apply) {
  for (const item of staged) await writeFile(new URL(`${sourceDirectory}/${item.name}`, root), item.bytes);
  metadata.upstreamCommit = revision;
  metadata.files = staged.map(({ name, sha256, bytes }) => ({ path: name, sha256, size: bytes.length }));
  await writeFile(metadataUrl, JSON.stringify(metadata, null, 2) + '\n');
  console.log(`Updated ${staged.length} sources in ${fileURLToPath(new URL(sourceDirectory, root))}`);
} else {
  console.log(`Validated ${staged.length} source downloads; pass --write to replace the local snapshot.`);
}
