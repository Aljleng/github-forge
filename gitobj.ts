// The git object model: SHA-1 ids, loose-object bytes, trees, commits, and the
// history/tree operations the smart-HTTP layer and other builders use.
// Node 22 stdlib only. No clock, no randomness: every id is a pure function
// of the bytes it names.

import { createHash } from 'node:crypto';
import type { Store } from './store.ts';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface TreeEntryInput {
  name: string;
  mode: string;
  sha: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  message: string;
  authorLine: string;
  committerLine: string;
}

/** SHA-1 hex of raw bytes (no object header). */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The loose-object bytes "<type> <len>\0" + data that an id is computed over. */
function objectBytes(type: string, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]);
}

/**
 * Hash `data` as an object of `type`, write it to store.objects, and return
 * its SHA-1 hex id.
 */
export function hashObject(store: Store, type: ObjectType, data: Buffer): string {
  const sha = sha1Hex(objectBytes(type, data));
  if (!store.objects.has(sha)) store.objects.set(sha, { type, data });
  return sha;
}

/** Read one object from the store, or undefined when it is not there. */
export function readObject(store: Store, sha: string): { type: string; data: Buffer } | undefined {
  return store.objects.get(sha);
}

/** Store `content` as a blob and return its id. */
export function makeBlob(store: Store, content: Buffer): string {
  return hashObject(store, 'blob', content);
}

/** git's tree-entry sort: byte order of the name, a directory as if it ended in '/'. */
function compareTreeEntries(a: TreeEntryInput, b: TreeEntryInput): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/**
 * Build a tree object from entries (sorted git-style) and return its id.
 * Modes are "100644" for files and "40000" for directories.
 */
export function buildTree(store: Store, entries: TreeEntryInput[]): string {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return hashObject(store, 'tree', Buffer.concat(parts));
}

/** Parse a tree object's bytes into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > data.length) throw new Error('tree entry has a truncated object id');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      sha: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/**
 * Build a commit object and return its id. Author and committer lines are
 * "Name <email> <epoch> +0000"; the message is stored verbatim.
 */
export function makeCommit(
  store: Store,
  treeSha: string,
  parents: string[],
  message: string,
  authorName: string,
  authorEmail: string,
  epochSec: number,
): string {
  const who = `${authorName} <${authorEmail}> ${epochSec} +0000`;
  const lines = [`tree ${treeSha}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return hashObject(store, 'commit', Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8'));
}

/** Parse a commit object's bytes into tree, parents, message and identity lines. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') authorLine = value;
    else if (key === 'committer') committerLine = value;
  }
  return { tree, parents, message, authorLine, committerLine };
}

/**
 * Walk "a/b/c" through trees from `rootTreeSha` and return the final entry,
 * or undefined when any segment is missing (or a non-final segment is not a tree).
 */
export function getTreeEntry(store: Store, rootTreeSha: string, path: string): { mode: string; sha: string } | undefined {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) return undefined;
  let treeSha = rootTreeSha;
  for (let index = 0; index < segments.length; index += 1) {
    const object = readObject(store, treeSha);
    if (!object || object.type !== 'tree') return undefined;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (!entry) return undefined;
    if (index === segments.length - 1) return { mode: entry.mode, sha: entry.sha };
    if (entry.mode !== '40000') return undefined;
    treeSha = entry.sha;
  }
  return undefined;
}

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Set (or, with a null blobSha, delete) `path` in the tree rooted at
 * `rootTreeSha` (null = the empty tree) and return the new root tree id.
 * Intermediate trees are created as needed; a subtree emptied by a delete is
 * removed from its parent.
 */
export function setTreeEntry(
  store: Store,
  rootTreeSha: string | null,
  path: string,
  mode: string,
  blobSha: string | null,
): string {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) return rootTreeSha ?? hashObject(store, 'tree', Buffer.alloc(0));

  // Returns the new tree id, or null when the tree became empty.
  const setInTree = (treeSha: string | null, depth: number): string | null => {
    const object = treeSha === null ? undefined : readObject(store, treeSha);
    const entries: TreeEntry[] =
      object && object.type === 'tree' ? parseTree(object.data) : [];
    const name = segments[depth];
    if (depth === segments.length - 1) {
      const at = entries.findIndex((entry) => entry.name === name);
      if (blobSha === null) {
        if (at >= 0) entries.splice(at, 1);
      } else if (at >= 0) {
        entries[at] = { mode, name, sha: blobSha };
      } else {
        entries.push({ mode, name, sha: blobSha });
      }
    } else {
      const at = entries.findIndex((entry) => entry.name === name);
      const childSha = at >= 0 && entries[at].mode === '40000' ? entries[at].sha : null;
      const next = setInTree(childSha, depth + 1);
      if (next === null) {
        if (at >= 0) entries.splice(at, 1);
      } else if (at >= 0) {
        entries[at] = { mode: '40000', name, sha: next };
      } else {
        entries.push({ mode: '40000', name, sha: next });
      }
    }
    if (entries.length === 0) return null;
    return buildTree(store, entries);
  };

  const result = setInTree(rootTreeSha, 0);
  if (result !== null) return result;
  if (!store.objects.has(EMPTY_TREE_SHA)) {
    hashObject(store, 'tree', Buffer.alloc(0));
  }
  return EMPTY_TREE_SHA;
}

/** True when `ancestorSha` is `sha` itself or reachable from it via parents. */
export function isAncestor(store: Store, ancestorSha: string, sha: string): boolean {
  if (ancestorSha === sha) return true;
  const seen = new Set<string>();
  const queue: string[] = [sha];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = readObject(store, current);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestorSha) return true;
      queue.push(parent);
    }
  }
  return false;
}

/**
 * Commit ids newest-first by commit order (a commit, then its parents in
 * order, each visited once), up to `limit` when given.
 */
export function listCommits(store: Store, headSha: string, limit?: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [headSha];
  while (stack.length > 0) {
    if (limit !== undefined && out.length >= limit) break;
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = readObject(store, current);
    if (!object || object.type !== 'commit') continue;
    out.push(current);
    const parents = parseCommit(object.data).parents;
    for (let index = parents.length - 1; index >= 0; index -= 1) stack.push(parents[index]);
  }
  return out;
}

/** Flatten a tree to path -> leaf entry (directories expanded, gitlinks kept as leaves). */
function flattenTree(store: Store, treeSha: string, prefix: string, out: Map<string, TreeEntry>): void {
  const object = readObject(store, treeSha);
  if (!object || object.type !== 'tree') return;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.sha, path, out);
    else out.set(path, entry);
  }
}

/**
 * Three-way tree merge. A path changed in both ours and theirs relative to
 * base, with different results, is a conflict (listed, ours kept in the
 * merged tree); otherwise the changed side wins. Returns the merged tree id
 * and the conflicting paths.
 */
export function mergeTrees(
  store: Store,
  baseTreeSha: string,
  oursTreeSha: string,
  theirsTreeSha: string,
): { treeSha: string; conflicts: string[] } {
  const base = new Map<string, TreeEntry>();
  const ours = new Map<string, TreeEntry>();
  const theirs = new Map<string, TreeEntry>();
  flattenTree(store, baseTreeSha, '', base);
  flattenTree(store, oursTreeSha, '', ours);
  flattenTree(store, theirsTreeSha, '', theirs);

  const same = (a: TreeEntry | undefined, b: TreeEntry | undefined): boolean =>
    (a === undefined && b === undefined) ||
    (a !== undefined && b !== undefined && a.mode === b.mode && a.sha === b.sha);

  const conflicts: string[] = [];
  const merged = new Map<string, TreeEntry>();
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (same(o, t)) {
      if (o !== undefined) merged.set(path, o);
    } else if (same(o, b)) {
      if (t !== undefined) merged.set(path, t);
    } else if (same(t, b)) {
      if (o !== undefined) merged.set(path, o);
    } else {
      conflicts.push(path);
      if (o !== undefined) merged.set(path, o);
    }
  }
  conflicts.sort();
  let root: string | null = null;
  for (const path of [...merged.keys()].sort()) {
    const entry = merged.get(path)!;
    root = setTreeEntry(store, root, path, entry.mode, entry.sha);
  }
  if (root === null) {
    if (!store.objects.has(EMPTY_TREE_SHA)) hashObject(store, 'tree', Buffer.alloc(0));
    root = EMPTY_TREE_SHA;
  }
  return { treeSha: root, conflicts };
}
