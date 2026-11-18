// GraphQL v4 surface for the forge: POST /api/graphql.
// Hand-rolled parser/executor covering exactly the documents the suite sends
// (see checks-graphql.ts): viewer/repository/issue/pull-request reads, node(id:),
// __type/__schema introspection, the five mutations, and operation batching.
// No network, no wall clock, no randomness: timestamps/ids come from store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Issue, Pull, Repo, Store } from './store.ts';
import { VIEWER, VIEWER_LOGIN, isAuthorized, issueNodeId, nodeId, parseNodeId, pullNodeId, repoNodeId } from './store.ts';
import { isObject, parseJsonBody, pathOf, readBody, sendJson } from './http.ts';
import {
  listCommits,
  makeCommit,
  mergeTrees,
  parseCommit,
  parseTree,
  readObject,
} from './gitobj.ts';

// ---------------------------------------------------------------------------
// Introspection data
// ---------------------------------------------------------------------------

const OBJECT_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'url'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'url', 'author', 'mergedAt', 'mergeCommit'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl'],
  Ref: ['id', 'name', 'target', 'repository'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueCommentConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Schema: ['queryType', 'mutationType', 'subscriptionType', 'types', 'directives'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'TOPIC', 'WIKI', 'PACKAGE', 'LABEL', 'MILESTONE', 'PROJECT'],
  IssueState: ['OPEN', 'CLOSED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// ---------------------------------------------------------------------------
// Tokenizer / parser (GraphQL documents only as complex as the suite sends)
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'var'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] ?? '';
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (src.startsWith('...', i)) { tokens.push({ kind: 'spread' }); i += 3; continue; }
    if (ch === '$') {
      let j = i + 1;
      while (j < src.length && /[_A-Za-z0-9]/.test(src[j] ?? '')) j += 1;
      tokens.push({ kind: 'var', value: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc === '/' ? '/' : esc === 'u' ? String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)) : esc;
          j += esc === 'u' ? 6 : 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      let isFloat = false;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j] ?? '')) j += 1;
      if (src[j] === '.' || src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        while (j < src.length && /[0-9.eE+-]/.test(src[j] ?? '')) j += 1;
      }
      tokens.push(isFloat ? { kind: 'float', value: src.slice(i, j) } : { kind: 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[_A-Za-z0-9]/.test(src[j] ?? '')) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('{}()[]!: =@&|'.includes(ch)) {
      if (ch !== ' ' && ch !== '=') tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias: string;
  name: string;
  args: { name: string; value: ValueNode }[];
  selections: SelectionNode[];
}
interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}
type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  type: 'query' | 'mutation' | 'subscription';
  name: string | null;
  varDefs: { name: string; defaultValue: ValueNode | null }[];
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) { this.tokens = tokens; }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private next(): Token {
    const t = this.tokens[this.pos];
    if (t === undefined) throw new Error('Unexpected end of GraphQL document');
    this.pos += 1;
    return t;
  }
  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`Expected "${value}" in GraphQL document`);
  }
  private acceptPunct(value: string): boolean {
    const t = this.peek();
    if (t !== undefined && t.kind === 'punct' && t.value === value) { this.pos += 1; return true; }
    return false;
  }
  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error('Expected a name in GraphQL document');
    return t.value;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.peek() !== undefined) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): Operation {
    let type: Operation['type'] = 'query';
    let name: string | null = null;
    const first = this.peek();
    if (first !== undefined && first.kind === 'name' && (first.value === 'query' || first.value === 'mutation' || first.value === 'subscription')) {
      this.next();
      type = first.value as Operation['type'];
      const maybeName = this.peek();
      if (maybeName !== undefined && maybeName.kind === 'name') { name = this.next().value as string; }
    } else if (first !== undefined && first.kind === 'name' && first.value === 'fragment') {
      throw new Error('Named fragments are not supported');
    }
    const varDefs: Operation['varDefs'] = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const varTok = this.next();
        if (varTok.kind !== 'var') throw new Error('Expected a variable in variable definitions');
        this.expectPunct(':');
        this.parseTypeName();
        let defaultValue: ValueNode | null = null;
        if (this.acceptPunct('=')) defaultValue = this.parseValue();
      }
    }
    const selections = this.parseSelectionSet();
    return { type, name, varDefs, selections };
  }

  private parseTypeName(): void {
    // Skip a type reference: Name, [Name], Name!, [Name!]! etc.
    if (this.acceptPunct('[')) {
      this.parseTypeName();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      const t = this.peek();
      if (t === undefined) throw new Error('Unexpected end in selection set');
      if (t.kind === 'spread') {
        this.next();
        const next = this.peek();
        if (next !== undefined && next.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'fragment', typeCondition, selections: this.parseSelectionSet() });
        } else if (next !== undefined && next.kind === 'name') {
          throw new Error('Named fragment spreads are not supported');
        } else {
          selections.push({ kind: 'fragment', typeCondition: null, selections: this.parseSelectionSet() });
        }
        continue;
      }
      const firstName = this.expectName();
      let alias = firstName;
      let name = firstName;
      if (this.acceptPunct(':')) {
        name = this.expectName();
      }
      const args: FieldNode['args'] = [];
      if (this.acceptPunct('(')) {
        while (!this.acceptPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.push({ name: argName, value: this.parseValue() });
        }
      }
      // Directives (@...) are not used by the suite; skip any.
      while (this.peek() !== undefined && this.peek()!.kind === 'punct' && this.peek()!.value === '@') {
        this.next();
        this.expectName();
        if (this.acceptPunct('(')) {
          while (!this.acceptPunct(')')) { this.expectName(); this.expectPunct(':'); this.parseValue(); }
        }
      }
      let sub: SelectionNode[] = [];
      if (this.peek() !== undefined && this.peek()!.kind === 'punct' && this.peek()!.value === '{') {
        sub = this.parseSelectionSet();
      }
      selections.push({ kind: 'field', alias, name, args, selections: sub });
    }
    return selections;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    switch (t.kind) {
      case 'var': return { kind: 'variable', name: t.value };
      case 'int': return { kind: 'int', value: Number(t.value) };
      case 'float': return { kind: 'float', value: Number(t.value) };
      case 'string': return { kind: 'string', value: t.value };
      case 'name':
        if (t.value === 'true') return { kind: 'boolean', value: true };
        if (t.value === 'false') return { kind: 'boolean', value: false };
        if (t.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: t.value };
      case 'punct':
        if (t.value === '[') {
          const values: ValueNode[] = [];
          while (!this.acceptPunct(']')) values.push(this.parseValue());
          return { kind: 'list', values };
        }
        if (t.value === '{') {
          const fields: { name: string; value: ValueNode }[] = [];
          while (!this.acceptPunct('}')) {
            const name = this.expectName();
            this.expectPunct(':');
            fields.push({ name, value: this.parseValue() });
          }
          return { kind: 'object', fields };
        }
        throw new Error(`Unexpected punctuation ${t.value} in a value`);
      default:
        throw new Error('Unexpected token in a value');
    }
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'int': case 'float': case 'string': case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => evalValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = evalValue(f.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = evalValue(a.value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// Shared git helpers (mirroring rest.ts)
// ---------------------------------------------------------------------------

function treeShaOfCommit(store: Store, commitSha: string): string | null {
  const obj = readObject(store, commitSha);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

function mergeBase(store: Store, a: string, b: string): string | null {
  const ancestorsA = new Set<string>(listCommits(store, a, 10000));
  ancestorsA.add(a);
  for (const sha of listCommits(store, b, 10000)) {
    if (ancestorsA.has(sha)) return sha;
  }
  return ancestorsA.has(b) ? b : null;
}

function flattenTree(store: Store, treeSha: string, prefix = '', out = new Map<string, { mode: string; sha: string }>()): Map<string, { mode: string; sha: string }> {
  const obj = readObject(store, treeSha);
  if (obj === undefined) return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.sha, path, out);
    else out.set(path, { mode: entry.mode, sha: entry.sha });
  }
  return out;
}

function pullFiles(store: Store, pull: Pull): { path: string }[] {
  if (pull.headSha === null || pull.baseSha === null) return [];
  const base = mergeBase(store, pull.baseSha, pull.headSha);
  const baseTree = base === null ? null : treeShaOfCommit(store, base);
  const headTree = treeShaOfCommit(store, pull.headSha);
  if (headTree === null) return [];
  const baseMap = baseTree === null ? new Map() : flattenTree(store, baseTree);
  const headMap = flattenTree(store, headTree);
  const paths = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
  const out: { path: string }[] = [];
  for (const path of [...paths].sort()) {
    const b = baseMap.get(path);
    const h = headMap.get(path);
    if (b !== undefined && h !== undefined && b.sha === h.sha) continue;
    out.push({ path });
  }
  return out;
}

function computeMergeable(store: Store, pull: Pull, repo: Repo): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  if (headSha === null || baseSha === null) return 'UNKNOWN';
  const base = mergeBase(store, baseSha, headSha);
  if (base === null) return 'CONFLICTING';
  const baseTree = treeShaOfCommit(store, base);
  const oursTree = treeShaOfCommit(store, baseSha);
  const theirsTree = treeShaOfCommit(store, headSha);
  if (baseTree === null || oursTree === null || theirsTree === null) return 'UNKNOWN';
  return mergeTrees(store, baseTree, oursTree, theirsTree).conflicts.length === 0 ? 'MERGEABLE' : 'CONFLICTING';
}

function doMerge(store: Store, repo: Repo, pull: Pull): string | null {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  if (headSha === null || baseSha === null) return null;
  const base = mergeBase(store, baseSha, headSha);
  if (base === null) return null;
  const baseTree = treeShaOfCommit(store, base);
  const oursTree = treeShaOfCommit(store, baseSha);
  const theirsTree = treeShaOfCommit(store, headSha);
  if (baseTree === null || oursTree === null || theirsTree === null) return null;
  const merged = mergeTrees(store, baseTree, oursTree, theirsTree);
  if (merged.conflicts.length > 0) return null;
  const message = `Merge pull request #${pull.number} from ${VIEWER_LOGIN}/${pull.headRef}\n\n${pull.title}`;
  const commitSha = makeCommit(store, merged.treeSha, [baseSha], message, VIEWER.name, VIEWER.email, store.clockSec);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeSha = commitSha;
  pull.baseSha = commitSha;
  pull.updatedAt = store.nowIso();
  repo.updatedAt = store.nowIso();
  return commitSha;
}

function findRepoById(store: Store, id: number): Repo | null {
  for (const repo of store.repos.values()) {
    if (repo.id === id) return repo;
  }
  return null;
}

function findIssueByNodeId(store: Store, nodeIdStr: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseNodeId(nodeIdStr);
  if (parsed === null || parsed.kind !== 'Issue') return null;
  const parts = parsed.id.split(':');
  const repoId = Number(parts[0]);
  const number = Number(parts[1]);
  if (!Number.isInteger(repoId) || !Number.isInteger(number)) return null;
  const repo = findRepoById(store, repoId);
  if (repo === null) return null;
  const issue = repo.issues.get(number) ?? null;
  if (issue === null) return null;
  return { repo, issue };
}

function findPullByNodeId(store: Store, nodeIdStr: string): { repo: Repo; pull: Pull } | null {
  const parsed = parseNodeId(nodeIdStr);
  if (parsed === null || parsed.kind !== 'PullRequest') return null;
  const parts = parsed.id.split(':');
  const repoId = Number(parts[0]);
  const number = Number(parts[1]);
  if (!Number.isInteger(repoId) || !Number.isInteger(number)) return null;
  const repo = findRepoById(store, repoId);
  if (repo === null) return null;
  const pull = repo.pulls.get(number) ?? null;
  if (pull === null) return null;
  return { repo, pull };
}

// Cursor: base64 of "cursor:<index>" into an ordered list.
function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}
function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m === null ? -1 : Number(m[1]);
  } catch {
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

type NodeValue =
  | { type: 'query' }
  | { type: 'mutation' }
  | { type: 'repository'; repo: Repo }
  | { type: 'issue'; repo: Repo; issue: Issue }
  | { type: 'pull'; repo: Repo; pull: Pull }
  | { type: 'user'; login: string; id: number }
  | { type: 'ref'; repo: Repo; name: string; sha: string | null }
  | { type: 'issueConnection'; repo: Repo; issues: Issue[] }
  | { type: 'pullConnection'; repo: Repo; pulls: Pull[] }
  | { type: 'fileConnection'; files: { path: string }[] }
  | { type: 'comment'; repo: Repo; issue: Issue; id: number; body: string }
  | { type: 'commentEdge'; repo: Repo; issue: Issue; id: number; body: string }
  | { type: 'pageInfo'; hasNextPage: boolean; endCursor: string | null; startCursor: string | null }
  | { type: 'introspectionType'; name: string }
  | { type: 'introspectionSchema' };

const TYPE_NAME_OF_NODE: Record<string, string> = {
  query: 'Query',
  mutation: 'Mutation',
  repository: 'Repository',
  issue: 'Issue',
  pull: 'PullRequest',
  user: 'User',
  ref: 'Ref',
  issueConnection: 'IssueConnection',
  pullConnection: 'PullRequestConnection',
  fileConnection: 'PullRequestChangedFileConnection',
  comment: 'IssueComment',
  commentEdge: 'IssueCommentEdge',
  pageInfo: 'PageInfo',
  introspectionType: '__Type',
  introspectionSchema: '__Schema',
};

class Executor {
  readonly errors: { message: string }[] = [];
  private readonly store: Store;
  constructor(store: Store) { this.store = store; }

  resolveSelections(node: NodeValue, selections: SelectionNode[], variables: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const sel of selections) {
      if (sel.kind === 'fragment') {
        const typeName = TYPE_NAME_OF_NODE[node.type] ?? '';
        if (sel.typeCondition !== null && sel.typeCondition !== typeName) continue;
        Object.assign(out, this.resolveSelections(node, sel.selections, variables));
        continue;
      }
      const value = this.resolveField(node, sel, variables);
      out[sel.alias] = value;
    }
    return out;
  }

  private unknownField(node: NodeValue, field: FieldNode): null {
    const typeName = TYPE_NAME_OF_NODE[node.type] ?? node.type;
    this.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return null;
  }

  private resolveField(node: NodeValue, field: FieldNode, variables: Record<string, unknown>): unknown {
    const args = argsOf(field, variables);
    const subs = field.selections;
    const store = this.store;

    switch (node.type) {
      case 'query': {
        if (field.name === 'viewer') {
          if (subs.length === 0) return { login: VIEWER_LOGIN };
          return this.resolveSelections({ type: 'user', login: VIEWER_LOGIN, id: VIEWER.id }, subs, variables);
        }
        if (field.name === 'repository') {
          const owner = args.owner;
          const name = args.name;
          if (typeof owner !== 'string' || typeof name !== 'string') {
            this.errors.push({ message: 'repository requires owner and name arguments.' });
            return null;
          }
          if (owner !== VIEWER_LOGIN) return null;
          const repo = store.getRepo(owner, name) ?? null;
          if (repo === null) return null;
          if (subs.length === 0) return {};
          return this.resolveSelections({ type: 'repository', repo }, subs, variables);
        }
        if (field.name === 'node') {
          const id = args.id;
          if (typeof id !== 'string') {
            this.errors.push({ message: 'node requires an id argument.' });
            return null;
          }
          const parsed = parseNodeId(id);
          if (parsed === null) return null;
          if (parsed.kind === 'Repository') {
            const repo = findRepoById(store, Number(parsed.id));
            if (repo === null) return null;
            if (subs.length === 0) return { id };
            return this.resolveSelections({ type: 'repository', repo }, subs, variables);
          }
          if (parsed.kind === 'Issue') {
            const found = findIssueByNodeId(store, id);
            if (found === null) return null;
            if (subs.length === 0) return { id };
            return this.resolveSelections({ type: 'issue', repo: found.repo, issue: found.issue }, subs, variables);
          }
          if (parsed.kind === 'PullRequest') {
            const found = findPullByNodeId(store, id);
            if (found === null) return null;
            if (subs.length === 0) return { id };
            return this.resolveSelections({ type: 'pull', repo: found.repo, pull: found.pull }, subs, variables);
          }
          return null;
        }
        if (field.name === '__type') {
          const name = args.name;
          if (typeof name !== 'string') return null;
          if (subs.length === 0) return { name };
          return this.resolveSelections({ type: 'introspectionType', name }, subs, variables);
        }
        if (field.name === '__schema') {
          if (subs.length === 0) return {};
          return this.resolveSelections({ type: 'introspectionSchema' }, subs, variables);
        }
        return this.unknownField(node, field);
      }

      case 'mutation': {
        if (field.name === 'createIssue') return this.mutationCreateIssue(args, subs, variables);
        if (field.name === 'closeIssue') return this.mutationCloseIssue(args, subs, variables);
        if (field.name === 'createPullRequest') return this.mutationCreatePullRequest(args, subs, variables);
        if (field.name === 'mergePullRequest') return this.mutationMergePullRequest(args, subs, variables);
        if (field.name === 'addComment') return this.mutationAddComment(args, subs, variables);
        return this.unknownField(node, field);
      }

      case 'repository': {
        const repo = node.repo;
        switch (field.name) {
          case 'id': return repoNodeId(repo);
          case 'databaseId': return repo.id;
          case 'name': return repo.name;
          case 'nameWithOwner': return repo.fullName;
          case 'owner': return subs.length === 0 ? { login: repo.owner } : this.resolveSelections({ type: 'user', login: repo.owner, id: VIEWER.id }, subs, variables);
          case 'defaultBranchRef': {
            const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
            if (sha === null) return null;
            if (subs.length === 0) return { name: repo.defaultBranch };
            return this.resolveSelections({ type: 'ref', repo, name: repo.defaultBranch, sha }, subs, variables);
          }
          case 'viewerPermission': return 'ADMIN';
          case 'hasIssuesEnabled': return true;
          case 'description': return repo.description;
          case 'createdAt': return repo.createdAt;
          case 'updatedAt': return repo.updatedAt;
          case 'url': return `https://github.com/${repo.fullName}`;
          case 'issue': {
            const number = args.number;
            if (typeof number !== 'number') return null;
            const issue = repo.issues.get(number) ?? null;
            if (issue === null) return null;
            if (subs.length === 0) return { number };
            return this.resolveSelections({ type: 'issue', repo, issue }, subs, variables);
          }
          case 'issues': {
            let list = [...repo.issues.values()];
            const states = args.states;
            if (Array.isArray(states)) {
              const wanted = new Set(states.map((s) => String(s).toUpperCase()));
              list = list.filter((i) => wanted.has(i.state.toUpperCase()));
            }
            const orderBy = isObject(args.orderBy) ? args.orderBy : {};
            const orderField = String(orderBy.field ?? 'CREATED_AT').toUpperCase();
            const orderDir = String(orderBy.direction ?? 'DESC').toUpperCase();
            list.sort((a, b) => {
              let cmp = 0;
              if (orderField === 'UPDATED_AT') cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.number - b.number;
              else if (orderField === 'COMMENTS') cmp = a.comments.length - b.comments.length || a.number - b.number;
              else cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number;
              return orderDir === 'ASC' ? cmp : -cmp;
            });
            return this.connection({ type: 'issueConnection', repo, issues: list }, args, subs, variables, (n) => ({ type: 'issue', repo, issue: n } as NodeValue));
          }
          case 'pullRequests': {
            let list = [...repo.pulls.values()];
            const states = args.states;
            if (Array.isArray(states)) {
              const wanted = new Set(states.map((s) => String(s).toUpperCase()));
              list = list.filter((p) => wanted.has(pullState(p)));
            } else {
              list = list.filter((p) => p.state === 'open');
            }
            list.sort((a, b) => b.number - a.number);
            return this.connection({ type: 'pullConnection', repo, pulls: list }, args, subs, variables, (n) => ({ type: 'pull', repo, pull: n } as NodeValue));
          }
          case 'pullRequest': {
            const number = args.number;
            if (typeof number !== 'number') return null;
            const pull = repo.pulls.get(number) ?? null;
            if (pull === null) return null;
            if (subs.length === 0) return { number };
            return this.resolveSelections({ type: 'pull', repo, pull }, subs, variables);
          }
          default: return this.unknownField(node, field);
        }
      }

      case 'issue': {
        const issue = node.issue;
        switch (field.name) {
          case 'id': return issueNodeId(node.repo, issue);
          case 'number': return issue.number;
          case 'title': return issue.title;
          case 'state': return issue.state.toUpperCase();
          case 'body': return issue.body;
          case 'createdAt': return issue.createdAt;
          case 'updatedAt': return issue.updatedAt;
          case 'url': return `https://github.com/${node.repo.fullName}/issues/${issue.number}`;
          case 'author': return subs.length === 0 ? { login: issue.user.login } : this.resolveSelections({ type: 'user', login: issue.user.login, id: issue.user.id }, subs, variables);
          case 'labels': return issue.labels.map((name) => ({ name }));
          case 'comments': {
            const nodes = issue.comments.map((c) => ({ type: 'comment', repo: node.repo, issue, id: c.id, body: c.body } as NodeValue));
            return this.genericConnection(nodes, args, subs, variables);
          }
          case 'repository': return subs.length === 0 ? { name: node.repo.name } : this.resolveSelections({ type: 'repository', repo: node.repo }, subs, variables);
          default: return this.unknownField(node, field);
        }
      }

      case 'pull': {
        const pull = node.pull;
        switch (field.name) {
          case 'id': return pullNodeId(node.repo, pull);
          case 'number': return pull.number;
          case 'title': return pull.title;
          case 'body': return pull.body;
          case 'state': return pullState(pull);
          case 'merged': return pull.merged;
          case 'mergeable': return computeMergeable(store, pull, node.repo);
          case 'headRefName': return pull.headRef;
          case 'baseRefName': return pull.baseRef;
          case 'headRef': {
            if (subs.length === 0) return { name: pull.headRef };
            return this.resolveSelections({ type: 'ref', repo: node.repo, name: pull.headRef, sha: pull.headSha }, subs, variables);
          }
          case 'baseRef': {
            if (subs.length === 0) return { name: pull.baseRef };
            return this.resolveSelections({ type: 'ref', repo: node.repo, name: pull.baseRef, sha: pull.baseSha }, subs, variables);
          }
          case 'files': {
            const files = pullFiles(store, pull);
            const first = typeof args.first === 'number' ? args.first : files.length;
            const sliced = files.slice(0, first);
            if (subs.length === 0) return { nodes: sliced.map((f) => ({ path: f.path })) };
            const out: Record<string, unknown> = {};
            for (const sel of subs) {
              if (sel.kind === 'fragment') continue;
              if (sel.name === 'nodes') {
                out[sel.alias] = sliced.map((f) => {
                  const fileObj: Record<string, unknown> = {};
                  for (const fsel of sel.selections) {
                    if (fsel.kind !== 'field') continue;
                    if (fsel.name === 'path') fileObj[fsel.alias] = f.path;
                    else if (fsel.name === 'additions' || fsel.name === 'deletions') fileObj[fsel.alias] = 0;
                    else if (fsel.name === 'changeType') fileObj[fsel.alias] = 'ADDED';
                    else fileObj[fsel.alias] = null;
                  }
                  return fileObj;
                });
              } else if (sel.name === 'totalCount') out[sel.alias] = files.length;
              else if (sel.name === 'pageInfo') out[sel.alias] = this.resolveSelections({ type: 'pageInfo', hasNextPage: files.length > first, endCursor: null, startCursor: null }, sel.selections, variables);
              else this.unknownField({ type: 'fileConnection', files }, sel);
            }
            return out;
          }
          case 'createdAt': return pull.createdAt;
          case 'updatedAt': return pull.updatedAt;
          case 'url': return `https://github.com/${node.repo.fullName}/pull/${pull.number}`;
          case 'author': return subs.length === 0 ? { login: pull.user.login } : this.resolveSelections({ type: 'user', login: pull.user.login, id: pull.user.id }, subs, variables);
          case 'mergedAt': return pull.merged ? pull.updatedAt : null;
          case 'mergeCommit': return pull.mergeSha === null ? null : { oid: pull.mergeSha };
          default: return this.unknownField(node, field);
        }
      }

      case 'user': {
        switch (field.name) {
          case 'id': return nodeId('User', node.id);
          case 'login': return node.login;
          case 'name': return node.login === VIEWER_LOGIN ? VIEWER.name : node.login;
          case 'email': return node.login === VIEWER_LOGIN ? VIEWER.email : null;
          case 'avatarUrl': return '';
          default: return this.unknownField(node, field);
        }
      }

      case 'ref': {
        switch (field.name) {
          case 'id': return nodeId('Ref', `${node.repo.id}:${node.name}`);
          case 'name': return node.name;
          case 'target': return node.sha === null ? null : { oid: node.sha };
          case 'repository': return subs.length === 0 ? { name: node.repo.name } : this.resolveSelections({ type: 'repository', repo: node.repo }, subs, variables);
          default: return this.unknownField(node, field);
        }
      }

      case 'issueConnection': case 'pullConnection': {
        // Resolved via connection() directly; reaching here means a bare field request.
        return this.unknownField(node, field);
      }

      case 'fileConnection': {
        // A single changed-file node is handled inline in the pull.files branch.
        return this.unknownField(node, field);
      }

      case 'comment': {
        switch (field.name) {
          case 'id': return nodeId('IssueComment', node.id);
          case 'body': return node.body;
          case 'author': return { login: VIEWER_LOGIN };
          case 'createdAt': return node.issue.createdAt;
          case 'updatedAt': return node.issue.updatedAt;
          default: return this.unknownField(node, field);
        }
      }

      case 'commentEdge': {
        if (field.name === 'node') {
          if (subs.length === 0) return { id: nodeId('IssueComment', node.id), body: node.body };
          return this.resolveSelections({ type: 'comment', repo: node.repo, issue: node.issue, id: node.id, body: node.body }, subs, variables);
        }
        if (field.name === 'cursor') return encodeCursor(node.id);
        return this.unknownField(node, field);
      }

      case 'pageInfo': {
        switch (field.name) {
          case 'hasNextPage': return node.hasNextPage;
          case 'hasPreviousPage': return false;
          case 'startCursor': return node.startCursor;
          case 'endCursor': return node.endCursor;
          default: return this.unknownField(node, field);
        }
      }

      case 'introspectionType': {
        const name = node.name;
        switch (field.name) {
          case 'name': return name;
          case 'kind': return ENUM_VALUES[name] !== undefined ? 'ENUM' : OBJECT_FIELDS[name] !== undefined ? 'OBJECT' : null;
          case 'description': return null;
          case 'fields': {
            const fields = OBJECT_FIELDS[name];
            if (fields === undefined) return null;
            return fields.map((n) => ({ name: n }));
          }
          case 'enumValues': {
            const values = ENUM_VALUES[name];
            if (values === undefined) return null;
            return values.map((n) => ({ name: n }));
          }
          default: return this.unknownField(node, field);
        }
      }

      case 'introspectionSchema': {
        switch (field.name) {
          case 'queryType': return { name: 'Query' };
          case 'mutationType': return { name: 'Mutation' };
          case 'subscriptionType': return null;
          case 'types': {
            const types: { name: string }[] = [];
            for (const name of Object.keys(OBJECT_FIELDS)) types.push({ name });
            for (const name of Object.keys(ENUM_VALUES)) types.push({ name });
            return types;
          }
          case 'directives': return [];
          default: return this.unknownField(node, field);
        }
      }

      default:
        return this.unknownField(node, field);
    }
  }

  /** Resolve a connection (issues/pulls): apply first/after, build nodes + pageInfo. */
  private connection<T>(
    connNode: NodeValue,
    args: Record<string, unknown>,
    subs: SelectionNode[],
    variables: Record<string, unknown>,
    wrap: (item: T) => NodeValue,
  ): Record<string, unknown> {
    const items: T[] = connNode.type === 'issueConnection'
      ? (connNode as { issues: T[] }).issues
      : (connNode as { pulls: T[] }).pulls;
    const afterIndex = decodeCursor(args.after);
    const start = afterIndex + 1;
    const first = typeof args.first === 'number' ? args.first : items.length;
    const sliced = items.slice(start, start + first);
    const hasNextPage = start + sliced.length < items.length;
    const endCursor = sliced.length === 0 ? null : encodeCursor(start + sliced.length - 1);
    const startCursor = sliced.length === 0 ? null : encodeCursor(start);
    const out: Record<string, unknown> = {};
    for (const sel of subs) {
      if (sel.kind === 'fragment') continue;
      if (sel.name === 'nodes') {
        out[sel.alias] = sliced.map((item) => this.resolveSelections(wrap(item), sel.selections, variables));
      } else if (sel.name === 'edges') {
        out[sel.alias] = sliced.map((item, i) => {
          const edge: Record<string, unknown> = { cursor: encodeCursor(start + i) };
          if (sel.selections.length > 0) {
            const nodeSel = sel.selections.find((s) => s.kind === 'field' && s.name === 'node');
            if (nodeSel !== undefined && nodeSel.kind === 'field') edge.node = this.resolveSelections(wrap(item), nodeSel.selections, variables);
          }
          return edge;
        });
      } else if (sel.name === 'pageInfo') {
        out[sel.alias] = this.resolveSelections({ type: 'pageInfo', hasNextPage, endCursor, startCursor }, sel.selections, variables);
      } else if (sel.name === 'totalCount') {
        out[sel.alias] = items.length;
      } else {
        this.unknownField(connNode, sel);
        out[sel.alias] = null;
      }
    }
    return out;
  }

  private genericConnection(nodes: NodeValue[], args: Record<string, unknown>, subs: SelectionNode[], variables: Record<string, unknown>): Record<string, unknown> {
    const afterIndex = decodeCursor(args.after);
    const start = afterIndex + 1;
    const first = typeof args.first === 'number' ? args.first : nodes.length;
    const sliced = nodes.slice(start, start + first);
    const hasNextPage = start + sliced.length < nodes.length;
    const endCursor = sliced.length === 0 ? null : encodeCursor(start + sliced.length - 1);
    const startCursor = sliced.length === 0 ? null : encodeCursor(start);
    const out: Record<string, unknown> = {};
    for (const sel of subs) {
      if (sel.kind === 'fragment') continue;
      if (sel.name === 'nodes') out[sel.alias] = sliced.map((n) => this.resolveSelections(n, sel.selections, variables));
      else if (sel.name === 'pageInfo') out[sel.alias] = this.resolveSelections({ type: 'pageInfo', hasNextPage, endCursor, startCursor }, sel.selections, variables);
      else if (sel.name === 'totalCount') out[sel.alias] = nodes.length;
      else out[sel.alias] = null;
    }
    return out;
  }

  // ---- Mutations ----

  private mutationCreateIssue(args: Record<string, unknown>, subs: SelectionNode[], variables: Record<string, unknown>): unknown {
    const input = isObject(args.input) ? args.input : {};
    const repositoryId = input.repositoryId;
    if (typeof repositoryId !== 'string') {
      this.errors.push({ message: 'createIssue requires input.repositoryId.' });
      return null;
    }
    const parsed = parseNodeId(repositoryId);
    if (parsed === null || parsed.kind !== 'Repository') {
      this.errors.push({ message: 'createIssue: repositoryId is not a Repository node id.' });
      return null;
    }
    const repo = findRepoById(this.store, Number(parsed.id));
    if (repo === null) {
      this.errors.push({ message: 'createIssue: repository not found.' });
      return null;
    }
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    repo.issueSeq += 1;
    this.store.issueIdSeq += 1;
    const now = this.store.nowIso();
    const issue: Issue = { id: this.store.issueIdSeq, number: repo.issueSeq, title, body, state: 'open', labels: [], user: VIEWER, createdAt: now, updatedAt: now, comments: [] };
    repo.issues.set(issue.number, issue);
    return this.mutationPayload(subs, variables, 'issue', { type: 'issue', repo, issue } as NodeValue);
  }

  private mutationPayload(subs: SelectionNode[], variables: Record<string, unknown>, fieldName: string, payloadNode: NodeValue): Record<string, unknown> {
    void fieldName;
    const out: Record<string, unknown> = {};
    for (const sel of subs) {
      if (sel.kind === 'fragment') continue;
      // The payload object has one field (issue / pullRequest / commentEdge); resolve it.
      out[sel.alias] = this.resolveMutationField(sel, variables, payloadNode);
    }
    return out;
  }

  private resolveMutationField(field: FieldNode, variables: Record<string, unknown>, payloadNode: NodeValue): unknown {
    if (payloadNode.type === 'issue') {
      if (field.name === 'issue') return this.resolveSelections(payloadNode, field.selections, variables);
      this.errors.push({ message: `Cannot query field "${field.name}" on type "CreateIssuePayload".` });
      return null;
    }
    if (payloadNode.type === 'pull') {
      if (field.name === 'pullRequest') return this.resolveSelections(payloadNode, field.selections, variables);
      this.errors.push({ message: `Cannot query field "${field.name}" on type "CreatePullRequestPayload".` });
      return null;
    }
    if (payloadNode.type === 'commentEdge') {
      if (field.name === 'commentEdge') return this.resolveSelections(payloadNode, field.selections, variables);
      this.errors.push({ message: `Cannot query field "${field.name}" on type "AddCommentPayload".` });
      return null;
    }
    return null;
  }

  private mutationCloseIssue(args: Record<string, unknown>, subs: SelectionNode[], variables: Record<string, unknown>): unknown {
    const input = isObject(args.input) ? args.input : {};
    const issueId = input.issueId;
    if (typeof issueId !== 'string') {
      this.errors.push({ message: 'closeIssue requires input.issueId.' });
      return null;
    }
    const found = findIssueByNodeId(this.store, issueId);
    if (found === null) {
      this.errors.push({ message: 'closeIssue: issue not found.' });
      return null;
    }
    found.issue.state = 'closed';
    found.issue.updatedAt = this.store.nowIso();
    return this.mutationPayload(subs, variables, 'issue', { type: 'issue', repo: found.repo, issue: found.issue });
  }

  private mutationCreatePullRequest(args: Record<string, unknown>, subs: SelectionNode[], variables: Record<string, unknown>): unknown {
    const input = isObject(args.input) ? args.input : {};
    const repositoryId = input.repositoryId;
    if (typeof repositoryId !== 'string') {
      this.errors.push({ message: 'createPullRequest requires input.repositoryId.' });
      return null;
    }
    const parsed = parseNodeId(repositoryId);
    if (parsed === null || parsed.kind !== 'Repository') {
      this.errors.push({ message: 'createPullRequest: repositoryId is not a Repository node id.' });
      return null;
    }
    const repo = findRepoById(this.store, Number(parsed.id));
    if (repo === null) {
      this.errors.push({ message: 'createPullRequest: repository not found.' });
      return null;
    }
    const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
    const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    const headSha = repo.refs.get(`refs/heads/${headRefName}`) ?? null;
    const baseSha = repo.refs.get(`refs/heads/${baseRefName}`) ?? null;
    if (headSha === null || baseSha === null) {
      this.errors.push({ message: 'createPullRequest: head or base branch does not exist.' });
      return null;
    }
    const existing = [...repo.pulls.values()].find((p) => p.state === 'open' && p.headRef === headRefName && p.baseRef === baseRefName);
    if (existing !== undefined) {
      this.errors.push({ message: 'createPullRequest: a pull request already exists for this head and base.' });
      return null;
    }
    repo.pullSeq += 1;
    this.store.pullIdSeq += 1;
    const now = this.store.nowIso();
    const pull: Pull = { id: this.store.pullIdSeq, number: repo.pullSeq, title, body, state: 'open', merged: false, headRef: headRefName, baseRef: baseRefName, headSha, baseSha, mergeSha: null, user: VIEWER, createdAt: now, updatedAt: now };
    repo.pulls.set(pull.number, pull);
    return this.mutationPayload(subs, variables, 'pullRequest', { type: 'pull', repo, pull });
  }

  private mutationMergePullRequest(args: Record<string, unknown>, subs: SelectionNode[], variables: Record<string, unknown>): unknown {
    const input = isObject(args.input) ? args.input : {};
    const pullRequestId = input.pullRequestId;
    if (typeof pullRequestId !== 'string') {
      this.errors.push({ message: 'mergePullRequest requires input.pullRequestId.' });
      return null;
    }
    const found = findPullByNodeId(this.store, pullRequestId);
    if (found === null) {
      this.errors.push({ message: 'mergePullRequest: pull request not found.' });
      return null;
    }
    if (found.pull.merged) {
      this.errors.push({ message: 'mergePullRequest: pull request is already merged.' });
      return null;
    }
    const sha = doMerge(this.store, found.repo, found.pull);
    if (sha === null) {
      this.errors.push({ message: 'mergePullRequest: merge conflict.' });
      return null;
    }
    return this.mutationPayload(subs, variables, 'pullRequest', { type: 'pull', repo: found.repo, pull: found.pull });
  }

  private mutationAddComment(args: Record<string, unknown>, subs: SelectionNode[], variables: Record<string, unknown>): unknown {
    const input = isObject(args.input) ? args.input : {};
    const subjectId = input.subjectId;
    const body = typeof input.body === 'string' ? input.body : '';
    if (typeof subjectId !== 'string') {
      this.errors.push({ message: 'addComment requires input.subjectId.' });
      return null;
    }
    const found = findIssueByNodeId(this.store, subjectId);
    if (found === null) {
      this.errors.push({ message: 'addComment: subject not found.' });
      return null;
    }
    this.store.commentSeq += 1;
    const now = this.store.nowIso();
    const comment = { id: this.store.commentSeq, body, user: VIEWER, createdAt: now, updatedAt: now };
    found.issue.comments.push(comment);
    const edgeNode = { type: 'commentEdge', repo: found.repo, issue: found.issue, id: comment.id, body } as NodeValue;
    return this.mutationPayload(subs, variables, 'commentEdge', edgeNode);
  }
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
}

// File nodes inside pullRequest.files: resolved inline in the pull branch above.
// The executor's 'fileNode' pseudo-type is handled by a small shim in resolveSelections:
// pull.files builds its nodes directly, so no separate resolver is needed.

function runOperation(store: Store, query: string, variables: Record<string, unknown>, operationName?: string): { data: unknown; errors?: { message: string }[] } {
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let op: Operation | undefined;
  if (operationName !== undefined) op = operations.find((o) => o.name === operationName);
  if (op === undefined) op = operations[0];
  if (op === undefined) return { data: null, errors: [{ message: 'No operation in GraphQL document.' }] };
  const vars: Record<string, unknown> = { ...variables };
  for (const def of op.varDefs) {
    if (!(def.name in vars) && def.defaultValue !== null) vars[def.name] = evalValue(def.defaultValue, vars);
  }
  const executor = new Executor(store);
  const root: NodeValue = op.type === 'mutation' ? { type: 'mutation' } : { type: 'query' };
  const data = executor.resolveSelections(root, op.selections, vars);
  if (executor.errors.length > 0) return { data, errors: executor.errors };
  return { data };
}

export async function handleGraphql(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const path = pathOf(req);
  if (path !== '/api/graphql') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, store, 405, { errors: [{ message: 'GraphQL requires POST.' }] });
    return true;
  }
  if (!isAuthorized(req)) {
    sendJson(res, store, 401, { message: 'Requires authentication' });
    return true;
  }
  const raw = await readBody(req);
  if (raw === null || raw.length === 0) {
    sendJson(res, store, 400, { errors: [{ message: 'Request body is required.' }] });
    return true;
  }
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendJson(res, store, 400, { errors: [{ message: 'Problems parsing JSON.' }] });
    return true;
  }
  const value = parsed.value;
  // Batched operations: a JSON array of {query, variables, operationName}.
  if (Array.isArray(value)) {
    const results = value.map((entry) => {
      if (!isObject(entry) || typeof entry.query !== 'string') {
        return { data: null, errors: [{ message: 'Each batched operation needs a query string.' }] };
      }
      const vars = isObject(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
      const opName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
      return runOperation(store, entry.query, vars, opName);
    });
    sendJson(res, store, 200, results);
    return true;
  }
  if (!isObject(value) || typeof value.query !== 'string') {
    sendJson(res, store, 400, { errors: [{ message: 'A query string is required.' }] });
    return true;
  }
  const vars = isObject(value.variables) ? (value.variables as Record<string, unknown>) : {};
  const opName = typeof value.operationName === 'string' ? value.operationName : undefined;
  const result = runOperation(store, value.query, vars, opName);
  sendJson(res, store, 200, result);
  return true;
}
