import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, nowMs, readBody, touchRepo, viewer, type GitObject, type ObjectType, type Repo } from './store.ts';

export const ZERO_OID = '0'.repeat(40);
const TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_CODES = { commit: 1, tree: 2, blob: 3, tag: 4 };
export function objectId(type: ObjectType, data: Buffer): string { return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex'); }
export function putObject(repo: Repo, type: ObjectType, data: Buffer): string { const oid = objectId(type, data); repo.objects.set(oid, { type, data }); return oid; }
export interface TreeEntry { mode: string; name: string; oid: string }
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (let p = 0; p < data.length;) {
    const space = data.indexOf(32, p), nul = data.indexOf(0, space + 1);
    if (space < p || nul < space || nul + 21 > data.length) throw new Error('Malformed tree');
    entries.push({ mode: data.toString('ascii', p, space), name: data.toString('utf8', space + 1, nul), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    p = nul + 21;
  }
  return entries;
}
export function isDirectory(mode: string): boolean { return mode === '40000' || mode === '040000'; }
export function writeTree(entries: TreeEntry[]): Buffer {
  return Buffer.concat([...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name + (isDirectory(a.mode) ? '/' : '')), Buffer.from(b.name + (isDirectory(b.mode) ? '/' : '')))).map(e => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.oid, 'hex')])));
}
export function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string; timestamp: number } {
  const text = data.toString(), split = text.indexOf('\n\n'), header = split < 0 ? text : text.slice(0, split);
  return { tree: /^tree ([0-9a-f]{40})$/m.exec(header)?.[1] ?? '', parents: [...header.matchAll(/^parent ([0-9a-f]{40})$/gm)].map(m => m[1]), message: split < 0 ? '' : text.slice(split + 2), timestamp: Number(/^committer .* (\d+) [+-]\d{4}$/m.exec(header)?.[1] ?? 0) };
}
export function createCommit(repo: Repo, tree: string, parents: string[], message: string): string {
  const identity = `${viewer.name} <${viewer.email}> ${Math.floor(nowMs() / 1000)} +0000`;
  return putObject(repo, 'commit', Buffer.from(`tree ${tree}\n${parents.map(p => `parent ${p}\n`).join('')}author ${identity}\ncommitter ${identity}\n\n${message}\n`));
}
export function peel(repo: Repo, oid: string): string {
  const seen = new Set<string>();
  while (!seen.has(oid)) { seen.add(oid); const obj = repo.objects.get(oid); if (obj?.type !== 'tag') break; oid = /^object ([0-9a-f]{40})/m.exec(obj.data.toString())?.[1] ?? oid; }
  return oid;
}
export function resolveRef(repo: Repo, ref = repo.defaultBranch): string | undefined {
  return ref === 'HEAD' ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`) ?? (repo.objects.has(ref) ? ref : undefined);
}
export interface FileEntry { oid: string; mode: string }
export function flattenTree(repo: Repo, oid?: string): Map<string, FileEntry> {
  const files = new Map<string, FileEntry>();
  const walk = (id: string, prefix: string, ancestors: Set<string>): void => {
    if (ancestors.has(id)) throw new Error('Cyclic tree');
    const obj = repo.objects.get(id); if (!obj || obj.type !== 'tree') throw new Error('Missing tree');
    const next = new Set(ancestors).add(id);
    for (const e of parseTree(obj.data)) { const path = prefix + e.name; if (isDirectory(e.mode)) walk(e.oid, path + '/', next); else files.set(path, { oid: e.oid, mode: e.mode }); }
  };
  if (oid) walk(oid, '', new Set()); return files;
}
export function commitFiles(repo: Repo, oid?: string): Map<string, FileEntry> {
  if (!oid) return new Map();
  const obj = repo.objects.get(peel(repo, oid));
  if (!obj || obj.type !== 'commit') throw new HttpError(422, 'Not a commit');
  return flattenTree(repo, parseCommit(obj.data).tree);
}
export function buildTree(repo: Repo, files: Map<string, FileEntry>): string {
  const build = (prefix: string): string => {
    const entries: TreeEntry[] = [], dirs = new Set<string>();
    for (const [path, file] of files) { if (!path.startsWith(prefix)) continue; const suffix = path.slice(prefix.length), slash = suffix.indexOf('/'); if (slash < 0) entries.push({ name: suffix, mode: file.mode, oid: file.oid }); else dirs.add(suffix.slice(0, slash)); }
    for (const name of dirs) { if (entries.some(e => e.name === name)) throw new HttpError(409, 'File and directory conflict'); entries.push({ mode: '40000', name, oid: build(prefix + name + '/') }); }
    return putObject(repo, 'tree', writeTree(entries));
  };
  return build('');
}
export function isAncestor(objects: ReadonlyMap<string, GitObject>, old: string, tip: string): boolean {
  if (!objects.has(old)) return false;
  const queue = [tip], seen = new Set<string>();
  for (let i = 0; i < queue.length; i++) { const oid = queue[i]; if (oid === old) return true; if (seen.has(oid)) continue; seen.add(oid); const obj = objects.get(oid); if (obj?.type === 'commit') queue.push(...parseCommit(obj.data).parents); }
  return false;
}
export function mergeBase(repo: Repo, a: string, b: string): string | undefined {
  const ancestors = (tip: string): Map<string, number> => { const map = new Map<string, number>(), q: [string, number][] = [[tip, 0]]; for (let i = 0; i < q.length; i++) { const [oid, depth] = q[i]; if (map.has(oid)) continue; map.set(oid, depth); const obj = repo.objects.get(oid); if (obj?.type === 'commit') q.push(...parseCommit(obj.data).parents.map(p => [p, depth + 1] as [string, number])); } return map; };
  const aa = ancestors(a), bb = ancestors(b);
  // Remove common ancestors which themselves precede another common ancestor.
  const common = [...aa.keys()].filter(oid => bb.has(oid));
  const best = common.filter(oid => !common.some(other => other !== oid && isAncestor(repo.objects, oid, other)));
  return best.sort((x, y) => (aa.get(x)! + bb.get(x)!) - (aa.get(y)! + bb.get(y)!) || x.localeCompare(y))[0];
}
export function threeWayMerge(repo: Repo, head: string, base: string): { files: Map<string, FileEntry>; conflicts: string[] } {
  const ancestor = commitFiles(repo, mergeBase(repo, head, base)), h = commitFiles(repo, head), b = commitFiles(repo, base), files = new Map<string, FileEntry>(), conflicts: string[] = [];
  const equal = (x?: FileEntry, y?: FileEntry): boolean => x?.oid === y?.oid && x?.mode === y?.mode;
  for (const path of new Set([...ancestor.keys(), ...h.keys(), ...b.keys()])) {
    const old = ancestor.get(path), ours = b.get(path), theirs = h.get(path);
    let result: FileEntry | undefined;
    if (equal(theirs, old)) result = ours; else if (equal(ours, old) || equal(ours, theirs)) result = theirs; else { conflicts.push(path); continue; }
    if (result) files.set(path, result);
  }
  for (const path of files.keys()) { const parts = path.split('/'); for (let i = 1; i < parts.length; i++) if (files.has(parts.slice(0, i).join('/'))) conflicts.push(path); }
  return { files, conflicts };
}

function deltaVarint(data: Buffer, cursor: { p: number }): number {
  let value = 0, shift = 0, byte: number;
  do { if (cursor.p >= data.length || shift > 49) throw new Error('Bad delta varint'); byte = data[cursor.p++]; value += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128);
  return value;
}
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const c = { p: 0 }, sourceSize = deltaVarint(delta, c), targetSize = deltaVarint(delta, c);
  if (sourceSize !== base.length || targetSize > 128 * 1024 * 1024) throw new Error('Bad delta size');
  const output = Buffer.alloc(targetSize); let p = 0;
  const byte = (): number => { if (c.p >= delta.length) throw new Error('Truncated delta'); return delta[c.p++]; };
  while (c.p < delta.length) {
    const op = byte();
    if (op & 128) {
      let off = 0, size = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) off += byte() * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (1 << (4 + i))) size += byte() * 2 ** (8 * i);
      if (!size) size = 65536;
      if (off + size > base.length || p + size > targetSize) throw new Error('Bad delta copy');
      base.copy(output, p, off, off + size); p += size;
    } else {
      if (!op || c.p + op > delta.length || p + op > targetSize) throw new Error('Bad delta insert');
      delta.copy(output, p, c.p, c.p + op); c.p += op; p += op;
    }
  }
  if (p !== targetSize) throw new Error('Delta target size mismatch'); return output;
}
export function readPack(pack: Buffer, bases: ReadonlyMap<string, GitObject> = new Map()): Map<string, GitObject> {
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK' || ![2, 3].includes(pack.readUInt32BE(4))) throw new Error('Invalid pack header');
  const count = pack.readUInt32BE(8);
  if (count > pack.length) throw new Error('Invalid pack count');
  interface Entry { offset: number; type: number; data: Buffer; baseOffset?: number; baseOid?: string; object?: GitObject }
  const entries: Entry[] = [], offsets = new Map<number, Entry>(), objects = new Map<string, GitObject>(); let p = 12;
  const byte = (): number => { if (p >= pack.length - 20) throw new Error('Truncated pack'); return pack[p++]; };
  const inflate = (start: number): { data: Buffer; length: number } => {
    let lo = 1, hi = pack.length - 20 - start;
    if (hi < 1) throw new Error('Missing zlib stream');
    const options = { maxOutputLength: 128 * 1024 * 1024 };
    inflateSync(pack.subarray(start, start + hi), options);
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); try { inflateSync(pack.subarray(start, start + mid), options); hi = mid; } catch { lo = mid + 1; } }
    return { data: inflateSync(pack.subarray(start, start + lo), options), length: lo };
  };
  for (let i = 0; i < count; i++) {
    const offset = p; let b = byte(), size = b & 15, shift = 4; const type = (b >> 4) & 7;
    while (b & 128) { b = byte(); size += (b & 127) * 2 ** shift; shift += 7; if (shift > 49) throw new Error('Bad pack size'); }
    const entry: Entry = { offset, type, data: Buffer.alloc(0) };
    if (type === 6) { b = byte(); let distance = b & 127; while (b & 128) { b = byte(); distance = (distance + 1) * 128 + (b & 127); } entry.baseOffset = offset - distance; }
    else if (type === 7) { if (p + 20 > pack.length - 20) throw new Error('Truncated delta base'); entry.baseOid = pack.subarray(p, p + 20).toString('hex'); p += 20; }
    else if (!TYPES[type]) throw new Error('Invalid pack object type');
    const stream = inflate(p); p += stream.length; entry.data = stream.data;
    if (size !== entry.data.length) throw new Error('Pack size mismatch');
    if (TYPES[type]) { entry.object = { type: TYPES[type], data: entry.data }; objects.set(objectId(entry.object.type, entry.data), entry.object); }
    entries.push(entry); offsets.set(offset, entry);
  }
  let unresolved = entries.filter(e => !e.object);
  while (unresolved.length) {
    const next: Entry[] = [];
    for (const e of unresolved) {
      const base = e.baseOffset === undefined ? objects.get(e.baseOid!) ?? bases.get(e.baseOid!) : offsets.get(e.baseOffset)?.object;
      if (!base) { next.push(e); continue; }
      e.object = { type: base.type, data: applyDelta(base.data, e.data) }; objects.set(objectId(e.object.type, e.object.data), e.object);
    }
    if (next.length === unresolved.length) throw new Error('Missing delta base'); unresolved = next;
  }
  return objects;
}
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects], header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(list.length, 8);
  const parts = [header];
  for (const obj of list) { let size = obj.data.length, first = (TYPE_CODES[obj.type] << 4) | (size & 15); size = Math.floor(size / 16); const bytes: number[] = [first | (size ? 128 : 0)]; while (size) { const value = size & 127; size = Math.floor(size / 128); bytes.push(value | (size ? 128 : 0)); } parts.push(Buffer.from(bytes), deflateSync(obj.data)); }
  const body = Buffer.concat(parts); return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
export function closure(repo: Repo, roots: string[], stopParents = new Set<string>()): Set<string> {
  const result = new Set<string>(), queue = [...roots];
  for (let i = 0; i < queue.length; i++) {
    const oid = queue[i]; if (result.has(oid)) continue; const obj = repo.objects.get(oid); if (!obj) continue; result.add(oid);
    if (obj.type === 'commit') { const c = parseCommit(obj.data); queue.push(c.tree); if (!stopParents.has(oid)) queue.push(...c.parents); }
    else if (obj.type === 'tree') queue.push(...parseTree(obj.data).filter(e => e.mode !== '160000').map(e => e.oid));
    else if (obj.type === 'tag') { const target = /^object ([0-9a-f]{40})/m.exec(obj.data.toString())?.[1]; if (target) queue.push(target); }
  }
  return result;
}
export function shallowBoundary(repo: Repo, wants: string[], depth: number, since?: number, excluded = new Set<string>()): Set<string> {
  const boundary = new Set<string>(), seen = new Set<string>(), queue: [string, number][] = wants.map(w => [peel(repo, w), 0]);
  for (let i = 0; i < queue.length; i++) {
    const [oid, d] = queue[i]; if (seen.has(oid)) continue; seen.add(oid); const obj = repo.objects.get(oid); if (obj?.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    if (commit.parents.length && (d + 1 >= depth || commit.parents.some(p => excluded.has(p) || (since !== undefined && parseCommit(repo.objects.get(p)?.data ?? Buffer.alloc(0)).timestamp < since)))) boundary.add(oid);
    else queue.push(...commit.parents.map(p => [p, d + 1] as [string, number]));
  }
  return boundary;
}
export function pkt(data: string | Buffer): Buffer {
  const bytes = typeof data === 'string' ? Buffer.from(data) : data;
  if (bytes.length + 4 > 65520) throw new Error('Packet too large');
  return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, '0')), bytes]);
}
const FLUSH = Buffer.from('0000'), DELIM = Buffer.from('0001');
interface Packet { kind: 'data' | 'flush' | 'delim' | 'end'; data: Buffer }
export function parsePackets(body: Buffer, stopAtFlush = false): { packets: Packet[]; offset: number } {
  const packets: Packet[] = []; let p = 0;
  while (p < body.length) {
    if (p + 4 > body.length || !/^[0-9a-fA-F]{4}$/.test(body.toString('ascii', p, p + 4))) throw new HttpError(400, 'Malformed pkt-line');
    const len = parseInt(body.toString('ascii', p, p + 4), 16); p += 4;
    if (len <= 2) { packets.push({ kind: len === 0 ? 'flush' : len === 1 ? 'delim' : 'end', data: Buffer.alloc(0) }); if (len === 0 && stopAtFlush) return { packets, offset: p }; continue; }
    if (len < 4 || len > 65520 || p + len - 4 > body.length) throw new HttpError(400, 'Malformed pkt-line length');
    packets.push({ kind: 'data', data: body.subarray(p, p + len - 4) }); p += len - 4;
  }
  return { packets, offset: p };
}
function sideband(bytes: Buffer): Buffer[] { const packets: Buffer[] = []; for (let p = 0; p < bytes.length; p += 65515) packets.push(pkt(Buffer.concat([Buffer.from([1]), bytes.subarray(p, p + 65515)]))); return packets; }
function sendGit(res: ServerResponse, type: string, body: Buffer): void { res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Length': body.length }); res.end(body); }
function advertisement(repo: Repo, service: string, v2: boolean): Buffer {
  const parts = [pkt(`# service=${service}\n`), FLUSH];
  if (v2 && service === 'git-upload-pack') return Buffer.concat([...parts, ...['version 2','agent=forge/1.0','ls-refs=unborn','fetch=shallow','object-format=sha1'].map(line => pkt(line + '\n')), FLUSH]);
  const headRef = `refs/heads/${repo.defaultBranch}`, head = repo.refs.get(headRef);
  const caps = service === 'git-receive-pack' ? 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0' : `side-band-64k ofs-delta thin-pack no-progress shallow agent=forge/1.0 symref=HEAD:${headRef}`;
  const refs: [string, string][] = repo.refs.size ? [['HEAD', head ?? ZERO_OID], ...[...repo.refs.entries()].sort(([a], [b]) => a.localeCompare(b))] : [['capabilities^{}', ZERO_OID]];
  refs.forEach(([name, oid], i) => parts.push(pkt(`${oid} ${name}${i === 0 ? '\0' + caps : ''}\n`)));
  if (service === 'git-upload-pack') for (const [ref, oid] of repo.refs) if (repo.objects.get(oid)?.type === 'tag') parts.push(pkt(`${peel(repo, oid)} ${ref}^{}\n`));
  return Buffer.concat([...parts, FLUSH]);
}
function lsRefs(repo: Repo, args: string[]): Buffer {
  const prefixes = args.filter(a => a.startsWith('ref-prefix ')).map(a => a.slice(11)), parts: Buffer[] = [], headRef = `refs/heads/${repo.defaultBranch}`;
  const refs: [string, string][] = [['HEAD', repo.refs.get(headRef) ?? ZERO_OID], ...[...repo.refs.entries()].sort(([a], [b]) => a.localeCompare(b))];
  for (const [name, oid] of refs) {
    if (prefixes.length && !prefixes.some(p => name.startsWith(p))) continue;
    const symref = name === 'HEAD' && (args.includes('symrefs') || oid === ZERO_OID && args.includes('unborn')) ? ` symref-target:${headRef}` : '';
    const peeled = args.includes('peel') && repo.objects.get(oid)?.type === 'tag' ? ` peeled:${peel(repo, oid)}` : '';
    parts.push(pkt(`${name === 'HEAD' && oid === ZERO_OID && args.includes('unborn') ? 'unborn' : oid} ${name}${symref}${peeled}\n`));
  }
  return Buffer.concat([...parts, FLUSH]);
}
function fetchResponse(repo: Repo, args: string[], v2: boolean): Buffer {
  const values = (key: string): string[] => args.filter(a => a.startsWith(key + ' ')).map(a => a.slice(key.length + 1).split(' ')[0]);
  const wants = values('want'), haves = values('have'), shallow = values('shallow');
  if (!wants.length || [...wants, ...haves, ...shallow].some(oid => !/^[0-9a-f]{40}$/.test(oid)) || wants.some(oid => !repo.objects.has(oid))) throw new HttpError(400, 'Invalid want/have object');
  const depthText = values('deepen')[0], sinceText = values('deepen-since')[0], deepenNot = values('deepen-not');
  const depth = depthText === undefined ? Infinity : Number(depthText);
  if (depth <= 0 || !Number.isInteger(depth) && depth !== Infinity) throw new HttpError(400, 'Invalid depth');
  const excluded = closure(repo, deepenNot.map(r => resolveRef(repo, r)).filter((r): r is string => !!r));
  const boundary = depthText !== undefined || sinceText !== undefined || deepenNot.length ? shallowBoundary(repo, wants, depth, sinceText === undefined ? undefined : Number(sinceText), excluded) : new Set(shallow);
  const available = closure(repo, haves, new Set(shallow)), wanted = closure(repo, wants, boundary);
  const selected = [...wanted].filter(oid => !available.has(oid));
  const cacheKey = JSON.stringify([wants, haves, shallow, depthText, sinceText, deepenNot]);
  let pack = repo.packCache.get(cacheKey);
  if (!pack) { pack = writePack(selected.map(oid => repo.objects.get(oid)!)); if (repo.packCache.size >= 100) repo.packCache.clear(); repo.packCache.set(cacheKey, pack); }
  const common = haves.filter(oid => repo.objects.has(oid)), parts: Buffer[] = [];
  // Section boundaries are delimiters in protocol v2; the kit accepts these too.
  const separator = DELIM;
  if (v2 && haves.length) parts.push(pkt('acknowledgments\n'), ...(common.length ? common.map(oid => pkt(`ACK ${oid}\n`)) : [pkt('NAK\n')]), separator);
  if (depthText !== undefined || sinceText !== undefined || deepenNot.length) {
    if (v2) parts.push(pkt('shallow-info\n'));
    for (const oid of boundary) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of shallow) if (!boundary.has(oid)) parts.push(pkt(`unshallow ${oid}\n`));
    if (v2) parts.push(separator); else parts.push(FLUSH);
  }
  // A real v0 shallow clone first asks only for boundaries, then sends done in
  // another stateless request. Do not deliver a pack before negotiation ends.
  if (!v2 && !args.includes('done')) {
    if (depthText === undefined && sinceText === undefined && !deepenNot.length) parts.push(pkt(common.length ? `ACK ${common[common.length - 1]}\n` : 'NAK\n'));
    return Buffer.concat(parts);
  }
  if (v2) parts.push(pkt('packfile\n')); else parts.push(pkt(common.length ? `ACK ${common[common.length - 1]}\n` : 'NAK\n'));
  return Buffer.concat([...parts, ...sideband(pack), FLUSH]);
}
async function receivePack(repo: Repo, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req), parsed = parsePackets(body, true);
  if (!parsed.packets.some(p => p.kind === 'flush')) throw new HttpError(400, 'Missing command flush');
  let capabilities = '';
  const commands = parsed.packets.filter(p => p.kind === 'data').map((p, i) => {
    const text = p.data.toString().trimEnd(), nul = text.indexOf('\0'); if (i === 0 && nul >= 0) capabilities = text.slice(nul + 1);
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[^\s\0]+)$/.exec(nul < 0 ? text : text.slice(0, nul));
    if (!m) throw new HttpError(400, 'Invalid push command'); return { old: m[1], new: m[2], ref: m[3] };
  });
  if (!commands.length) throw new HttpError(400, 'No push commands');
  let unpack = 'ok';
  try { if (body.length > parsed.offset) { const staged = readPack(body.subarray(parsed.offset), repo.objects); for (const [oid, object] of staged) repo.objects.set(oid, object); } else if (commands.some(c => c.new !== ZERO_OID)) throw new Error('Missing pack'); }
  catch (e) { unpack = e instanceof Error ? e.message.replace(/[\r\n]/g, ' ') : 'Invalid pack'; }
  const report = [pkt(`unpack ${unpack}\n`)];
  let hadBranch = [...repo.refs.keys()].some(r => r.startsWith('refs/heads/'));
  for (const c of commands) {
    const current = repo.refs.get(c.ref); let reason = '';
    if (unpack !== 'ok') reason = 'unpacker error';
    else if (c.old === ZERO_OID ? current !== undefined : current !== c.old) reason = 'stale ref';
    else if (c.new !== ZERO_OID && !repo.objects.has(c.new)) reason = 'missing object';
    else if (c.new !== ZERO_OID && c.old !== ZERO_OID && !isAncestor(repo.objects, c.old, c.new)) reason = 'non-fast-forward';
    if (reason) report.push(pkt(`ng ${c.ref} ${reason}\n`));
    else { if (c.new === ZERO_OID) repo.refs.delete(c.ref); else { repo.refs.set(c.ref, c.new); if (!hadBranch && c.ref.startsWith('refs/heads/')) { repo.defaultBranch = c.ref.slice(11); hadBranch = true; } } report.push(pkt(`ok ${c.ref}\n`)); }
  }
  touchRepo(repo);
  const stream = Buffer.concat([...report, FLUSH]);
  sendGit(res, 'application/x-git-receive-pack-result', capabilities.split(' ').includes('side-band-64k') ? Buffer.concat([...sideband(stream), FLUSH]) : stream);
}
export async function handleGit(req: IncomingMessage, res: ServerResponse, repo: Repo, suffix: string, url: URL): Promise<void> {
  const v2 = String(req.headers['git-protocol'] ?? '').includes('version=2');
  if (req.method === 'GET' && suffix === 'info/refs') {
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') throw new HttpError(400, 'Invalid git service');
    sendGit(res, `application/x-${service}-advertisement`, advertisement(repo, service, v2)); return;
  }
  if (req.method === 'POST' && suffix === 'git-receive-pack') { await receivePack(repo, req, res); return; }
  if (req.method === 'POST' && suffix === 'git-upload-pack') {
    const parsed = parsePackets(await readBody(req)).packets;
    const lines = parsed.filter(p => p.kind === 'data').map(p => p.data.toString().replace(/\n$/, ''));
    if (!lines.length) throw new HttpError(400, 'Empty git request');
    let args = lines;
    if (v2) {
      const delimiter = parsed.findIndex(p => p.kind === 'delim');
      if (delimiter < 0) throw new HttpError(400, 'Missing command delimiter');
      args = parsed.slice(delimiter + 1).filter(p => p.kind === 'data').map(p => p.data.toString().replace(/\n$/, ''));
      if (lines[0] === 'command=ls-refs') { sendGit(res, 'application/x-git-upload-pack-result', lsRefs(repo, args)); return; }
      if (lines[0] !== 'command=fetch') throw new HttpError(400, 'Unknown git command');
    }
    sendGit(res, 'application/x-git-upload-pack-result', fetchResponse(repo, args, v2)); return;
  }
  throw new HttpError(404, 'Not Found');
}
