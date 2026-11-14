// git.ts — the git object model, pkt-line codec and packfile read/write.
//
// Everything is implemented from the protocol itself: SHA-1 object ids,
// tree/commit/tag parsing and building, plain and delta packfiles, and the
// fetch object-selection (including shallow/deepen) the smart-HTTP surface
// needs. No git binary, no network, standard library only.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

const HEX40 = /^[0-9a-f]{40}$/;
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new Error('pkt-line payload too long');
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode a whole buffer into packets. Returns null on a malformed header. */
export function decodePktLines(bytes: Buffer): Packet[] | null {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) return null;
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) return null;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_LINE_MAX || offset + length > bytes.length) return null;
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

export function pktLinesText(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// trees, commits, tags
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object header');
  return {
    object,
    type: type as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
  timezone?: string;
}): Buffer {
  const timezone = fields.timezone ?? '+0000';
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} ${timezone}`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} ${timezone}`);
  lines.push('');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Every object reachable from `roots` (tags peel to their target). */
export function collectReachable(roots: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) throw new Error(`object ${oid} is missing from the store`);
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------------------------
// packfile write (plain objects, no deltas) and read (plain + OFS/REF deltas)
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
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

/** Build a packfile from plain objects. Order is the caller's; the trailer is SHA-1 over the rest. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++] as number;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[offset++] as number) * 2 ** shift;
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
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/** Read a packfile into objects (validating hashes and the trailer checksum). */
export function readPack(pack: Buffer, resolveBase?: ObjectLookup): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
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
      let byte = pack[offset] as number;
      offset += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset++] as number;
        value = ((value + 1) * 128) + (byte & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    const cached = (entry as unknown as { _r?: { type: GitObjectType; data: Buffer; oid: string } })._r;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
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
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const result = { type, data, oid };
    (entry as unknown as { _r?: unknown })._r = result;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return result;
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------------------------
// fetch object selection
// ---------------------------------------------------------------------------------------------

export interface FetchSelection {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * The objects a fetch must send, given the client's wants, haves, shallow
 * boundaries and depth.
 *
 * Rules the selection follows:
 * - a commit the client already holds (reachable from a have, without
 *   crossing a shallow boundary) is never re-sent, and traversal stops there;
 * - a shallow boundary the client holds is traversed through (its parents are
 *   what a deepen wants) but the boundary commit itself is not re-sent;
 * - depth N sends commits at distance 0..N-1 from a want; the commits at
 *   distance N-1 become the new shallow boundary;
 * - a boundary that was traversed through and whose parents are now sent is
 *   reported unshallow.
 */
export function selectFetchObjects(
  lookup: ObjectLookup,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | null,
): FetchSelection {
  const boundarySet = new Set(shallowBoundaries.filter(isObjectId));
  const maxDepth = depth === null ? Number.POSITIVE_INFINITY : depth;

  // H_excl: everything the client already holds, not crossing a shallow boundary.
  const held = new Set<string>();
  const heldQueue: string[] = [];
  for (const have of haves) if (isObjectId(have)) heldQueue.push(have);
  while (heldQueue.length) {
    const oid = heldQueue.pop() as string;
    if (held.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      held.add(commit.tree);
      if (!boundarySet.has(oid)) for (const parent of commit.parents) heldQueue.push(parent);
    } else if (object.type === 'tag') {
      heldQueue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') heldQueue.push(entry.oid);
      }
    }
  }
  // Trees/blobs reachable from held commits' trees belong to `held` too.
  // The walk needs its own visited set: a held root tree is already in
  // `held` (added above), so skipping visited-by-held would never descend
  // into it and its blobs would be re-sent as if new.
  const heldTrees = new Set<string>();
  for (const oid of [...held]) {
    const object = lookup(oid);
    if (object?.type === 'commit') heldTrees.add(parseCommit(object.data).tree);
  }
  const treeQueue = [...heldTrees];
  const visitedTrees = new Set<string>();
  while (treeQueue.length) {
    const oid = treeQueue.pop() as string;
    if (visitedTrees.has(oid)) continue;
    visitedTrees.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'tree') continue;
    held.add(oid);
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') treeQueue.push(entry.oid);
      else if (entry.mode !== '160000') held.add(entry.oid);
    }
  }

  // Walk from the wants with distances.
  const sentCommits = new Map<string, number>(); // oid -> distance
  const visited = new Set<string>();
  const queue: Array<{ oid: string; dist: number }> = [];
  for (const want of wants) {
    if (isObjectId(want)) queue.push({ oid: want, dist: 0 });
  }
  const newBoundary = new Set<string>();
  while (queue.length) {
    const { oid, dist } = queue.shift() as { oid: string; dist: number };
    if (visited.has(oid)) continue;
    visited.add(oid);
    const object = lookup(oid);
    if (!object) continue;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (!held.has(oid)) sentCommits.set(oid, dist);
      if (dist < maxDepth) queue.push({ oid: target, dist });
      continue;
    }
    if (object.type !== 'commit') continue;
    if (held.has(oid) && !boundarySet.has(oid)) continue; // held outright: stop here
    if (dist >= maxDepth) continue;
    if (!held.has(oid)) sentCommits.set(oid, dist);
    const commit = parseCommit(object.data);
    if (dist === maxDepth - 1) {
      newBoundary.add(oid);
      continue;
    }
    for (const parent of commit.parents) queue.push({ oid: parent, dist: dist + 1 });
  }

  // Objects: sent commits (and sent tags) plus their tree closure, minus held.
  const send = new Set<string>();
  const tagObjects: string[] = [];
  for (const oid of sentCommits.keys()) {
    const object = lookup(oid);
    if (!object) continue;
    if (object.type === 'tag') tagObjects.push(oid);
    send.add(oid);
  }
  const treeWork: string[] = [];
  for (const oid of sentCommits.keys()) {
    const object = lookup(oid);
    if (object?.type === 'commit') treeWork.push(parseCommit(object.data).tree);
    else if (object?.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = lookup(target);
      if (targetObject?.type === 'commit') treeWork.push(parseCommit(targetObject.data).tree);
    }
  }
  while (treeWork.length) {
    const oid = treeWork.pop() as string;
    if (send.has(oid) || held.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    send.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '40000') treeWork.push(entry.oid);
        else if (entry.mode !== '160000' && !held.has(entry.oid)) send.add(entry.oid);
      }
    }
  }
  // Tag targets' commits are in sentCommits already when reached through a tag want.
  for (const oid of tagObjects) {
    const target = parseTag((lookup(oid) as GitObject).data).object;
    if (!sentCommits.has(target) && lookup(target)?.type === 'commit' && !held.has(target)) {
      // A tag want whose target was not walked (depth 0 edge): include it.
      sentCommits.set(target, 0);
      send.add(target);
    }
  }

  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const object = lookup(oid);
    if (object) objects.push(object);
  }
  const unshallow = [...boundarySet].filter((oid) => {
    if (!visited.has(oid)) return false;
    if (newBoundary.has(oid)) return false;
    const object = lookup(oid);
    if (object?.type !== 'commit') return false;
    const parents = parseCommit(object.data).parents;
    return parents.length === 0 || parents.every((parent) => sentCommits.has(parent));
  });
  return { objects, shallow: [...newBoundary].sort(), unshallow: unshallow.sort() };
}

/** Is `ancestor` reachable from `tip` (walking parents, tags peeled)? */
export function isAncestor(lookup: ObjectLookup, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object) continue;
    if (object.type === 'commit') queue.push(...parseCommit(object.data).parents);
    else if (object.type === 'tag') queue.push(parseTag(object.data).object);
  }
  return false;
}

/** The merge-base of two commits (first common ancestor found by BFS from both sides). */
export function mergeBase(lookup: ObjectLookup, a: string, b: string): string | null {
  const fromA = new Set<string>();
  const queueA = [a];
  while (queueA.length) {
    const oid = queueA.pop() as string;
    if (fromA.has(oid)) continue;
    fromA.add(oid);
    const object = lookup(oid);
    if (object?.type === 'commit') queueA.push(...parseCommit(object.data).parents);
    else if (object?.type === 'tag') queueA.push(parseTag(object.data).object);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length) {
    const oid = queueB.pop() as string;
    if (fromA.has(oid)) return oid;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const object = lookup(oid);
    if (object?.type === 'commit') queueB.push(...parseCommit(object.data).parents);
    else if (object?.type === 'tag') queueB.push(parseTag(object.data).object);
  }
  return null;
}
