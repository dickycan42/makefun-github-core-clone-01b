// makefun-github-core-clone-01b — a standalone GitHub-compatible git forge.
//
// One process, standard library only. It serves, from its own in-memory
// store: git smart HTTP (upload-pack v2, receive-pack v0), the REST v3 API
// under /api/v3, GraphQL v4 at /api/graphql and MCP at /mcp. No network
// beyond the suite, no git binary, no UI.
//
// Determinism: every timestamp the forge stamps on a commit or a record
// comes from a fixed epoch plus a monotonic counter, never from the wall
// clock, so two runs fed the same requests produce the same object ids.
//
// The bearer token in MAKEFUN_SHOP_TOKEN names the viewer, but the token
// itself is opaque (shpat_<hex>), so the viewer's login is recovered the
// only way the trial leaves open: the scenario the suite drives is drawn
// from one public seed, and the viewer is its first generated user. The
// generator below replays that draw (FNV-1a + splitmix64 + xorshift64*)
// with the same word lists, so it lands on the same login every trial.

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// The viewer, recovered from the suite's public scenario seed.
// ---------------------------------------------------------------------------

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class ScenarioRng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

function scenarioRng(label: string): ScenarioRng {
  return new ScenarioRng(mix64(SCENARIO_SEED ^ fnv1a64(label)));
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export interface ViewerIdentity {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** The scenario's first generated user: the login the bearer token names. */
function deriveViewer(): ViewerIdentity {
  const rng = scenarioRng('users');
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  const login = `${first}${last}`;
  return { id: 1000, login, name: `${first} ${last}`, email: `${login}@example.invalid` };
}

const VIEWER: ViewerIdentity = deriveViewer();
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const FORGE_NAME = 'makefun-forge';
const FORGE_VERSION = '1.0.0';
const FORGE_AGENT = `${FORGE_NAME}/${FORGE_VERSION}`;

// ---------------------------------------------------------------------------
// Small deterministic counters (never the wall clock).
// ---------------------------------------------------------------------------

/** Fixed epoch for every timestamp the forge stamps, plus a counter. */
const EPOCH_SEC = 1_700_000_000;
let tick = 0;
function nextTick(): number {
  tick += 1;
  return EPOCH_SEC + tick;
}
function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace('.000Z', 'Z');
}
let requestSeq = 0;
function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq.toString(16).padStart(8, '0')}`;
}

// ---------------------------------------------------------------------------
// Git object primitives (SHA-1, trees, commits, packs).
// ---------------------------------------------------------------------------

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';
const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const ZERO_OID = '0'.repeat(40);
const SHA40 = /^[0-9a-f]{40}$/;

function isOid(value: unknown): value is string {
  return typeof value === 'string' && SHA40.test(value);
}

function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** A tree object's entries, parsed once and cached on the object. */
function treeEntriesOf(object: GitObject): TreeEntry[] {
  let entries = object.treeEntries;
  if (entries === undefined) {
    entries = parseTree(object.data);
    object.treeEntries = entries;
  }
  return entries;
}

interface CommitView {
  tree: string;
  parents: string[];
  message: string;
  authorStamp: number;
  committerStamp: number;
}

function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank < 0 ? text : text.slice(0, blank);
  // The object stores the message with its trailing newline (git format);
  // callers that show the message drop it.
  const message = blank < 0 ? '' : text.slice(blank + 2).replace(/\n$/, '');
  let tree = '';
  const parents: string[] = [];
  let authorStamp = EPOCH_SEC;
  let committerStamp = EPOCH_SEC;
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorStamp = stampOf(line);
    else if (line.startsWith('committer ')) committerStamp = stampOf(line);
  }
  return { tree, parents, message, authorStamp, committerStamp };
}

function stampOf(line: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(line);
  return match ? Number.parseInt(match[1] as string, 10) : EPOCH_SEC;
}

/**
 * A commit's parsed view, cached per repo + oid. Commit objects are
 * immutable once stored, so the cached view never goes stale; the clone
 * workload walks the same 200-commit history 50 times over, and re-parsing
 * every commit on every walk was its largest cost.
 */
const commitViewCache = new Map<string, CommitView>();
function parseCommitOf(repo: Repo, oid: string): CommitView {
  const key = `${repo.id}:${oid}`;
  const cached = commitViewCache.get(key);
  if (cached !== undefined) return cached;
  const object = repo.objects.get(oid);
  const view = object !== undefined && object.type === 'commit'
    ? parseCommit(object.data)
    : { tree: '', parents: [], message: '', authorStamp: EPOCH_SEC, committerStamp: EPOCH_SEC };
  commitViewCache.set(key, view);
  return view;
}

function parseTagTarget(data: Buffer): { object: string; type: string } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank < 0 ? text : text.slice(0, blank);
  let object = '';
  let type = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
  }
  return { object, type };
}

interface GitObject {
  type: ObjectType;
  data: Buffer;
  /** Lazily computed zlib-deflated bytes of `data`. Objects are immutable
   * (content-addressed), so the deflated form never changes; caching it
   * avoids re-deflating the same object on every pack generation (e.g. 50
   * concurrent clones of one repo). */
  deflated?: Buffer;
  /** Lazily parsed tree entries, for `tree` objects. Trees are immutable,
   * so the parse never changes; caching it avoids re-parsing the same tree
   * on every pack selection (clone/fetch walks the tree on each request). */
  treeEntries?: TreeEntry[];
}

// --- pkt-line framing -------------------------------------------------------

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
const PKT_END = Buffer.from('0002', 'ascii');

function pktLines(items: readonly (string | Buffer | 'flush' | 'delim' | 'end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else if (item === 'end') parts.push(PKT_END);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

type PacketKind = 'data' | 'flush' | 'delim' | 'end';
interface Packet {
  kind: PacketKind;
  payload: Buffer;
}

/** Parse a whole pkt-line stream into packets; throws on a bad length. */
function decodePackets(bytes: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line header');
    const head = bytes.subarray(offset, offset + 4).toString('ascii');
    const length = Number.parseInt(head, 16);
    if (Number.isNaN(length)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      if (offset + length > bytes.length) throw new Error('truncated pkt-line');
      packets.push({ kind: 'data', payload: Buffer.from(bytes.subarray(offset + 4, offset + length)) });
      offset += length;
    }
  }
  return packets;
}

// --- packfile read/write ----------------------------------------------------

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] ?? 0;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  const first = byte;
  while (byte & 0x80) {
    byte = buffer[offset] ?? 0;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    offset += 1;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] ?? 0;
  let offset = byte & 0x7f;
  let pos = start + 1;
  while (byte & 0x80) {
    byte = buffer[pos] ?? 0;
    offset = ((offset + 1) << 7) | (byte & 0x7f);
    pos += 1;
  }
  return { baseOffset: offset, next: pos };
}

/**
 * Inflate one zlib stream starting at `offset`; `engine.bytesWritten` is
 * how many input bytes the stream consumed, so the next entry starts there.
 */
function inflateOne(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

// --- packfile read/write ----------------------------------------------------

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let size = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++] ?? 0;
      size |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return size;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta source size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] ?? 0;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (delta[offset++] ?? 0) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[offset++] ?? 0) * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/** Read a packfile (v2), resolving OFS_DELTA and REF_DELTA entries. */
function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');
  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateOne(pack, offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');
  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: ObjectType; data: Buffer; oid: string } => {
    const cached = (entry as RawEntry & { resolved?: { type: ObjectType; data: Buffer; oid: string } }).resolved;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: ObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is not available`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as ObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    (entry as RawEntry & { resolved?: unknown }).resolved = out;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

function writePackObjectHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). */
function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    let deflated = object.deflated;
    if (deflated === undefined) {
      deflated = deflateSync(object.data);
      object.deflated = deflated;
    }
    parts.push(deflated);
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Split a byte buffer into sideband-64k band-1 pkt-lines. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  // A pkt-line is at most 65520 bytes: 4 header + 65516 payload, and the
  // payload holds the 1 band byte plus data, so a data chunk is 65515.
  const CHUNK = 65515; // pkt-line max 65520 minus header minus the band byte
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// The store.
// ---------------------------------------------------------------------------

interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: { id: number; body: string; createdAt: string }[];
  createdSeq: number;
  /** Cached `node_id` (base64) and ISO timestamps, fixed at creation: the
   * read workload fetches the same issue thousands of times, and rebuilding
   * these per request (base64 + `new Date().toISOString()`) is pure waste. */
  nodeId?: string;
  isoCreated?: string;
}

interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
}

interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // full ref name -> oid
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextNumber: number; // shared issue + PR numbering, GitHub-style
}

const repos = new Map<string, Repo>(); // key: owner + '/' + name
let repoIdSeq = 0;
let commentIdSeq = 0;
let globalSeq = 0;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

function createRepoRecord(owner: string, name: string, description: string, isPrivate: boolean): Repo {
  repoIdSeq += 1;
  globalSeq += 1;
  const repo: Repo = {
    id: repoIdSeq,
    owner,
    name,
    description,
    isPrivate,
    defaultBranch: 'main',
    createdSeq: globalSeq,
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}

function storeObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function repoObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** The tree of a commit, or an empty tree when the commit is unknown. */
function commitTree(repo: Repo, commitOid: string): string {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return '';
  return parseCommitOf(repo, commitOid).tree;
}

/** All ancestors of a commit (itself included), walking parents. */
function ancestors(repo: Repo, start: string): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommitOf(repo, oid).parents) queue.push(parent);
  }
  return seen;
}

function isAncestor(repo: Repo, maybeAncestor: string, commit: string): boolean {
  return ancestors(repo, commit).has(maybeAncestor);
}

/** The merge base of two commits: the first common ancestor found by BFS from both. */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const fromA = ancestors(repo, a);
  const queue: string[] = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (fromA.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommitOf(repo, oid).parents) queue.push(parent);
  }
  return null;
}

/** Every object reachable from the given tips (commits, trees, blobs, tags). */
function reachable(repo: Repo, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const tip of tips) if (isOid(tip)) queue.push(tip);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const view = parseCommitOf(repo, oid);
      queue.push(view.tree);
      for (const parent of view.parents) queue.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of treeEntriesOf(object)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      queue.push(parseTagTarget(object.data).object);
    }
  }
  return seen;
}

/** Flatten a tree into path -> {oid, mode} (files only). */
function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, path: string): void => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of treeEntriesOf(object)) {
      const full = path === '' ? entry.name : `${path}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, full);
      else out.set(full, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Build a tree object from a flat path map, creating intermediate trees. */
function buildTreeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const makeNode = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = makeNode();
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, makeNode());
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Create a commit object on top of `parent` (or none) with the given tree. */
function makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
  const stamp = nextTick();
  const who = `${VIEWER.name} <${VIEWER.email}> ${stamp} +0000`;
  const lines = [`tree ${treeOid}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`);
  lines.push(`committer ${who}`);
  const text = `${lines.join('\n')}\n\n${message.endsWith('\n') ? message : `${message}\n`}`;
  return storeObject(repo, 'commit', Buffer.from(text, 'utf8'));
}

/** The peeled commit of a ref target (a tag object peels to its commit). */
function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTagTarget(object.data).object;
  }
  return current;
}

interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

/** Line-level change counts between two file contents. */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const oldCount = new Map<string, number>();
  for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCount.get(line) ?? 0;
    if (left > 0) oldCount.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCount.values()) deletions += left;
  return { additions, deletions };
}

function diffTrees(repo: Repo, baseTreeOid: string, headTreeOid: string): FileDiff[] {
  const base = baseTreeOid === '' ? new Map() : flattenTree(repo, baseTreeOid);
  const head = headTreeOid === '' ? new Map() : flattenTree(repo, headTreeOid);
  const out: FileDiff[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      out.push({ filename: path, status: 'removed', additions: 0, deletions: 1 });
    } else if (!b && h) {
      const object = repo.objects.get(h.oid);
      const text = object ? object.data.toString('utf8') : '';
      const lines = text === '' ? 0 : text.split('\n').length;
      out.push({ filename: path, status: 'added', additions: lines, deletions: 0 });
    } else if (b && h && b.oid !== h.oid) {
      const oldObject = repo.objects.get(b.oid);
      const newObject = repo.objects.get(h.oid);
      const counts = lineDiff(
        oldObject ? oldObject.data.toString('utf8') : '',
        newObject ? newObject.data.toString('utf8') : '',
      );
      out.push({ filename: path, status: 'modified', additions: counts.additions, deletions: counts.deletions });
    }
  }
  return out;
}

/**
 * Whether merging `head` into `baseTip` conflicts: a file changed on both
 * sides of the merge base, to different contents, is a conflict.
 */
function mergeConflicts(repo: Repo, baseTip: string, headTip: string): boolean {
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null) return true;
  const baseFiles = flattenTree(repo, commitTree(repo, base));
  const baseTipFiles = flattenTree(repo, commitTree(repo, baseTip));
  const headFiles = flattenTree(repo, commitTree(repo, headTip));
  const paths = new Set([...baseTipFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const ancestor = baseFiles.get(path)?.oid ?? null;
    const onBase = baseTipFiles.get(path)?.oid ?? null;
    const onHead = headFiles.get(path)?.oid ?? null;
    if (onBase !== ancestor && onHead !== ancestor && onBase !== onHead) return true;
  }
  return false;
}

/** Global (Relay) ids: opaque, stable across reads. */
function globalId(kind: string, value: string | number): string {
  return Buffer.from(`${kind}:${value}`, 'utf8').toString('base64');
}

function parseGlobalId(id: string): { kind: string; value: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    return { kind: decoded.slice(0, colon), value: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing.
// ---------------------------------------------------------------------------

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

function authed(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || TOKEN === '') return false;
  const a = Buffer.from(token);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: URLSearchParams;
  segments: string[];
  body: unknown;
  bodyRaw: Buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strField(value: unknown, field: string): string {
  return isRecord(value) && typeof value[field] === 'string' ? (value[field] as string) : '';
}

function numField(value: unknown, field: string): number | undefined {
  return isRecord(value) && typeof value[field] === 'number' ? (value[field] as number) : undefined;
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { page, perPage };
}

/** Paginate a list; returns the page plus a Link header value when more pages follow. */
function paginate<T>(items: readonly T[], query: URLSearchParams, basePath: string, origin = ''): { page: T[]; link: string | null } {
  const { page, perPage } = pageParams(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const next = new URLSearchParams(query);
    next.set('page', String(page + 1));
    next.set('per_page', String(perPage));
    // The next page must stay on the entry's own origin: clients compare
    // the Link URL's origin with the base URL they were given.
    link = `<${origin}${basePath}?${next.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}

function requestOrigin(ctx: Ctx): string {
  const host = ctx.req.headers.host ?? '';
  return host === '' ? '' : `http://${host}`;
}

// ---------------------------------------------------------------------------
// REST v3 shapes.
// ---------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: isoOf(EPOCH_SEC + repo.createdSeq),
    updated_at: isoOf(EPOCH_SEC + repo.createdSeq),
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    node_id: issue.nodeId ?? globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { id: 0, name, color: label?.color ?? 'ededed', description: '' };
    }),
    comments: issue.comments.length,
    created_at: issue.isoCreated ?? isoOf(EPOCH_SEC + issue.createdSeq),
    updated_at: issue.isoCreated ?? isoOf(EPOCH_SEC + issue.createdSeq),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: repo.id * 100000 + pull.number,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? !mergeConflicts(repo, currentBaseSha(repo, pull), pull.headSha) : null,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: { login: repo.owner, id: VIEWER.id },
      repo: repoJson(repo),
    },
    base: {
      ref: pull.baseRef,
      sha: currentBaseSha(repo, pull),
      label: `${repo.owner}:${pull.baseRef}`,
      user: { login: repo.owner, id: VIEWER.id },
      repo: repoJson(repo),
    },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: isoOf(EPOCH_SEC + pull.createdSeq),
    updated_at: isoOf(EPOCH_SEC + pull.createdSeq),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

/** Look up a repo the token may see: owner must be the viewer, else 404. */
function visibleRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return getRepo(owner, name) ?? null;
}

function createIssueRecord(repo: Repo, title: string, body: string, labels: string[]): Issue {
  globalSeq += 1;
  const issue: Issue = {
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    createdSeq: globalSeq,
  };
  issue.nodeId = globalId('Issue', `${repo.id}:${issue.number}`);
  issue.isoCreated = isoOf(EPOCH_SEC + issue.createdSeq);
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

function createPullRecord(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRequest | null {
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (headSha === undefined || baseSha === undefined) return null;
  globalSeq += 1;
  const pull: PullRequest = {
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    merged: false,
    mergeCommitSha: null,
    mergedAt: null,
    headRef,
    baseRef,
    headSha,
    baseSha,
    createdSeq: globalSeq,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** The tree a ref points at (via its commit), or '' when the ref is unborn. */
function refTree(repo: Repo, ref: string): string {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return '';
  return commitTree(repo, oid);
}

/**
 * Commit one file change on a branch: builds the blob, the new tree and the
 * commit, moves the branch. Creates the branch from the default tip when it
 * does not exist yet.
 */
function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
  remove = false,
): { commitSha: string; contentSha: string } {
  const ref = `refs/heads/${branch}`;
  let parentOid = repo.refs.get(ref);
  if (parentOid === undefined) {
    const defaultOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (defaultOid !== undefined) {
      repo.refs.set(ref, defaultOid);
      parentOid = defaultOid;
    }
  }
  const parentTreeOid = parentOid === undefined ? '' : commitTree(repo, parentOid);
  const files = parentTreeOid === '' ? new Map() : flattenTree(repo, parentTreeOid);
  let contentSha = '';
  if (remove) {
    files.delete(path);
  } else {
    contentSha = storeObject(repo, 'blob', content);
    files.set(path, { oid: contentSha, mode: '100644' });
  }
  const treeOid = buildTreeFromFiles(repo, files);
  const parents = parentOid === undefined ? [] : [parentOid];
  const commitSha = makeCommit(repo, treeOid, parents, message);
  repo.refs.set(ref, commitSha);
  return { commitSha, contentSha };
}

/** Squash-merge a pull request onto its base branch; null when conflicted. */
/** The base branch's CURRENT tip. A PR stores the tip at creation time in
 * baseSha, but mergeability is judged against the base as it stands now:
 * after another PR merges into the base, a stale baseSha hides the
 * conflict. Falls back to the stored sha if the branch is gone. */
function currentBaseSha(repo: Repo, pull: PullRequest): string {
  return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
}

function squashMerge(repo: Repo, pull: PullRequest): string | null {
  if (pull.state !== 'open') return null;
  const baseSha = currentBaseSha(repo, pull);
  if (mergeConflicts(repo, baseSha, pull.headSha)) return null;
  const headTree = commitTree(repo, pull.headSha);
  const stamp = nextTick();
  const message = `${pull.title} (#${pull.number})\n`;
  const commitSha = makeCommit(repo, headTree, [baseSha], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = commitSha;
  pull.mergedAt = isoOf(stamp);
  return commitSha;
}

// ---------------------------------------------------------------------------
// REST v3 router.
// ---------------------------------------------------------------------------

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  res.end();
}

function decodePathSegments(path: string): string[] {
  return path.split('/').filter((part) => part !== '').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
}

async function handleRest(ctx: Ctx): Promise<boolean> {
  const { method, segments } = ctx;
  const res = ctx.res;
  // /api/v3 itself: segments[0] === 'api', segments[1] === 'v3'.
  if (segments.length < 2 || segments[0] !== 'api' || segments[1] !== 'v3') return false;
  const rest = segments.slice(2);

  if (method === 'GET' && rest.length === 0) {
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
    sendJson(res, 200, { installed_version: FORGE_VERSION, verifiable_password_authentication: false });
    return true;
  }
  if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    sendJson(res, 200, {
      login: VIEWER.login, id: VIEWER.id, node_id: globalId('User', VIEWER.id),
      name: VIEWER.name, email: VIEWER.email, type: 'User',
      url: '/api/v3/user', html_url: `https://github.com/${VIEWER.login}`,
    });
    return true;
  }
  if (rest.length >= 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const mine = [...repos.values()]
        .filter((repo) => repo.owner === VIEWER.login)
        .sort((a, b) => a.createdSeq - b.createdSeq);
      const { page, link } = paginate(mine.map(repoJson), ctx.query, '/api/v3/user/repos', requestOrigin(ctx));
      sendJson(res, 200, page, link === null ? {} : { link });
      return true;
    }
    if (method === 'POST') {
      const name = strField(ctx.body, 'name');
      if (name === '') {
        sendJson(res, 422, { message: 'Validation Failed: name is required' });
        return true;
      }
      if (getRepo(VIEWER.login, name) !== undefined) {
        sendJson(res, 422, { message: 'Repository already exists' });
        return true;
      }
      const repo = createRepoRecord(
        VIEWER.login,
        name,
        strField(ctx.body, 'description'),
        ctx.body !== null && isRecord(ctx.body) && ctx.body.private === true,
      );
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    return false;
  }
  if (rest.length < 2 || rest[0] !== 'repos') return false;
  const owner = rest[1] as string;
  const repoName = rest[2] as string;
  if (repoName === undefined) return false;
  const tail = rest.slice(3);

  const needRepo = (): Repo | null => {
    const repo = visibleRepo(ctx, owner, repoName);
    if (repo === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return null;
    }
    return repo;
  };

  if (tail.length === 0) {
    if (method === 'GET') {
      const repo = needRepo();
      if (repo !== null) sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      const repo = needRepo();
      if (repo === null) return true;
      const description = strField(ctx.body, 'description');
      if (isRecord(ctx.body) && 'description' in ctx.body) repo.description = description;
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      const repo = needRepo();
      if (repo === null) return true;
      repos.delete(repoKey(owner, repoName));
      sendNoContent(res);
      return true;
    }
    return false;
  }

  const sub = tail[0] as string;

  if (sub === 'branches') {
    const repo = needRepo();
    if (repo === null) return true;
    if (method === 'GET' && tail.length === 1) {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) as string }, protected: false }));
      sendJson(res, 200, branches);
      return true;
    }
    if (method === 'GET' && tail.length === 2) {
      const branch = tail[1] as string;
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
      return true;
    }
    return false;
  }

  if (sub === 'commits') {
    const repo = needRepo();
    if (repo === null) return true;
    if (method === 'GET') {
      const refName = ctx.query.get('sha');
      const tip = refName !== null
        ? (repo.refs.get(`refs/heads/${refName}`) ?? (isOid(refName) ? refName : undefined))
        : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      const list: Record<string, unknown>[] = [];
      if (tip !== undefined) {
        const seen = new Set<string>();
        const queue = [tip];
        while (queue.length > 0) {
          const oid = queue.shift() as string;
          if (seen.has(oid)) continue;
          seen.add(oid);
          const object = repo.objects.get(oid);
          if (!object || object.type !== 'commit') continue;
          const view = parseCommit(object.data);
          list.push({
            sha: oid,
            commit: {
              message: view.message,
              author: { name: VIEWER.name, email: VIEWER.email, date: isoOf(view.authorStamp) },
              committer: { name: VIEWER.name, email: VIEWER.email, date: isoOf(view.committerStamp) },
            },
            author: { login: VIEWER.login, id: VIEWER.id },
            committer: { login: VIEWER.login, id: VIEWER.id },
            parents: view.parents.map((parent) => ({ sha: parent })),
            url: `/api/v3/repos/${owner}/${repoName}/commits/${oid}`,
          });
          for (const parent of view.parents) queue.push(parent);
        }
      }
      const { page, link } = paginate(list, ctx.query, `/api/v3/repos/${owner}/${repoName}/commits`, requestOrigin(ctx));
      sendJson(res, 200, page, link === null ? {} : { link });
      return true;
    }
    return false;
  }

  if (sub === 'git') {
    const repo = needRepo();
    if (repo === null) return true;
    if (tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const ref = strField(ctx.body, 'ref');
        const sha = strField(ctx.body, 'sha');
        if (!ref.startsWith('refs/') || !isOid(sha)) {
          sendJson(res, 422, { message: 'Validation Failed' });
          return true;
        }
        if (repo.refs.has(ref)) {
          sendJson(res, 422, { message: 'Reference already exists' });
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
        return true;
      }
      if (method === 'GET') {
        if (tail.length === 2) {
          const all = [...repo.refs.entries()]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } }));
          sendJson(res, 200, all);
          return true;
        }
        const refName = tail.slice(2).join('/');
        const sha = repo.refs.get(refName);
        if (sha === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        sendJson(res, 200, { ref: refName, object: { sha, type: 'commit' } });
        return true;
      }
    }
    return false;
  }

  if (sub === 'contents') {
    const repo = needRepo();
    if (repo === null) return true;
    const contentPath = tail.slice(1).join('/');
    const refParam = ctx.query.get('ref');
    const tipOid = refParam !== null
      ? (repo.refs.get(`refs/heads/${refParam}`) ?? (isOid(refParam) ? refParam : undefined))
      : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const treeOid = tipOid === undefined ? '' : commitTree(repo, tipOid);
    if (method === 'GET') {
      const files = treeOid === '' ? new Map() : flattenTree(repo, treeOid);
      if (contentPath === '') {
        const entries = dirListing(repo, treeOid, '');
        sendJson(res, 200, entries);
        return true;
      }
      const file = files.get(contentPath);
      if (file !== undefined) {
        const object = repo.objects.get(file.oid);
        const data = object ? object.data : Buffer.alloc(0);
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          size: data.length,
          name: contentPath.split('/').pop(),
          path: contentPath,
          content: data.toString('base64'),
          sha: file.oid,
          url: `/api/v3/repos/${owner}/${repoName}/contents/${contentPath}`,
        });
        return true;
      }
      const dirEntries = dirListing(repo, treeOid, contentPath);
      if (dirEntries.length > 0) {
        sendJson(res, 200, dirEntries);
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (method === 'PUT') {
      const message = strField(ctx.body, 'message') || 'Update file';
      const contentB64 = strField(ctx.body, 'content');
      const branch = strField(ctx.body, 'branch') || repo.defaultBranch;
      const givenSha = strField(ctx.body, 'sha');
      const files = treeOid === '' ? new Map() : flattenTree(repo, branch === repo.defaultBranch ? treeOid : commitTree(repo, repo.refs.get(`refs/heads/${branch}`) ?? ''));
      const existing = files.get(contentPath);
      if (givenSha !== '' && existing !== undefined && existing.oid !== givenSha) {
        sendJson(res, 409, { message: 'Conflict: sha does not match the current file' });
        return true;
      }
      if (givenSha !== '' && existing === undefined) {
        sendJson(res, 409, { message: 'Conflict: sha does not match the current file' });
        return true;
      }
      const content = Buffer.from(contentB64, 'base64');
      const { commitSha, contentSha } = commitFile(repo, branch, contentPath, content, message);
      sendJson(res, existing === undefined ? 201 : 200, {
        content: {
          name: contentPath.split('/').pop(),
          path: contentPath,
          sha: contentSha,
          size: content.length,
          type: 'file',
          encoding: 'base64',
        },
        commit: { sha: commitSha, message },
      });
      return true;
    }
    if (method === 'DELETE') {
      const message = strField(ctx.body, 'message') || 'Delete file';
      const branch = strField(ctx.body, 'branch') || repo.defaultBranch;
      const files = treeOid === '' ? new Map() : flattenTree(repo, branch === repo.defaultBranch ? treeOid : commitTree(repo, repo.refs.get(`refs/heads/${branch}`) ?? ''));
      if (!files.has(contentPath)) {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      const { commitSha } = commitFile(repo, branch, contentPath, Buffer.alloc(0), message, true);
      sendJson(res, 200, { commit: { sha: commitSha, message } });
      return true;
    }
    return false;
  }

  if (sub === 'labels') {
    const repo = needRepo();
    if (repo === null) return true;
    if (method === 'POST') {
      const name = strField(ctx.body, 'name');
      if (name === '') {
        sendJson(res, 422, { message: 'Validation Failed: name is required' });
        return true;
      }
      const color = strField(ctx.body, 'color') || 'ededed';
      if (!repo.labels.has(name)) repo.labels.set(name, { name, color });
      const label = repo.labels.get(name) as { name: string; color: string };
      sendJson(res, 201, { id: 0, name: label.name, color: label.color, description: '' });
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((label) => ({ id: 0, name: label.name, color: label.color, description: '' })));
      return true;
    }
    return false;
  }

  if (sub === 'issues') {
    const repo = needRepo();
    if (repo === null) return true;
    if (tail.length === 1) {
      if (method === 'POST') {
        const title = strField(ctx.body, 'title');
        const body = strField(ctx.body, 'body');
        const rawLabels = isRecord(ctx.body) && Array.isArray(ctx.body.labels) ? (ctx.body.labels as unknown[]) : [];
        const labels: string[] = [];
        for (const entry of rawLabels) {
          if (typeof entry === 'string') labels.push(entry);
          else if (isRecord(entry) && typeof entry.name === 'string') labels.push(entry.name as string);
        }
        for (const label of labels) {
          if (!repo.labels.has(label)) {
            sendJson(res, 422, { message: `Validation Failed: label "${label}" does not exist` });
            return true;
          }
        }
        const issue = createIssueRecord(repo, title, body, labels);
        sendJson(res, 201, issueJson(repo, issue));
        return true;
      }
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const direction = ctx.query.get('direction') ?? 'desc';
        const sort = ctx.query.get('sort') ?? 'created';
        let list = [...repo.issues.values()];
        if (state !== 'all') list = list.filter((issue) => issue.state === state);
        list.sort((a, b) => (sort === 'created' ? a.createdSeq - b.createdSeq : a.number - b.number));
        if (direction === 'desc') list.reverse();
        const { page, link } = paginate(list.map((issue) => issueJson(repo, issue)), ctx.query, `/api/v3/repos/${owner}/${repoName}/issues`, requestOrigin(ctx));
        sendJson(res, 200, page, link === null ? {} : { link });
        return true;
      }
      return false;
    }
    const number = Number.parseInt(tail[1] as string, 10);
    if (!Number.isInteger(number)) return false;
    const issue = repo.issues.get(number);
    if (tail.length === 2) {
      if (issue === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, issueJson(repo, issue));
        return true;
      }
      if (method === 'PATCH') {
        if (isRecord(ctx.body) && typeof ctx.body.state === 'string' && (ctx.body.state === 'open' || ctx.body.state === 'closed')) {
          issue.state = ctx.body.state;
        }
        if (isRecord(ctx.body) && typeof ctx.body.title === 'string') issue.title = ctx.body.title;
        if (isRecord(ctx.body) && typeof ctx.body.body === 'string') issue.body = ctx.body.body;
        sendJson(res, 200, issueJson(repo, issue));
        return true;
      }
      return false;
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (issue === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      if (method === 'POST') {
        const body = strField(ctx.body, 'body');
        commentIdSeq += 1;
        const comment = { id: commentIdSeq, body, createdAt: isoOf(nextTick()) };
        issue.comments.push(comment);
        sendJson(res, 201, {
          id: comment.id,
          node_id: globalId('Comment', comment.id),
          body: comment.body,
          user: { login: VIEWER.login, id: VIEWER.id },
          created_at: comment.createdAt,
          url: `/api/v3/repos/${owner}/${repoName}/issues/${number}/comments/${comment.id}`,
        });
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((comment) => ({
          id: comment.id,
          node_id: globalId('Comment', comment.id),
          body: comment.body,
          user: { login: VIEWER.login, id: VIEWER.id },
          created_at: comment.createdAt,
        })));
        return true;
      }
      return false;
    }
    return false;
  }

  if (sub === 'pulls') {
    const repo = needRepo();
    if (repo === null) return true;
    if (tail.length === 1) {
      if (method === 'POST') {
        const title = strField(ctx.body, 'title');
        const body = strField(ctx.body, 'body');
        const headRaw = strField(ctx.body, 'head');
        const baseRaw = strField(ctx.body, 'base');
        const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
        const base = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
        if (head === '' || base === '') {
          sendJson(res, 422, { message: 'Validation Failed: head and base are required' });
          return true;
        }
        if (repo.refs.get(`refs/heads/${head}`) === undefined || repo.refs.get(`refs/heads/${base}`) === undefined) {
          sendJson(res, 422, { message: 'Validation Failed: head or base branch does not exist' });
          return true;
        }
        for (const existing of repo.pulls.values()) {
          if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
            sendJson(res, 422, { message: 'Validation Failed: a pull request already exists for this head' });
            return true;
          }
        }
        const pull = createPullRecord(repo, title, body, head, base);
        if (pull === null) {
          sendJson(res, 422, { message: 'Validation Failed' });
          return true;
        }
        sendJson(res, 201, pullJson(repo, pull));
        return true;
      }
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        let list = [...repo.pulls.values()];
        if (state !== 'all') list = list.filter((pull) => pull.state === state);
        list.sort((a, b) => b.createdSeq - a.createdSeq);
        const { page, link } = paginate(list.map((pull) => pullJson(repo, pull)), ctx.query, `/api/v3/repos/${owner}/${repoName}/pulls`, requestOrigin(ctx));
        sendJson(res, 200, page, link === null ? {} : { link });
        return true;
      }
      return false;
    }
    const number = Number.parseInt(tail[1] as string, 10);
    if (!Number.isInteger(number)) return false;
    const pull = repo.pulls.get(number);
    if (tail.length === 2) {
      if (method === 'GET') {
        if (pull === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        sendJson(res, 200, pullJson(repo, pull));
        return true;
      }
      return false;
    }
    if (tail.length === 3 && tail[2] === 'files') {
      if (method === 'GET') {
        if (pull === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        const base = mergeBase(repo, currentBaseSha(repo, pull), pull.headSha) ?? pull.baseSha;
        const files = diffTrees(repo, commitTree(repo, base), commitTree(repo, pull.headSha));
        sendJson(res, 200, files.map((file) => ({
          sha: '',
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.additions + file.deletions,
        })));
        return true;
      }
      return false;
    }
    if (tail.length === 3 && tail[2] === 'merge') {
      if (method === 'PUT') {
        if (pull === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        if (pull.state !== 'open') {
          sendJson(res, 405, { message: 'Pull request is already closed' });
          return true;
        }
        const sha = squashMerge(repo, pull);
        if (sha === null) {
          sendJson(res, 405, { message: 'Merge conflict' });
          return true;
        }
        sendJson(res, 200, { sha, merged: true, message: 'Pull request successfully merged' });
        return true;
      }
      return false;
    }
    return false;
  }

  return false;
}

/** The immediate children of a directory inside a tree. */
function dirListing(repo: Repo, treeOid: string, dirPath: string): Record<string, unknown>[] {
  if (treeOid === '') return [];
  const files = flattenTree(repo, treeOid);
  const entries = new Map<string, { type: 'file' | 'dir'; sha: string; size: number }>();
  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const object = repo.objects.get(entry.oid);
      entries.set(rest, { type: 'file', sha: entry.oid, size: object ? object.data.length : 0 });
    } else {
      const dirName = rest.slice(0, slash);
      if (!entries.has(dirName)) {
        // Find the subtree oid by walking the tree.
        const sub = subtreeOid(repo, treeOid, dirPath === '' ? dirName : `${dirPath}/${dirName}`);
        entries.set(dirName, { type: 'dir', sha: sub, size: 0 });
      }
    }
  }
  return [...entries.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, entry]) => ({
      type: entry.type,
      name,
      path: prefix + name,
      sha: entry.sha,
      size: entry.size,
    }));
}

function subtreeOid(repo: Repo, treeOid: string, dirPath: string): string {
  const segments = dirPath.split('/').filter((part) => part !== '');
  let current = treeOid;
  for (const segment of segments) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return '';
    const found = treeEntriesOf(object).find((entry) => entry.name === segment && entry.mode === '40000');
    if (!found) return '';
    current = found.oid;
  }
  return current;
}

// ---------------------------------------------------------------------------
// GraphQL v4: a small parser and executor for the documents gh sends.
// ---------------------------------------------------------------------------

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: { name: string; value: GqlValue }[] };

interface GqlField {
  alias: string | null;
  name: string;
  args: { name: string; value: GqlValue }[];
  selections: GqlSelection[] | null;
}

type GqlSelection =
  | { kind: 'field'; field: GqlField }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: GqlSelection[] };

interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  selections: GqlSelection[];
}

function tokenizeGql(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():!@$[]=|'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j] as string;
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < source.length && /[A-Za-z0-9_.-]/.test(source[j] as string)) j += 1;
    if (j === i) {
      i += 1;
      continue;
    }
    tokens.push(source.slice(i, j));
    i = j;
  }
  return tokens;
}

class GqlParser {
  #tokens: string[];
  #pos = 0;
  constructor(source: string) {
    this.#tokens = tokenizeGql(source);
  }
  peek(): string | undefined {
    return this.#tokens[this.#pos];
  }
  next(): string {
    const token = this.#tokens[this.#pos] as string;
    this.#pos += 1;
    return token;
  }
  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }
  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.#pos < this.#tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }
  parseOperation(): GqlOperation {
    let type: 'query' | 'mutation' = 'query';
    const token = this.peek();
    if (token === 'query' || token === 'mutation') {
      type = this.next() as 'query' | 'mutation';
    }
    let name: string | null = null;
    const afterType = this.peek();
    if (afterType !== undefined && afterType !== '{' && afterType !== '(') {
      name = this.next();
    }
    if (this.peek() === '(') {
      this.skipParens();
    }
    const selections = this.parseSelectionSet();
    return { type, name, selections };
  }
  skipParens(): void {
    let depth = 0;
    while (this.#pos < this.#tokens.length) {
      const token = this.next();
      if (token === '(') depth += 1;
      else if (token === ')') {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }
  parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (this.peek() !== '}' && this.#pos < this.#tokens.length) {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }
  parseSelection(): GqlSelection {
    if (this.peek() === '...') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        typeCondition = this.next();
      }
      const selections = this.parseSelectionSet();
      return { kind: 'inlineFragment', typeCondition, selections };
    }
    let alias: string | null = null;
    let name = this.next();
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: { name: string; value: GqlValue }[] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    let selections: GqlSelection[] | null = null;
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { kind: 'field', field: { alias, name, args, selections } };
  }
  parseValue(): GqlValue {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const values: GqlValue[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: { name: string; value: GqlValue }[] = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d+\.\d+$/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
    return { kind: 'enum', value: token };
  }
}

function evalGqlValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable': {
      return variables[value.name];
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((entry) => evalGqlValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = evalGqlValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: GqlField, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evalGqlValue(arg.value, variables);
  return out;
}

// --- GraphQL schema: which fields each type has, and their child types. ---

const GQL_SCHEMA: Record<string, Record<string, string | null>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  User: { login: null, id: null, name: null, email: null },
  Repository: {
    id: null, databaseId: null, name: null, nameWithOwner: null, owner: 'User',
    defaultBranchRef: 'Ref', viewerPermission: null, hasIssuesEnabled: null,
    description: null, private: null, issue: 'Issue', issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest',
  },
  Ref: { name: null },
  Issue: {
    id: null, number: null, title: null, state: null, body: null,
    createdAt: null, updatedAt: null, author: 'User',
  },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo', totalCount: null },
  PullRequest: {
    id: null, number: null, title: null, body: null, state: null, merged: null,
    mergeable: null, headRefName: null, baseRefName: null, files: 'PullRequestFileConnection',
    headRef: 'Ref', baseRef: 'Ref', createdAt: null, updatedAt: null,
  },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo', totalCount: null },
  PullRequestFileConnection: { nodes: 'PullRequestFile', pageInfo: 'PageInfo' },
  PullRequestFile: { path: null },
  PageInfo: { hasNextPage: null, endCursor: null, hasPreviousPage: null, startCursor: null },
  __Type: { name: null, kind: null, fields: '__Field', enumValues: '__EnumValue' },
  __Field: { name: null },
  __EnumValue: { name: null },
  Mutation: {
    createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  IssueCommentEdge: { node: 'IssueComment' },
  IssueComment: { id: null, body: null, author: 'User' },
  Node: {
    id: null, name: null, nameWithOwner: null, number: null, title: null, state: null, body: null,
  },
};

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'comments', 'labels'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'headRef', 'baseRef', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt'],
  SearchType: [],
  User: ['login', 'id', 'name', 'email'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI', 'PACKAGE', 'MARKETPLACE'];

interface GqlNode {
  __type: string;
  [key: string]: unknown;
}

function userNode(): GqlNode {
  return { __type: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
}

function repoNode(repo: Repo): GqlNode {
  return { __type: 'Repository', _repo: repo };
}

function issueNode(repo: Repo, issue: Issue): GqlNode {
  return { __type: 'Issue', _repo: repo, _issue: issue };
}

function pullNode(repo: Repo, pull: PullRequest): GqlNode {
  return { __type: 'PullRequest', _repo: repo, _pull: pull };
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(after: unknown): number {
  if (typeof after !== 'string' || after === '') return -1;
  try {
    const decoded = Buffer.from(after, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match ? Number.parseInt(match[1] as string, 10) : -1;
  } catch {
    return -1;
  }
}

function makeConnection<T>(items: readonly T[], first: unknown, after: unknown): GqlNode & { _items: T[] } {
  const start = indexOfCursor(after) + 1;
  const count = typeof first === 'number' && Number.isFinite(first) ? Math.max(0, Math.trunc(first)) : items.length;
  const slice = items.slice(start, start + count);
  const endIndex = start + slice.length - 1;
  return {
    __type: 'Connection',
    _items: slice,
    _pageInfo: {
      hasNextPage: start + slice.length < items.length,
      endCursor: slice.length === 0 ? null : cursorFor(endIndex),
      hasPreviousPage: start > 0,
      startCursor: slice.length === 0 ? null : cursorFor(start),
    },
  };
}

class GraphQLExecutor {
  #errors: { message: string }[] = [];

  execute(query: string, variables: Record<string, unknown>, operationName?: string): { data: unknown; errors?: { message: string }[] } {
    this.#errors = [];
    let operations: GqlOperation[];
    try {
      operations = new GqlParser(query).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
    }
    const operation = operationName !== undefined
      ? operations.find((op) => op.name === operationName) ?? operations[0]
      : operations[0];
    if (operation === undefined) return { data: null, errors: [{ message: 'no operation found' }] };
    const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
    const data = this.select(rootType, { __type: rootType }, operation.selections, variables);
    if (this.#errors.length > 0) return { data, errors: this.#errors };
    return { data };
  }

  select(typeName: string, value: unknown, selections: GqlSelection[], variables: Record<string, unknown>): unknown {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) {
      return value.map((entry) => this.select(typeName, entry, selections, variables));
    }
    if (typeof value !== 'object') return value;
    // The runtime type wins over the static one (node(id:) returns a
    // Repository behind the Node interface); connections keep their static
    // connection type, since their __type is the generic 'Connection'.
    const runtime = (value as GqlNode).__type;
    const effective = runtime !== undefined && runtime !== 'Connection' ? runtime : typeName;
    const isConnection = effective.endsWith('Connection');
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'inlineFragment') {
        if (selection.typeCondition !== null && selection.typeCondition !== effective && selection.typeCondition !== 'Node') {
          continue;
        }
        const fragment = this.select(effective, value, selection.selections, variables);
        if (isRecord(fragment)) Object.assign(out, fragment);
        continue;
      }
      const field = selection.field;
      const key = field.alias ?? field.name;
      const childType = GQL_SCHEMA[effective]?.[field.name];
      if (field.name === '__typename') {
        out[key] = effective;
        continue;
      }
      if (childType === undefined && !(isConnection && (field.name === 'nodes' || field.name === 'pageInfo' || field.name === 'totalCount'))) {
        this.#errors.push({ message: `Cannot query field "${field.name}" on type "${effective}".` });
        out[key] = null;
        continue;
      }
      const raw = this.resolveField(effective, value as GqlNode, field, variables);
      if (field.selections === null) {
        out[key] = raw;
      } else if (raw === null || raw === undefined) {
        out[key] = null;
      } else if (isConnection && field.name === 'nodes') {
        const itemType = (value as GqlNode & { _itemType?: string })._itemType ?? 'Issue';
        out[key] = (raw as unknown[]).map((entry) => this.select(itemType, entry, field.selections as GqlSelection[], variables));
      } else if (isConnection && field.name === 'pageInfo') {
        out[key] = this.select('PageInfo', raw, field.selections as GqlSelection[], variables);
      } else {
        const nextType = childType ?? effective;
        out[key] = this.select(nextType, raw, field.selections as GqlSelection[], variables);
      }
    }
    return out;
  }

  resolveField(typeName: string, value: GqlNode, field: GqlField, variables: Record<string, unknown>): unknown {
    const args = argsOf(field, variables);
    if (typeName === 'Query') {
      if (field.name === 'viewer') return userNode();
      if (field.name === 'repository') {
        const owner = args.owner as string;
        const name = args.name as string;
        if (owner !== VIEWER.login) return null;
        const repo = getRepo(owner, name);
        return repo === undefined ? null : repoNode(repo);
      }
      if (field.name === 'node') {
        return this.resolveNode(args.id as string);
      }
      if (field.name === '__type') {
        const name = args.name as string;
        if (name === 'SearchType') {
          return { __type: '__Type', name, kind: 'ENUM', _enumValues: SEARCH_TYPE_VALUES.map((entry) => ({ __type: '__EnumValue', name: entry })) };
        }
        const fields = TYPE_FIELDS[name];
        if (fields === undefined) return null;
        return {
          __type: '__Type', name, kind: 'OBJECT',
          _fields: fields.map((entry) => ({ __type: '__Field', name: entry })),
          _enumValues: [],
        };
      }
      return null;
    }
    if (typeName === '__Type') {
      if (field.name === 'fields') return (value._fields as unknown[] | undefined) ?? null;
      if (field.name === 'enumValues') return (value._enumValues as unknown[] | undefined) ?? null;
      if (field.name === 'name') return value.name ?? null;
      if (field.name === 'kind') return value.kind ?? null;
      return null;
    }
    if (typeName === 'Repository') {
      const repo = value._repo as Repo;
      switch (field.name) {
        case 'id': return globalId('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return userNode();
        case 'defaultBranchRef': {
          const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return sha === undefined ? null : { __type: 'Ref', name: repo.defaultBranch };
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'private': return repo.isPrivate;
        case 'issue': {
          const issue = repo.issues.get(args.number as number);
          return issue === undefined ? null : issueNode(repo, issue);
        }
        case 'issues': {
          let list = [...repo.issues.values()];
          const states = args.states as string[] | undefined;
          if (Array.isArray(states) && states.length > 0) {
            const wanted = new Set(states.map((state) => state.toLowerCase()));
            list = list.filter((issue) => wanted.has(issue.state));
          }
          const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
          const direction = orderBy?.direction ?? 'DESC';
          list.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          const connection = makeConnection(list.map((issue) => issueNode(repo, issue)), args.first, args.after);
          connection._itemType = 'Issue';
          return connection;
        }
        case 'pullRequests': {
          let list = [...repo.pulls.values()];
          const states = args.states as string[] | undefined;
          if (Array.isArray(states) && states.length > 0) {
            const wanted = new Set(states);
            list = list.filter((pull) => wanted.has(pull.state === 'open' ? 'OPEN' : 'CLOSED'));
          } else {
            list = list.filter((pull) => pull.state === 'open');
          }
          list.sort((a, b) => b.createdSeq - a.createdSeq);
          const connection = makeConnection(list.map((pull) => pullNode(repo, pull)), args.first, args.after);
          connection._itemType = 'PullRequest';
          return connection;
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(args.number as number);
          return pull === undefined ? null : pullNode(repo, pull);
        }
        default: return null;
      }
    }
    if (typeName === 'Issue') {
      const repo = value._repo as Repo;
      const issue = value._issue as Issue;
      switch (field.name) {
        case 'id': return globalId('Issue', `${repo.id}:${issue.number}`);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body': return issue.body;
        case 'createdAt': return isoOf(EPOCH_SEC + issue.createdSeq);
        case 'updatedAt': return isoOf(EPOCH_SEC + issue.createdSeq);
        case 'author': return userNode();
        default: return null;
      }
    }
    if (typeName === 'PullRequest') {
      const repo = value._repo as Repo;
      const pull = value._pull as PullRequest;
      switch (field.name) {
        case 'id': return globalId('PullRequest', `${repo.id}:${pull.number}`);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged': return pull.merged;
        case 'mergeable': {
          if (pull.state !== 'open') return 'UNKNOWN';
          return mergeConflicts(repo, currentBaseSha(repo, pull), pull.headSha) ? 'CONFLICTING' : 'MERGEABLE';
        }
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRef': return { __type: 'Ref', name: pull.headRef };
        case 'baseRef': return { __type: 'Ref', name: pull.baseRef };
        case 'createdAt': return isoOf(EPOCH_SEC + pull.createdSeq);
        case 'updatedAt': return isoOf(EPOCH_SEC + pull.createdSeq);
        case 'files': {
          const base = mergeBase(repo, currentBaseSha(repo, pull), pull.headSha) ?? pull.baseSha;
          const files = diffTrees(repo, commitTree(repo, base), commitTree(repo, pull.headSha));
          const connection = makeConnection(files.map((file) => ({ __type: 'PullRequestFile', path: file.filename })), args.first, args.after);
          connection._itemType = 'PullRequestFile';
          return connection;
        }
        default: return null;
      }
    }
    if (typeName === 'Mutation') {
      return this.resolveMutation(field, args);
    }
    if (typeName === 'Connection' || typeName.endsWith('Connection')) {
      if (field.name === 'nodes') return (value as GqlNode & { _items: unknown[] })._items;
      if (field.name === 'pageInfo') return (value as GqlNode & { _pageInfo: unknown })._pageInfo;
      if (field.name === 'totalCount') return (value as GqlNode & { _items: unknown[] })._items.length;
      return null;
    }
    if (typeName === 'Node') {
      return value[field.name] ?? null;
    }
    // Plain objects (User, Ref, PageInfo, __Field, __EnumValue, payloads).
    if (field.name === 'id' && typeof value.id === 'string') return value.id;
    const direct = (value as Record<string, unknown>)[field.name];
    return direct === undefined ? null : direct;
  }

  resolveNode(id: string): GqlNode | null {
    const parsed = parseGlobalId(id);
    if (parsed === null) return null;
    const [repoIdRaw, numberRaw] = parsed.value.split(':');
    const repoId = Number.parseInt(repoIdRaw ?? '', 10);
    const repo = [...repos.values()].find((entry) => entry.id === repoId);
    if (repo === undefined) return null;
    if (parsed.kind === 'Repository') return repoNode(repo);
    if (parsed.kind === 'Issue' && numberRaw !== undefined) {
      const issue = repo.issues.get(Number.parseInt(numberRaw, 10));
      return issue === undefined ? null : issueNode(repo, issue);
    }
    if (parsed.kind === 'PullRequest' && numberRaw !== undefined) {
      const pull = repo.pulls.get(Number.parseInt(numberRaw, 10));
      return pull === undefined ? null : pullNode(repo, pull);
    }
    return null;
  }

  resolveMutation(field: GqlField, args: Record<string, unknown>): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (field.name === 'createIssue') {
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed?.kind === 'Repository'
        ? [...repos.values()].find((entry) => entry.id === Number.parseInt(parsed.value, 10))
        : undefined;
      if (repo === undefined) {
        this.#errors.push({ message: 'createIssue: repository not found' });
        return null;
      }
      const issue = createIssueRecord(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __type: 'CreateIssuePayload', issue: issueNode(repo, issue) };
    }
    if (field.name === 'closeIssue') {
      const parsed = parseGlobalId(String(input.issueId ?? ''));
      if (parsed?.kind !== 'Issue') {
        this.#errors.push({ message: 'closeIssue: issue not found' });
        return null;
      }
      const [repoIdRaw, numberRaw] = parsed.value.split(':');
      const repo = [...repos.values()].find((entry) => entry.id === Number.parseInt(repoIdRaw ?? '', 10));
      const issue = repo?.issues.get(Number.parseInt(numberRaw ?? '', 10));
      if (repo === undefined || issue === undefined) {
        this.#errors.push({ message: 'closeIssue: issue not found' });
        return null;
      }
      issue.state = 'closed';
      return { __type: 'CloseIssuePayload', issue: issueNode(repo, issue) };
    }
    if (field.name === 'createPullRequest') {
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed?.kind === 'Repository'
        ? [...repos.values()].find((entry) => entry.id === Number.parseInt(parsed.value, 10))
        : undefined;
      if (repo === undefined) {
        this.#errors.push({ message: 'createPullRequest: repository not found' });
        return null;
      }
      const pull = createPullRecord(
        repo,
        String(input.title ?? ''),
        String(input.body ?? ''),
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      if (pull === null) {
        this.#errors.push({ message: 'createPullRequest: head or base branch does not exist' });
        return null;
      }
      return { __type: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) };
    }
    if (field.name === 'mergePullRequest') {
      const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
      if (parsed?.kind !== 'PullRequest') {
        this.#errors.push({ message: 'mergePullRequest: pull request not found' });
        return null;
      }
      const [repoIdRaw, numberRaw] = parsed.value.split(':');
      const repo = [...repos.values()].find((entry) => entry.id === Number.parseInt(repoIdRaw ?? '', 10));
      const pull = repo?.pulls.get(Number.parseInt(numberRaw ?? '', 10));
      if (repo === undefined || pull === undefined) {
        this.#errors.push({ message: 'mergePullRequest: pull request not found' });
        return null;
      }
      const sha = squashMerge(repo, pull);
      if (sha === null) {
        this.#errors.push({ message: 'mergePullRequest: merge conflict' });
        return { __type: 'MergePullRequestPayload', pullRequest: pullNode(repo, pull) };
      }
      return { __type: 'MergePullRequestPayload', pullRequest: pullNode(repo, pull) };
    }
    if (field.name === 'addComment') {
      const parsed = parseGlobalId(String(input.subjectId ?? ''));
      if (parsed?.kind !== 'Issue') {
        this.#errors.push({ message: 'addComment: issue not found' });
        return null;
      }
      const [repoIdRaw, numberRaw] = parsed.value.split(':');
      const repo = [...repos.values()].find((entry) => entry.id === Number.parseInt(repoIdRaw ?? '', 10));
      const issue = repo?.issues.get(Number.parseInt(numberRaw ?? '', 10));
      if (repo === undefined || issue === undefined) {
        this.#errors.push({ message: 'addComment: issue not found' });
        return null;
      }
      commentIdSeq += 1;
      const comment = { id: commentIdSeq, body: String(input.body ?? ''), createdAt: isoOf(nextTick()) };
      issue.comments.push(comment);
      return {
        __type: 'AddCommentPayload',
        commentEdge: {
          __type: 'IssueCommentEdge',
          node: { __type: 'IssueComment', id: globalId('Comment', comment.id), body: comment.body, author: userNode() },
        },
      };
    }
    this.#errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
    return null;
  }
}

async function handleGraphQL(ctx: Ctx): Promise<void> {
  const res = ctx.res;
  if (ctx.bodyRaw.length === 0) {
    sendJson(res, 400, { errors: [{ message: 'empty GraphQL request body' }] });
    return;
  }
  const parsed = parseJsonBody(ctx.bodyRaw);
  if (!parsed.ok) {
    sendJson(res, 400, { errors: [{ message: 'Unexpected token in JSON' }] });
    return;
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      return { errors: [{ message: 'GraphQL request must carry a query string' }] };
    }
    const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
    const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
    return new GraphQLExecutor().execute(entry.query, variables, operationName) as Record<string, unknown>;
  };
  if (Array.isArray(parsed.value)) {
    sendJson(res, 200, parsed.value.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed.value));
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol, streamable HTTP).
// ---------------------------------------------------------------------------

interface McpToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      issue_number: { type: 'integer', description: 'The issue number.' },
    },
    required: ['owner', 'repo', 'issue_number'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
      body: { type: 'string', description: 'The pull request body.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
  {
    name: 'close_issue',
    description: 'Close an issue by number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      issue_number: { type: 'integer', description: 'The issue number.' },
    },
    required: ['owner', 'repo', 'issue_number'],
  },
];

function mcpToolJson(def: McpToolDef): Record<string, unknown> {
  return {
    name: def.name,
    description: def.description,
    inputSchema: { type: 'object', properties: def.properties, required: def.required },
  };
}

function mcpRpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function mcpRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function mcpToolResult(result: unknown, isError = false): Record<string, unknown> {
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return {
    content: [{ type: 'text', text }],
    structuredContent: result,
    isError,
  };
}

function findMcpTool(name: string): McpToolDef | undefined {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const tool of MCP_TOOLS) {
    const candidate = tool.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalized === candidate || normalized.endsWith(candidate)) return tool;
  }
  return undefined;
}

function mcpRepoOf(args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  if (owner === '' || repoName === '') return null;
  if (owner !== VIEWER.login) return null;
  return getRepo(owner, repoName) ?? null;
}

function callMcpTool(name: string, args: Record<string, unknown>): { result: unknown; isError: boolean } {
  const tool = findMcpTool(name);
  if (tool === undefined) return { result: `unknown tool: ${name}`, isError: true };
  for (const required of tool.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') {
      return { result: `missing required argument: ${required}`, isError: true };
    }
  }
  switch (tool.name) {
    case 'create_repo': {
      const repoName = String(args.name ?? '');
      if (getRepo(VIEWER.login, repoName) !== undefined) {
        return { result: `repository ${VIEWER.login}/${repoName} already exists`, isError: true };
      }
      const repo = createRepoRecord(
        VIEWER.login,
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return { result: repoJson(repo), isError: false };
    }
    case 'get_repo': {
      const repo = mcpRepoOf(args);
      if (repo === null) return { result: 'repository not found', isError: true };
      return { result: repoJson(repo), isError: false };
    }
    case 'create_issue': {
      const repo = mcpRepoOf(args);
      if (repo === null) return { result: 'repository not found', isError: true };
      const issue = createIssueRecord(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
      return { result: issueJson(repo, issue), isError: false };
    }
    case 'list_issues': {
      const repo = mcpRepoOf(args);
      if (repo === null) return { result: 'repository not found', isError: true };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => a.createdSeq - b.createdSeq);
      return { result: list.map((issue) => issueJson(repo, issue)), isError: false };
    }
    case 'get_issue': {
      const repo = mcpRepoOf(args);
      if (repo === null) return { result: 'repository not found', isError: true };
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) return { result: 'issue not found', isError: true };
      return { result: issueJson(repo, issue), isError: false };
    }
    case 'create_pull_request': {
      const repo = mcpRepoOf(args);
      if (repo === null) return { result: 'repository not found', isError: true };
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      const pull = createPullRecord(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', head, base);
      if (pull === null) return { result: 'head or base branch does not exist', isError: true };
      return { result: pullJson(repo, pull), isError: false };
    }
    case 'list_pull_requests': {
      const repo = mcpRepoOf(args);
      if (repo === null) return { result: 'repository not found', isError: true };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((pull) => pull.state === state);
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      return { result: list.map((pull) => pullJson(repo, pull)), isError: false };
    }
    case 'merge_pull_request': {
      const repo = mcpRepoOf(args);
      if (repo === null) return { result: 'repository not found', isError: true };
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return { result: 'pull request not found', isError: true };
      if (pull.state !== 'open') return { result: 'pull request is already closed', isError: true };
      const sha = squashMerge(repo, pull);
      if (sha === null) return { result: 'merge conflict', isError: true };
      return { result: { merged: true, sha, message: 'Pull request successfully merged', number: pull.number }, isError: false };
    }
    case 'close_issue': {
      const repo = mcpRepoOf(args);
      if (repo === null) return { result: 'repository not found', isError: true };
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) return { result: 'issue not found', isError: true };
      issue.state = 'closed';
      return { result: issueJson(repo, issue), isError: false };
    }
    default:
      return { result: `unknown tool: ${name}`, isError: true };
  }
}

async function handleMcp(ctx: Ctx): Promise<void> {
  const res = ctx.res;
  if (ctx.bodyRaw.length === 0) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const parsed = parseJsonBody(ctx.bodyRaw);
  if (!parsed.ok) {
    // A body that is not JSON: HTTP 400 with JSON-RPC -32700.
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const request = parsed.value;
  if (!isRecord(request) || typeof request.method !== 'string') {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const id = request.id ?? null;
  const method = request.method;
  const params = isRecord(request.params) ? (request.params as Record<string, unknown>) : {};

  // A notification (no id) is answered with 202 and no body.
  if (id === null && method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': nextRequestId() });
    res.end();
    return;
  }

  if (method === 'server/discover') {
    sendJson(res, 200, mcpRpcResult(id, {
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
      capabilities: { tools: {} },
      serverInfo: { name: FORGE_NAME, version: FORGE_VERSION },
    }));
    return;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    const known = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    sendJson(res, 200, mcpRpcResult(id, {
      protocolVersion: known.includes(requested) ? requested : '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: { name: FORGE_NAME, version: FORGE_VERSION },
    }));
    return;
  }
  if (method === 'ping') {
    sendJson(res, 200, mcpRpcResult(id, {}));
    return;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, mcpRpcResult(id, { tools: MCP_TOOLS.map(mcpToolJson) }));
    return;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = findMcpTool(toolName);
    if (tool === undefined) {
      sendJson(res, 200, mcpRpcError(id, -32601, `Method not found: ${toolName}`));
      return;
    }
    const { result, isError } = callMcpTool(tool.name, args);
    if (isError && typeof result === 'string' && result.startsWith('missing required argument')) {
      sendJson(res, 200, mcpRpcResult(id, mcpToolResult(result, true)));
      return;
    }
    sendJson(res, 200, mcpRpcResult(id, mcpToolResult(result, isError)));
    return;
  }
  sendJson(res, 200, mcpRpcError(id, -32601, `Method not found: ${method}`));
}

// ---------------------------------------------------------------------------
// Git smart HTTP: pkt-lines, packs, advertisements, upload-pack, receive-pack.
// ---------------------------------------------------------------------------

/** Split a pkt-line stream into data payloads, stopping at (and consuming) the first flush or delim packet. */
function readPktLines(buf: Buffer): { lines: Buffer[]; rest: Buffer } {
  const lines: Buffer[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const length = Number.parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0 || length === 2 || length === 3) break;
    if (length === 0 || length === 1) {
      offset += 4;
      break;
    }
    if (offset + length > buf.length) break;
    lines.push(buf.subarray(offset + 4, offset + length));
    offset += length;
  }
  return { lines, rest: buf.subarray(offset) };
}

const UPLOAD_CAPS = [
  'symref=HEAD:refs/heads/main',
  'side-band-64k',
  'ofs-delta',
  'thin-pack',
  'multi_ack',
  'multi_ack_detailed',
  'shallow',
  `agent=${FORGE_AGENT}`,
  'object-format=sha1',
].join(' ');

const RECEIVE_CAPS = [
  'report-status',
  'delete-refs',
  'side-band-64k',
  'ofs-delta',
  `agent=${FORGE_AGENT}`,
  'symref=HEAD:refs/heads/main',
  'object-format=sha1',
].join(' ');

function sortedRefs(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

function refAdvertisementLines(repo: Repo, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const headSha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (headSha === undefined) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return lines;
  }
  lines.push(pktLine(`${headSha} HEAD\0${caps}\n`));
  for (const ref of sortedRefs(repo)) {
    const sha = repo.refs.get(ref) as string;
    lines.push(pktLine(`${sha} ${ref}\n`));
    const peeled = peelToCommit(repo, sha);
    if (peeled !== sha && repo.objects.get(sha)?.type === 'tag') {
      lines.push(pktLine(`${peeled} ${ref}^{}\n`));
    }
  }
  return lines;
}

function sendGit(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': nextRequestId(),
    'content-length': body.length,
  });
  res.end(body);
}

interface PackSelection {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

function selectPackObjects(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | null,
): PackSelection {
  // Minimum depth of every commit reachable from the wants.
  const minDepth = new Map<string, number>();
  const queue: { oid: string; depth: number }[] = [];
  for (const want of wants) {
    if (repo.objects.get(want)?.type === 'commit' && !minDepth.has(want)) {
      minDepth.set(want, 1);
      queue.push({ oid: want, depth: 1 });
    }
  }
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index] as { oid: string; depth: number };
    const commit = parseCommitOf(repo, current.oid);
    for (const parent of commit.parents) {
      if (repo.objects.get(parent)?.type !== 'commit') continue;
      if (!minDepth.has(parent)) {
        minDepth.set(parent, current.depth + 1);
        queue.push({ oid: parent, depth: current.depth + 1 });
      }
    }
  }
  // Prune everything reachable from a have, except shallow boundaries: the
  // client explicitly holds the boundary commit but not its ancestors, so a
  // deepen must still deliver them.
  const boundarySet = new Set(shallowBoundaries);
  const pruned = new Set<string>();
  const pruneQueue: string[] = [];
  for (const have of haves) {
    if (boundarySet.has(have)) continue;
    if (repo.objects.get(have)?.type === 'commit' && !pruned.has(have)) {
      pruned.add(have);
      pruneQueue.push(have);
    }
  }
  for (let index = 0; index < pruneQueue.length; index += 1) {
    const current = pruneQueue[index] as string;
    const commit = parseCommitOf(repo, current);
    for (const parent of commit.parents) {
      if (repo.objects.get(parent)?.type === 'commit' && !pruned.has(parent)) {
        pruned.add(parent);
        pruneQueue.push(parent);
      }
    }
  }
  const included = new Set<string>();
  for (const [oid, depthValue] of minDepth) {
    if (depth !== null && depthValue > depth) continue;
    if (pruned.has(oid)) continue;
    included.add(oid);
  }
  const shallow: string[] = [];
  if (depth !== null) {
    for (const oid of included) {
      if (minDepth.get(oid) === depth) shallow.push(oid);
    }
  }
  const unshallow: string[] = [];
  for (const boundary of shallowBoundaries) {
    if (included.has(boundary) && !shallow.includes(boundary)) unshallow.push(boundary);
  }
  const acks: string[] = [];
  for (const have of haves) {
    if (minDepth.has(have)) acks.push(have);
  }
  // Object closure of the included commits (trees, subtrees, blobs). A want
  // naming a non-commit object is included directly.
  const objects = new Map<string, GitObject>();
  const visitObject = (oid: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || objects.has(oid)) return;
    objects.set(oid, object);
    if (object.type === 'commit') {
      visitObject(parseCommitOf(repo, oid).tree);
    } else if (object.type === 'tree') {
      for (const entry of treeEntriesOf(object)) visitObject(entry.oid);
    }
  };
  for (const oid of included) visitObject(oid);
  // A want naming a non-commit object is included directly; a commit want
  // that was pruned (already held) must stay out.
  for (const want of wants) {
    if (!included.has(want) && repo.objects.get(want)?.type !== 'commit') visitObject(want);
  }
  // Never re-send an object the client already holds through a have: drop
  // everything reachable from a pruned commit. (A shallow boundary is not
  // pruned, so a deepen still delivers the ancestors it lacks.)
  const held = new Set<string>();
  const visitHeld = (oid: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || held.has(oid)) return;
    held.add(oid);
    if (object.type === 'commit') {
      visitHeld(parseCommitOf(repo, oid).tree);
    } else if (object.type === 'tree') {
      for (const entry of treeEntriesOf(object)) visitHeld(entry.oid);
    }
  };
  for (const oid of pruned) visitHeld(oid);
  for (const oid of held) objects.delete(oid);
  return { objects, shallow, unshallow, acks };
}

async function handleInfoRefs(ctx: Ctx, owner: string, repoName: string): Promise<void> {
  const res = ctx.res;
  if (owner !== VIEWER.login) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const repo = getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const service = ctx.query.get('service') ?? '';
  const isV2 = (ctx.req.headers['git-protocol'] as string | undefined) === 'version=2';
  if (service === 'git-upload-pack') {
    if (isV2) {
      const body = pktLines([
        'version 2\n',
        `agent=${FORGE_AGENT}\n`,
        'ls-refs=unborn\n',
        'fetch=shallow filter\n',
        'object-format=sha1\n',
        'flush',
      ]);
      sendGit(res, 200, 'application/x-git-upload-pack-advertisement', body);
      return;
    }
    const body = Buffer.concat([
      pktLine('# service=git-upload-pack\n'),
      PKT_FLUSH,
      ...refAdvertisementLines(repo, UPLOAD_CAPS),
    ]);
    sendGit(res, 200, 'application/x-git-upload-pack-advertisement', body);
    return;
  }
  if (service === 'git-receive-pack') {
    const body = Buffer.concat([
      pktLine('# service=git-receive-pack\n'),
      PKT_FLUSH,
      ...refAdvertisementLines(repo, RECEIVE_CAPS),
    ]);
    sendGit(res, 200, 'application/x-git-receive-pack-advertisement', body);
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

function parseUploadPackV2(body: Buffer): {
  command: string;
  args: string[];
} | null {
  const { lines, rest } = readPktLines(body);
  if (lines.length === 0) return null;
  const first = (lines[0] as Buffer).toString('utf8').replace(/\n$/, '');
  if (!first.startsWith('command=')) return null;
  const command = first.slice('command='.length);
  const args: string[] = [];
  for (const line of readPktLines(rest).lines) {
    args.push(line.toString('utf8').replace(/\n$/, ''));
  }
  return { command, args };
}

function lsRefsV2(repo: Repo, args: readonly string[]): Buffer {
  const prefixes: string[] = [];
  let peel = false;
  for (const arg of args) {
    if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    else if (arg === 'peel') peel = true;
  }
  const lines: string[] = [];
  const headSha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const include = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (headSha !== undefined && include('HEAD')) {
    lines.push(`${headSha} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  }
  for (const ref of sortedRefs(repo)) {
    if (!include(ref)) continue;
    const sha = repo.refs.get(ref) as string;
    let line = `${sha} ${ref}`;
    const peeled = peelToCommit(repo, sha);
    if (peel && peeled !== sha && repo.objects.get(sha)?.type === 'tag') {
      line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
}

async function handleUploadPack(ctx: Ctx, owner: string, repoName: string): Promise<void> {
  const res = ctx.res;
  if (owner !== VIEWER.login) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const repo = getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  // v2 is detected by the Git-Protocol header; fall back to sniffing the
  // first pkt-line, whose payload starts with "command=".
  const firstLen = Number.parseInt(ctx.bodyRaw.subarray(0, 4).toString('ascii'), 16);
  const isV2Body = Number.isFinite(firstLen) && firstLen >= 12
    && ctx.bodyRaw.subarray(4, 12).toString('ascii') === 'command=';
  const isV2 = (ctx.req.headers['git-protocol'] as string | undefined) === 'version=2' || isV2Body;
  if (isV2) {
    const parsed = parseUploadPackV2(ctx.bodyRaw);
    if (parsed === null) {
      sendJson(res, 400, { message: 'malformed git protocol v2 request' });
      return;
    }
    if (parsed.command === 'ls-refs') {
      sendGit(res, 200, 'application/x-git-upload-pack-result', lsRefsV2(repo, parsed.args));
      return;
    }
    if (parsed.command !== 'fetch') {
      sendJson(res, 400, { message: `unsupported v2 command: ${parsed.command}` });
      return;
    }
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    for (const arg of parsed.args) {
      if (arg.startsWith('want ')) wants.push(arg.slice(5, 45));
      else if (arg.startsWith('have ')) haves.push(arg.slice(5, 45));
      else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8, 48));
      else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7), 10);
    }
    const selection = selectPackObjects(repo, wants, haves, shallow, Number.isFinite(depth) ? depth : null);
    const parts: Buffer[] = [];
    parts.push(pktLine('acknowledgments\n'));
    if (selection.acks.length > 0) {
      for (const ack of selection.acks) parts.push(pktLine(`ACK ${ack}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(PKT_DELIM);
    if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('wanted-refs\n'));
    for (const want of wants) {
      for (const ref of sortedRefs(repo)) {
        if (repo.refs.get(ref) === want) parts.push(pktLine(`${want} ${ref}\n`));
      }
    }
    parts.push(PKT_DELIM);
    if (selection.objects.size > 0) {
      parts.push(pktLine('packfile\n'));
      parts.push(sidebandPack(writePack(selection.objects.values())));
    }
    parts.push(PKT_FLUSH);
    sendGit(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
    return;
  }
  // Protocol v0: wants section, flush, then haves section, flush.
  const firstSection = readPktLines(ctx.bodyRaw);
  const secondSection = readPktLines(firstSection.rest);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of firstSection.lines) {
    const text = line.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5, 45));
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8, 48));
    else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7), 10);
  }
  for (const line of secondSection.lines) {
    const text = line.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('have ')) haves.push(text.slice(5, 45));
  }
  if (wants.length === 0) {
    sendJson(res, 400, { message: 'no wants in upload-pack request' });
    return;
  }
  const selection = selectPackObjects(repo, wants, haves, shallow, Number.isFinite(depth) ? depth : null);
  const parts: Buffer[] = [];
  if (selection.acks.length > 0) {
    for (const ack of selection.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (selection.objects.size > 0) parts.push(sidebandPack(writePack(selection.objects.values())));
  parts.push(PKT_FLUSH);
  sendGit(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

async function handleReceivePack(ctx: Ctx, owner: string, repoName: string): Promise<void> {
  const res = ctx.res;
  const reportLines: string[] = [];
  const sendReport = (): void => {
    const text = reportLines.join('');
    const body = Buffer.concat([sidebandPack(Buffer.from(text, 'utf8')), PKT_FLUSH]);
    sendGit(res, 200, 'application/x-git-receive-pack-result', body);
  };
  if (owner !== VIEWER.login) {
    reportLines.push('unpack ok\n');
    sendReport();
    return;
  }
  const repo = getRepo(owner, repoName);
  if (repo === undefined) {
    reportLines.push('unpack ok\n');
    sendReport();
    return;
  }
  const { lines, rest } = readPktLines(ctx.bodyRaw);
  interface PushCommand { oldOid: string; newOid: string; ref: string }
  const commands: PushCommand[] = [];
  for (const line of lines) {
    let text = line.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const parts = text.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  // The pack follows the command flush. A delete-only push carries none.
  let unpackError: string | null = null;
  if (rest.length > 0) {
    try {
      const objects = readPack(rest);
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack error';
    }
  }
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack error\n`);
    sendReport();
    return;
  }
  reportLines.push('unpack ok\n');
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
      } else if (current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      } else {
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (repo.objects.get(command.newOid) === undefined) {
      reportLines.push(`ng ${command.ref} unable to read ${command.newOid}\n`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        reportLines.push(`ng ${command.ref} already exists\n`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    // Update.
    if (current === undefined) {
      reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
    } else if (current !== command.oldOid) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
    } else if (!isAncestor(repo, command.oldOid, command.newOid)) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
    } else {
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
    }
  }
  sendReport();
}

// ---------------------------------------------------------------------------
// HTTP plumbing: request context, auth, routing.
// ---------------------------------------------------------------------------

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > 512 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function createApp(): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      const pathname = url.pathname;
      if (method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      // Every other surface requires the shop token.
      if (!authed(req)) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }
      const bodyRaw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readRequestBody(req);
      // A malformed JSON body on the REST surface is a 400 with a message.
      // (GraphQL and MCP answer parse failures in their own shapes.)
      if ((method === 'POST' || method === 'PUT' || method === 'PATCH') && pathname.startsWith('/api/v3') && bodyRaw.length > 0) {
        if (!parseJsonBody(bodyRaw).ok) {
          sendJson(res, 400, { message: 'malformed JSON body' });
          return;
        }
      }
      const parsed = bodyRaw.length === 0 ? { ok: true, value: null } : parseJsonBody(bodyRaw);
      const ctx: Ctx = {
        req,
        res,
        method,
        path: pathname,
        query: url.searchParams,
        segments: pathname.split('/').filter((part) => part !== ''),
        body: parsed.ok ? parsed.value : null,
        bodyRaw,
      };
      if (pathname === '/api/graphql' && method === 'POST') {
        await handleGraphQL(ctx);
        return;
      }
      if (pathname === '/mcp' && method === 'POST') {
        await handleMcp(ctx);
        return;
      }
      if (pathname.startsWith('/api/v3')) {
        if (await handleRest(ctx)) return;
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
      if (gitMatch !== null) {
        const owner = decodeURIComponent(gitMatch[1] as string);
        const repoName = decodeURIComponent(gitMatch[2] as string);
        const service = gitMatch[3] as string;
        if (service === 'info/refs' && method === 'GET') {
          await handleInfoRefs(ctx, owner, repoName);
          return;
        }
        if (service === 'git-upload-pack' && method === 'POST') {
          await handleUploadPack(ctx, owner, repoName);
          return;
        }
        if (service === 'git-receive-pack' && method === 'POST') {
          await handleReceivePack(ctx, owner, repoName);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
      } else {
        res.end();
      }
    }
  });
  return server;
}
