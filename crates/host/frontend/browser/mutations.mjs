// Conditional ordinary-file operations. The workspace lease and serial lane
// protect cooperating writers; each IDB transaction acknowledges its own commit.
import { pathOf, digest, fault, MAX_WORKSPACE_BYTES } from './workspace.mjs';
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const LIMIT = 1048576;
const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(fault(req.error?.name === 'QuotaExceededError' ? 'limit' : 'io', `Browser mutation storage request failed: ${req.error?.name ?? 'UnknownError'}`)); });
const complete = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(fault(tx.error?.name === 'QuotaExceededError' ? 'limit' : 'io', `Browser mutation storage transaction aborted before commit: ${tx.error?.name ?? 'AbortError'}`)); });
function ordinary(path) {
  path = pathOf(path);
  if (path === '/workspace' || path.split('/').some(part => part === '.microcrab' || part === '.micro-crab' || part === '.git')) throw fault('denied', 'Mutation targets a protected workspace path');
  return path;
}
function version(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw fault('invalid_request', 'Mutation expected_version requires a lowercase SHA256 digest'); }
function shape(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1) throw fault('invalid_request', 'Mutation requires exactly one write, delete or move variant');
  const kind = Object.keys(input)[0], r = input[kind];
  const fields = kind === 'write' ? ['path', 'content', 'precondition'] : kind === 'delete' ? ['path', 'expected_version'] : kind === 'move' ? ['path', 'destination', 'expected_version', 'content'] : null;
  if (!fields || !r || typeof r !== 'object' || Object.keys(r).length !== fields.length || Object.keys(r).some(key => !fields.includes(key))) throw fault('invalid_request', 'Mutation has unknown or missing fields');
  const value = { ...r, path: ordinary(r.path) };
  if (kind === 'move') value.destination = ordinary(r.destination);
  if (kind === 'write') {
    if (r.precondition !== 'missing') {
      if (!r.precondition || typeof r.precondition !== 'object' || Object.keys(r.precondition).length !== 1 || !Object.hasOwn(r.precondition, 'version')) throw fault('invalid_request', 'Write requires missing or a version precondition');
      version(r.precondition.version);
    }
  } else version(r.expected_version);
  if (kind !== 'delete' && (typeof r.content !== 'string' || r.content.includes('\0') || encoder.encode(r.content).byteLength > LIMIT)) throw fault('limit', 'Mutation content exceeds 1048576 UTF-8 bytes or contains NUL');
  return { [kind]: value };
}
function parts(input) { const kind = Object.keys(input)[0]; return [kind, input[kind]]; }
function sourceCheck(file, expected, path) {
  if (!file || file.kind !== 'file') throw fault('conflict', `${path}: mutation source is missing or is not an ordinary file`);
  if (file.version !== expected) throw fault('conflict', `${path}: mutation source version changed`);
  if (file.data.byteLength > LIMIT) throw fault('limit', `${path}: mutation source exceeds 1048576 bytes`);
  let text;
  try { text = decoder.decode(file.data); } catch { throw fault('invalid_request', `${path}: mutation source is not UTF-8 text`); }
  if ((text.match(/\n/g)?.length ?? 0) + (text && !text.endsWith('\n') ? 1 : 0) > 10000) throw fault('limit', `${path}: mutation source exceeds 10000 lines`);
  return file;
}
function parentCheck(files, path) {
  const parent = path.slice(0, path.lastIndexOf('/'));
  if (parent !== '/workspace' && files.get(parent)?.kind !== 'directory') throw fault('invalid_request', `${path}: mutation parent directory is missing; create it explicitly before applying the patch`);
  const segments = path.split('/');
  for (let index = 2; index < segments.length - 1; index++) if (files.get(segments.slice(0, index + 1).join('/'))?.kind !== 'directory') throw fault('denied', 'Mutation parent is not a directory');
}
function validate(normalized, files, state) {
  const touched = [], original = new Map(files);
  let sourceBytes = 0, resultBytes = 0, bytes = state.bytes ?? 0, count = state.count ?? 0;
  for (const input of normalized) {
    const [kind, r] = parts(input), paths = kind === 'move' ? [r.path, r.destination] : [r.path];
    for (const path of paths) {
      if (touched.some(previous => previous === path || previous.startsWith(path + '/') || path.startsWith(previous + '/'))) throw fault('invalid_request', 'Mutation paths alias, collide or overlap');
      touched.push(path); parentCheck(original, path);
    }
    const source = original.get(r.path);
    if (kind === 'write' && r.precondition === 'missing') {
      if (source) throw fault('conflict', 'Mutation destination must be missing');
    } else {
      sourceCheck(source, kind === 'write' ? r.precondition.version : r.expected_version, r.path);
      sourceBytes += source.data.byteLength;
    }
    if (kind === 'move' && original.has(r.destination)) throw fault('conflict', 'Move destination must be missing');
    const contentBytes = kind === 'delete' ? 0 : encoder.encode(r.content).byteLength;
    resultBytes += contentBytes;
    bytes += contentBytes - (source?.data.byteLength ?? 0);
    count += kind === 'delete' ? -1 : source ? 0 : 1;
    if (bytes > MAX_WORKSPACE_BYTES || count > 4096) throw fault('limit', 'Mutation would exceed browser workspace quota');
  }
  if (sourceBytes > 4194304 || resultBytes > 4194304) throw fault('limit', 'Aggregate mutation sources/results exceed 4194304 bytes');
}

export async function preflightMutations(workspace, requests) {
  if (!Array.isArray(requests) || !requests.length || requests.length > 32) throw fault('invalid_request', 'Mutation preflight requires 1..=32 operations');
  const normalized = requests.map(shape);
  // Earlier closed writes must settle before the observed preflight snapshot.
  await workspace.serial;
  const rows = await workspace.files(), files = new Map(rows.map(row => [row.path, row]));
  validate(normalized, files, { bytes: rows.reduce((sum, row) => sum + row.data.byteLength, 0), count: rows.length });
  return normalized;
}
export async function mutate(workspace, input, signal, receipt = null) {
  const normalized = shape(input), [kind, r] = parts(normalized);
  const data = kind === 'delete' ? null : encoder.encode(r.content);
  const hash = data ? await digest(data) : null;
  const output = { version: hash, bytes: data?.byteLength ?? 0, source_removed: kind !== 'write', destination_written: kind !== 'delete', diagnostic: null };
  const publish = async () => {
    if (signal?.aborted) throw signal.reason ?? fault('cancelled', 'Mutation cancelled before commit');
    const tx = workspace.db.transaction(receipt ? ['files', 'meta', 'receipts'] : ['files', 'meta'], 'readwrite'), done = complete(tx);
    const files = tx.objectStore('files'), meta = tx.objectStore('meta');
    try {
      const rows = await request(files.getAll(workspace.range(), 4097));
      if (rows.length > 4096) throw fault('limit', 'Browser workspace exceeds file capacity');
      const state = await request(meta.get(workspace.namespace)) ?? { namespace: workspace.namespace, bytes: 0, count: 0 };
      const map = new Map(rows.map(row => [row.path, row])); validate([normalized], map, state);
      if (signal?.aborted) throw signal.reason ?? fault('cancelled', 'Mutation cancelled before commit');
      const old = map.get(r.path);
      state.bytes += (data?.byteLength ?? 0) - (old?.data.byteLength ?? 0);
      state.count += kind === 'delete' ? -1 : old ? 0 : 1;
      if (receipt) await workspace.stageReceipt(tx, state, { ...receipt, state: { state: 'completed', result: { Ok: output } } });
      if (signal?.aborted) throw signal.reason ?? fault('cancelled', 'Mutation cancelled before commit');
      if (kind !== 'write') files.delete([workspace.namespace, r.path]);
      if (data) files.put({ namespace: workspace.namespace, path: kind === 'move' ? r.destination : r.path, data, version: hash, kind: 'file' });
      meta.put(state);
      // Await transaction completion without racing a cancellation signal. For
      // move/update the destination and removal share this one IDB transaction.
      await done;
      return output;
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {}); throw error;
    }
  };
  const pending = (workspace.serial ?? Promise.resolve()).then(publish);
  workspace.serial = pending.catch(() => {}); return pending;
}
