// Smart-HTTP git surface: protocol v2 + v0 upload-pack, v0 receive-pack.
// Node 22 stdlib only. No git binary, no network, no clock, no randomness:
// ids come from the store's deterministic counters where a response needs one.
//
// Auth: the suite's git client sends `Authorization: Bearer <token>` on every
// request (git-client.ts request()), so every git route requires it via
// store.isAuthorized() and answers 401 otherwise.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { isAuthorized, VIEWER_LOGIN, type Repo, type Store } from './store.ts';
import { pathOf, queryOf, readBody } from './http.ts';
import { isAncestor, parseCommit, parseTree } from './gitobj.ts';

export const ZERO_OID = '0'.repeat(40);
const AGENT = 'makefun-forge/1.0';
const PKT_LINE_MAX = 65520;

/** The store's object shape, as git.ts works with it. */
interface PackObject {
  type: string;
  data: Buffer;
}

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_LINE_MAX) throw new Error('pkt-line payload too long');
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

function encodePktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

type DecodedPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Decode pkt-lines from the head of `buffer`. Stops at the first non-framed
 * byte and reports how many bytes the framed prefix consumed, so a
 * receive-pack body yields its command list plus the raw pack that follows.
 */
function decodePktPrefix(buffer: Buffer): { packets: DecodedPacket[]; consumed: number } {
  const packets: DecodedPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) break;
    const length = Number.parseInt(head, 16);
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
    if (length < 4 || length > PKT_LINE_MAX) break;
    if (offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset };
}

/** The text of every data packet, in order. */
function packetTexts(packets: readonly DecodedPacket[]): string[] {
  const out: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') out.push(packet.payload.toString('utf8'));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// packfile write (plain objects, no deltas: valid git, correctness first)
// ---------------------------------------------------------------------------------------------

const PACK_TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function writePackObjectHeader(type: string, size: number): Buffer {
  const code = PACK_TYPE_CODE[type];
  if (code === undefined) throw new Error(`unknown pack object type ${type}`);
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

function writePack(objects: readonly PackObject[]): Buffer {
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

// ---------------------------------------------------------------------------------------------
// packfile read (OFS_DELTA and REF_DELTA resolved; bases may be in-pack or in-store)
// ---------------------------------------------------------------------------------------------

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: string;
  resolved?: Buffer;
  oid?: string;
}

const PACK_CODE_TYPE: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/**
 * Read a packfile (version 2/3) into a map of id -> object, resolving deltas.
 * `resolveBase` supplies a base a thin pack leaves out (the store, for pushes).
 * Throws on a bad header, a bad trailer checksum, a truncated entry, or an
 * unresolvable delta base.
 */
function readPack(pack: Buffer, resolveBase: (oid: string) => PackObject | undefined): Map<string, PackObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!PACK_CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, PackObject>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: string; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined && entry.resolvedType !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: string;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor on the server`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = PACK_CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObjectIdOnly(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

/** SHA-1 id of an object without writing it to the store. */
function hashObjectIdOnly(type: string, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------------------------
// tag objects
// ---------------------------------------------------------------------------------------------

interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Follow annotated tags to the object they ultimately point at. */
function peelTag(store: Store, oid: string): string {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    const object = store.objects.get(current);
    if (!object || object.type !== 'tag' || seen.has(current)) return current;
    seen.add(current);
    current = parseTag(object.data).object;
  }
}

// ---------------------------------------------------------------------------------------------
// reachability and fetch selection
// ---------------------------------------------------------------------------------------------

/** Every object reachable from `roots` (commit -> tree + parents, tag -> target). */
function collectReachable(store: Store, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (root !== ZERO_OID) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = store.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.sha);
      }
    }
  }
  return seen;
}

/** A commit's tree closure: the commit, its tree, and every tree/blob under it. */
function treeClosure(store: Store, commitOid: string): Set<string> {
  const out = new Set<string>();
  const object = store.objects.get(commitOid);
  if (!object || object.type !== 'commit') return out;
  out.add(commitOid);
  const queue: string[] = [parseCommit(object.data).tree];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (out.has(oid)) continue;
    const entry = store.objects.get(oid);
    if (!entry) continue;
    out.add(oid);
    if (entry.type === 'tree') {
      for (const child of parseTree(entry.data)) {
        if (child.mode !== '160000') queue.push(child.sha);
      }
    }
  }
  return out;
}

interface FetchPlan {
  /** Objects to put in the pack, in deterministic order. */
  objects: PackObject[];
  /** Commits that are shallow boundaries in the result. */
  shallow: string[];
  /** Previous shallow boundaries that are no longer shallow. */
  unshallow: string[];
}

interface FetchOptions {
  /** "deepen N" is N levels past the current shallow boundary, not absolute. */
  deepenRelative?: boolean;
  /** Also send annotated tags pointing at the fetched commits. */
  includeTag?: boolean;
}

/** Fewest parent edges from `want` to an old shallow boundary, or null. */
function edgesToShallowAncestor(store: Store, want: string, oldShallowSet: Set<string>): number | null {
  const seen = new Set<string>([want]);
  const queue: Array<{ oid: string; dist: number }> = [{ oid: want, dist: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (oldShallowSet.has(current.oid)) return current.dist;
    const object = store.objects.get(current.oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push({ oid: parent, dist: current.dist + 1 });
      }
    }
  }
  return null;
}

/**
 * Work out what a fetch sends. `wants` are the wanted tips, `haves` the ids
 * the client already holds, `oldShallow` its current shallow boundary, and
 * `depth` the deepen limit (undefined = full history).
 *
 * The walk is bounded by `depth` and never traverses past a shallow boundary
 * the client already has, so a depth-1 clone of a 200-commit repo touches
 * only the tip commit and its tree. Objects the client already holds are
 * excluded: a non-shallow have excludes its full closure, a shallow have
 * excludes only itself plus its tree closure (its parents were never sent).
 *
 * With `deepenRelative`, `depth` counts levels past the current shallow
 * boundary instead of from the tips: the effective depth for a want is the
 * edges from it to its nearest old shallow ancestor, plus one, plus `depth`
 * (real git's `git fetch --deepen=N` sends `deepen N` + `deepen-relative`;
 * without it `depth` is absolute, as the suite's client sends it).
 */
function planFetch(
  store: Store,
  wants: string[],
  haves: string[],
  oldShallow: string[],
  depth: number | undefined,
  options: FetchOptions = {},
): FetchPlan {
  const wantSet = new Set(wants);
  const oldShallowSet = new Set(oldShallow);

  // Per-want depth limit: absolute, or relative to the shallow boundary.
  const limitFor = (want: string): number | undefined => {
    if (depth === undefined) return undefined;
    if (!options.deepenRelative) return depth;
    const object = store.objects.get(want);
    const commitOid = object && object.type === 'tag' ? parseTag(object.data).object : want;
    const edges = edgesToShallowAncestor(store, commitOid, oldShallowSet);
    if (edges === null) return depth;
    return edges + 1 + depth;
  };

  // Included commits, with their depth from a want (wants are depth 1).
  const included = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number; limit: number | undefined }> = [];
  for (const want of wants) {
    const object = store.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      queue.push({ oid: parseTag(object.data).object, depth: 1, limit: limitFor(want) });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, depth: 1, limit: limitFor(want) });
    } else {
      included.set(want, 0);
    }
  }
  const boundary = new Set<string>();
  // The largest limit a commit was already expanded under: a commit reached
  // again under a larger limit (another want) is expanded again.
  const expandedWithLimit = new Map<string, number>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    const limit = current.limit ?? Number.POSITIVE_INFINITY;
    const expanded = expandedWithLimit.get(current.oid);
    if (expanded !== undefined && expanded >= limit && included.has(current.oid)) continue;
    expandedWithLimit.set(current.oid, Math.max(expanded ?? -1, limit));
    const object = store.objects.get(current.oid);
    if (!object) continue;
    if (object.type === 'tag') {
      queue.push({ oid: parseTag(object.data).object, depth: current.depth, limit: current.limit });
      continue;
    }
    if (object.type !== 'commit') {
      included.set(current.oid, current.depth);
      continue;
    }
    included.set(current.oid, current.depth);
    const atLimit = current.limit !== undefined && current.depth >= current.limit;
    // A shallow boundary blocks expansion, unless this fetch deepens past
    // it (deepen-relative) or the commit is itself a want.
    const blocked =
      !options.deepenRelative && oldShallowSet.has(current.oid) && !wantSet.has(current.oid);
    if (atLimit || blocked) {
      boundary.add(current.oid);
      continue;
    }
    for (const parent of parseCommit(object.data).parents) {
      queue.push({ oid: parent, depth: current.depth + 1, limit: current.limit });
    }
  }

  // Objects the client already holds.
  const held = new Set<string>();
  for (const have of haves) {
    if (oldShallowSet.has(have)) {
      for (const oid of treeClosure(store, have)) held.add(oid);
    } else {
      for (const oid of collectReachable(store, [have])) held.add(oid);
    }
  }

  // Everything the included commits (and wanted tags) reach, minus held.
  const send = new Set<string>();
  for (const want of wants) {
    const object = store.objects.get(want);
    if (object && object.type === 'tag') send.add(want);
  }
  for (const oid of included.keys()) {
    for (const reached of treeClosure(store, oid)) send.add(reached);
  }
  if (options.includeTag) {
    for (const [oid, object] of store.objects) {
      if (object.type === 'tag' && included.has(peelTag(store, oid))) send.add(oid);
    }
  }
  for (const oid of held) send.delete(oid);

  const ordered = [...send].sort();
  const objects: PackObject[] = [];
  for (const oid of ordered) {
    const object = store.objects.get(oid);
    if (object) objects.push({ type: object.type, data: object.data });
  }

  const shallow = [...boundary].filter((oid) => included.has(oid)).sort();
  const shallowSet = new Set(shallow);
  const unshallow = oldShallow.filter((oid) => included.has(oid) && !shallowSet.has(oid)).sort();
  return { objects, shallow, unshallow };
}

// ---------------------------------------------------------------------------------------------
// refs and advertisements
// ---------------------------------------------------------------------------------------------

function headRefName(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Capability list for a v0 advertisement's first line. */
function v0Caps(service: 'git-upload-pack' | 'git-receive-pack'): string {
  const common = `symref=HEAD:refs/heads/main agent=${AGENT}`;
  if (service === 'git-upload-pack') {
    // multi_ack_detailed: real git's stateless-RPC upload-pack refuses to
    // run without it; the suite client only reads it opportunistically.
    return `side-band-64k thin-pack ofs-delta shallow multi_ack multi_ack_detailed ${common}`;
  }
  return `report-status side-band-64k delete-refs ofs-delta ${common}`;
}

/**
 * A v0 ref advertisement: "# service=..." preamble, flush, then ref lines.
 * The first line carries the capabilities after a NUL; an empty repo gets the
 * zero-id `capabilities^{}` pseudo-ref. Annotated tags get a `^{}` peeled line.
 */
function v0Advertisement(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  const caps = v0Caps(service);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    // A literal HEAD line first: v0 clients learn the default branch from
    // it (plus the symref capability). Without it a v0 clone checks out the
    // local default branch name with no commits, even though the objects
    // and remote-tracking refs arrived.
    const headOid = repo.refs.get(headRefName(repo)) ?? ZERO_OID;
    lines.push(`${headOid} HEAD\0${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const object = store.objects.get(ref.oid);
      if (object && object.type === 'tag') {
        lines.push(`${peelTag(store, ref.oid)} ${ref.name}^{}\n`);
      }
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** A v2 capability advertisement: service preamble, then "version 2" + caps. */
function v2Advertisement(service: 'git-upload-pack'): Buffer {
  const lines: Array<string | 'flush'> = [
    `# service=${service}\n`,
    'flush',
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'flush',
  ];
  return encodePktLines(lines);
}

// ---------------------------------------------------------------------------------------------
// HTTP helpers for git responses
// ---------------------------------------------------------------------------------------------

function sendGit(res: ServerResponse, store: Store, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': store.nextReqId(),
  });
  res.end(body);
}

function sendGitText(res: ServerResponse, store: Store, status: number, text: string): void {
  sendGit(res, store, status, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8'));
}

/** Parse "/{owner}/{repo}.git/..." into owner, repo name and the tail segments. */
function parseGitPath(req: IncomingMessage): { owner: string; repo: string; tail: string[] } | null {
  const parts = pathOf(req).split('/').filter((part) => part.length > 0);
  if (parts.length < 2) return null;
  const repoSegment = parts[1];
  if (!repoSegment.endsWith('.git')) return null;
  let owner = parts[0];
  let repo = repoSegment.slice(0, -4);
  try {
    owner = decodeURIComponent(owner);
    repo = decodeURIComponent(repo);
  } catch {
    return null;
  }
  return { owner, repo, tail: parts.slice(2) };
}

// ---------------------------------------------------------------------------------------------
// route handlers
// ---------------------------------------------------------------------------------------------

function unauthorized(res: ServerResponse, store: Store): void {
  sendGitText(res, store, 401, 'Unauthorized\n');
}

/** Resolve the repo for a git route, answering 404 for a wrong owner or a missing repo. */
function resolveRepo(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
): { repo: Repo } | null {
  const parsed = parseGitPath(req);
  if (parsed === null) return null;
  if (parsed.owner !== VIEWER_LOGIN) {
    sendGitText(res, store, 404, 'Not Found\n');
    return null;
  }
  const repo = store.getRepo(parsed.owner, parsed.repo);
  if (repo === undefined) {
    sendGitText(res, store, 404, 'Not Found\n');
    return null;
  }
  return { repo };
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, store: Store): boolean {
  if (!isAuthorized(req)) {
    unauthorized(res, store);
    return true;
  }
  const found = resolveRepo(req, res, store);
  if (found === null) return true;
  const service = queryOf(req).get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendGitText(res, store, 400, 'unknown service\n');
    return true;
  }
  const isV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  const body = isV2
    ? v2Advertisement(service)
    : v0Advertisement(store, found.repo, service);
  sendGit(res, store, 200, `application/x-${service}-advertisement`, body);
  return true;
}

/** Wrap pack bytes in sideband band-1 pkt-lines (32 KiB chunks stay under the pkt-line max). */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += 32768) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + 32768));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

// --- upload-pack v2 -----------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  deepenRelative?: boolean;
  includeTag?: boolean;
}

function lsRefsResponse(store: Store, repo: Repo, args: Map<string, string[]>): Buffer {
  const prefixes = args.get('ref-prefix') ?? [];
  const peel = args.has('peel');
  const symrefs = args.has('symrefs');
  const unborn = args.has('unborn');
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headName = headRefName(repo);
  const headOid = repo.refs.get(headName);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD${symrefs ? ` symref-target:${headName}` : ''}\n`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${headName}` : ''}\n`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    const object = store.objects.get(ref.oid);
    if (peel && object && object.type === 'tag') {
      line += ` peeled:${peelTag(store, ref.oid)}`;
    }
    lines.push(`${line}\n`);
  }
  return encodePktLines([...lines, 'flush']);
}

function fetchResponseV2(store: Store, repo: Repo, fetchArgs: FetchArgs): Buffer {
  const plan = planFetch(store, fetchArgs.wants, fetchArgs.haves, fetchArgs.shallow, fetchArgs.depth, {
    deepenRelative: fetchArgs.deepenRelative,
    includeTag: fetchArgs.includeTag,
  });
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  // acknowledgments section: sent only when the client sent have lines.
  // A fresh clone sends none, and real git then expects the packfile section
  // next ("expected 'packfile', received 'acknowledgments'").
  if (fetchArgs.haves.length > 0) {
    parts.push(encodePktLine('acknowledgments\n'));
    let common: string | null = null;
    const reachable = collectReachable(store, fetchArgs.wants);
    common = fetchArgs.haves.find((have) => reachable.has(have)) ?? null;
    if (common !== null) {
      parts.push(encodePktLine(`ACK ${common}\n`));
      parts.push(encodePktLine('ready\n'));
    } else {
      parts.push(encodePktLine('NAK\n'));
    }
    parts.push(DELIM);
  }
  // shallow-info section, only when the boundary moved
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  // packfile section
  parts.push(encodePktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

async function handleUploadPackV2(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
  body: Buffer,
): Promise<boolean> {
  const { packets } = decodePktPrefix(body);
  const texts = packetTexts(packets);
  const commandLine = texts.find((text) => text.startsWith('command='));
  if (commandLine === undefined) {
    sendGitText(res, store, 400, 'missing command\n');
    return true;
  }
  const command = commandLine.slice('command='.length).trim();
  // Arguments are the data lines after the delim packet.
  const args = new Map<string, string[]>();
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (!afterDelim || packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const space = text.indexOf(' ');
    const key = space < 0 ? text : text.slice(0, space);
    const value = space < 0 ? '' : text.slice(space + 1);
    const list = args.get(key) ?? [];
    list.push(value);
    args.set(key, list);
  }
  if (command === 'ls-refs') {
    sendGit(res, store, 200, 'application/x-git-upload-pack-result', lsRefsResponse(store, repo, args));
    return true;
  }
  if (command === 'fetch') {
    const wants = args.get('want') ?? [];
    for (const want of wants) {
      if (!store.objects.has(want)) {
        sendGitText(res, store, 400, `want ${want} is not on the server\n`);
        return true;
      }
    }
    const depthValues = args.get('deepen') ?? [];
    const depth = depthValues.length > 0 ? Number.parseInt(depthValues[0], 10) : undefined;
    const fetchArgs: FetchArgs = {
      wants,
      haves: args.get('have') ?? [],
      shallow: args.get('shallow') ?? [],
      depth: depth !== undefined && Number.isFinite(depth) && depth > 0 ? depth : undefined,
      deepenRelative: args.has('deepen-relative'),
      includeTag: args.has('include-tag'),
    };
    sendGit(res, store, 200, 'application/x-git-upload-pack-result', fetchResponseV2(store, repo, fetchArgs));
    return true;
  }
  sendGitText(res, store, 400, `unknown command ${command}\n`);
  return true;
}

// --- upload-pack v0 -----------------------------------------------------------

async function handleUploadPackV0(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
  body: Buffer,
): Promise<boolean> {
  const { packets } = decodePktPrefix(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const text of packetTexts(packets)) {
    const line = text.replace(/\n$/, '');
    const tokens = line.split(' ');
    if (tokens[0] === 'want' && tokens[1] !== undefined) wants.push(tokens[1]);
    else if (tokens[0] === 'have' && tokens[1] !== undefined) haves.push(tokens[1]);
    else if (tokens[0] === 'shallow' && tokens[1] !== undefined) shallow.push(tokens[1]);
    else if (tokens[0] === 'deepen' && tokens[1] !== undefined) {
      const parsed = Number.parseInt(tokens[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) depth = parsed;
    }
  }
  if (wants.length === 0) {
    sendGitText(res, store, 400, 'no want lines\n');
    return true;
  }
  for (const want of wants) {
    if (!store.objects.has(want)) {
      sendGitText(res, store, 400, `want ${want} is not on the server\n`);
      return true;
    }
  }
  const plan = planFetch(store, wants, haves, shallow, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  let common: string | null = null;
  if (haves.length > 0) {
    const reachable = collectReachable(store, wants);
    common = haves.find((have) => reachable.has(have)) ?? null;
  }
  parts.push(encodePktLine(common !== null ? `ACK ${common}\n` : 'NAK\n'));
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(FLUSH);
  sendGit(res, store, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
  return true;
}

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  if (!isAuthorized(req)) {
    unauthorized(res, store);
    return true;
  }
  const found = resolveRepo(req, res, store);
  if (found === null) return true;
  const body = await readBody(req);
  if (body === null) {
    sendGitText(res, store, 400, 'request body too large\n');
    return true;
  }
  if ((req.headers['git-protocol'] ?? '') === 'version=2') {
    return handleUploadPackV2(req, res, store, found.repo, body);
  }
  return handleUploadPackV0(req, res, store, found.repo, body);
}

// --- receive-pack v0 ----------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function sanitizeReportText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').slice(0, 200);
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  if (!isAuthorized(req)) {
    unauthorized(res, store);
    return true;
  }
  const found = resolveRepo(req, res, store);
  if (found === null) return true;
  const repo = found.repo;
  const body = await readBody(req);
  if (body === null) {
    sendGitText(res, store, 400, 'request body too large\n');
    return true;
  }
  const { packets, consumed } = decodePktPrefix(body);
  const commands: PushCommand[] = [];
  for (const text of packetTexts(packets)) {
    const line = text.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const head = nul < 0 ? line : line.slice(0, nul);
    const tokens = head.split(' ');
    if (tokens.length < 3) continue;
    commands.push({ oldOid: tokens[0], newOid: tokens[1], ref: tokens[2] });
  }
  const reportLines: string[] = [];
  const packBytes = body.subarray(consumed);
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (needsPack) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'packfile is missing';
    } else {
      try {
        const objects = readPack(packBytes, (oid) => store.objects.get(oid));
        for (const [oid, object] of objects) {
          if (!store.objects.has(oid)) store.objects.set(oid, { type: object.type, data: object.data });
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = sanitizeReportText(err instanceof Error ? err.message : String(err));
      }
    }
  }
  if (unpackOk) {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const verdict = applyPushCommand(store, repo, command);
      reportLines.push(verdict.ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${verdict.reason}\n`);
    }
  } else {
    reportLines.push(`unpack ${unpackDetail}\n`);
  }
  const parts: Buffer[] = [];
  for (const line of reportLines) {
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), encodePktLine(line)])));
  }
  // Terminate the report-status stream itself inside band 1: the client's
  // report reader waits for this flush (the outer flush only ends the
  // sideband stream, and without the inner one git reports "the remote end
  // hung up unexpectedly" even though every ref line arrived).
  parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), Buffer.from('0000', 'ascii')])));
  parts.push(FLUSH);
  sendGit(res, store, 200, 'application/x-git-receive-pack-result', Buffer.concat(parts));
  return true;
}

/**
 * Apply one ref update. A ref moves only on a fast-forward (or a new ref, or
 * a delete); anything else is refused per-ref with its reason, and the ref
 * does not move. Tag refs compare peeled commits.
 */
function applyPushCommand(
  store: Store,
  repo: Repo,
  command: PushCommand,
): { ok: boolean; reason: string } {
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
      return { ok: false, reason: 'stale info' };
    }
    repo.refs.delete(command.ref);
    return { ok: true, reason: '' };
  }
  const object = store.objects.get(command.newOid);
  if (object === undefined) return { ok: false, reason: 'object not found' };
  if (command.ref.startsWith('refs/heads/') && object.type !== 'commit') {
    return { ok: false, reason: 'object is not a commit' };
  }
  if (command.ref.startsWith('refs/tags/') && object.type !== 'tag' && object.type !== 'commit') {
    return { ok: false, reason: 'object is not a tag' };
  }
  if (command.oldOid === ZERO_OID) {
    if (current !== undefined) return { ok: false, reason: 'already exists' };
    repo.refs.set(command.ref, command.newOid);
    return { ok: true, reason: '' };
  }
  if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
  if (current !== command.oldOid) return { ok: false, reason: 'stale info' };
  if (command.newOid === current) return { ok: true, reason: '' };
  const ancestorBase = command.ref.startsWith('refs/tags/') ? peelTag(store, current) : current;
  const newTip = command.ref.startsWith('refs/tags/') ? peelTag(store, command.newOid) : command.newOid;
  if (!isAncestor(store, ancestorBase, newTip)) {
    return { ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(command.ref, command.newOid);
  return { ok: true, reason: '' };
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

/**
 * Answer a git smart-HTTP request. Returns true when the path matched a git
 * route (even when the answer is 401/404), false otherwise so the caller can
 * try the next surface.
 */
export async function handleGit(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const parsed = parseGitPath(req);
  if (parsed === null) return false;
  const method = req.method ?? 'GET';
  if (method === 'GET' && parsed.tail.length === 2 && parsed.tail[0] === 'info' && parsed.tail[1] === 'refs') {
    return handleInfoRefs(req, res, store);
  }
  if (method === 'POST' && parsed.tail.length === 1 && parsed.tail[0] === 'git-upload-pack') {
    return handleUploadPack(req, res, store);
  }
  if (method === 'POST' && parsed.tail.length === 1 && parsed.tail[0] === 'git-receive-pack') {
    return handleReceivePack(req, res, store);
  }
  return false;
}
