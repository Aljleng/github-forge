// REST v3 surface for the forge: /api/v3/*.
// Uses the shared store (store.ts), HTTP helpers (http.ts) and git objects (gitobj.ts).
// No network, no wall clock, no randomness in responses: timestamps/ids come from store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Issue, Label, Pull, Repo, Store } from './store.ts';
import { VIEWER, VIEWER_LOGIN, isAuthorized, issueNodeId, nodeId, pullNodeId, repoNodeId } from './store.ts';
import { isObject, parseJsonBody, pathOf, queryOf, readBody, sendError, sendJson, strField } from './http.ts';
import {
  getTreeEntry,
  listCommits,
  makeBlob,
  makeCommit,
  mergeTrees,
  parseCommit,
  parseTree,
  readObject,
  setTreeEntry,
} from './gitobj.ts';

type Json = Record<string, unknown>;

const SHA40 = /^[0-9a-f]{40}$/i;

function userObj(): Json {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: nodeId('User', VIEWER.id),
    avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER.id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${VIEWER.login}`,
    html_url: `https://github.com/${VIEWER.login}`,
    type: 'User',
    site_admin: false,
  };
}

function repoObj(repo: Repo): Json {
  return {
    id: repo.id,
    node_id: repoNodeId(repo),
    name: repo.name,
    full_name: repo.fullName,
    owner: userObj(),
    private: repo.private,
    html_url: `https://github.com/${repo.fullName}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.fullName}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://github.com/${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: 0,
    watchers: 0,
    default_branch: repo.defaultBranch,
  };
}

function labelObj(label: Label, repo: Repo): Json {
  return {
    id: 0,
    node_id: nodeId('Label', `${repo.id}:${label.name}`),
    url: `/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function issueObj(repo: Repo, issue: Issue): Json {
  return {
    id: issue.id,
    node_id: issueNodeId(repo, issue),
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.fullName}`,
    labels_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userObj(),
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return l !== undefined ? labelObj(l, repo) : { name, color: 'ededed', description: '' };
    }),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    author_association: 'OWNER',
    state_reason: null,
  };
}

function refObj(repo: Repo, ref: string, sha: string | null): Json {
  return {
    label: `${VIEWER_LOGIN}:${ref}`,
    ref,
    sha: sha ?? '',
    user: userObj(),
    repo: repoObj(repo),
  };
}

/** Merge-base of two commits: first common ancestor found walking b's history. */
function mergeBase(store: Store, a: string, b: string): string | null {
  const ancestorsA = new Set<string>(listCommits(store, a, 10000));
  ancestorsA.add(a);
  for (const sha of listCommits(store, b, 10000)) {
    if (ancestorsA.has(sha)) return sha;
  }
  return ancestorsA.has(b) ? b : null;
}

function treeShaOfCommit(store: Store, commitSha: string): string | null {
  const obj = readObject(store, commitSha);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

/** Flatten a tree (recursively) to path -> {mode, sha}. */
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

function countLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function diffFiles(store: Store, baseTreeSha: string | null, headTreeSha: string): Json[] {
  const base = baseTreeSha === null ? new Map() : flattenTree(store, baseTreeSha);
  const head = flattenTree(store, headTreeSha);
  const files: Json[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h !== undefined && b.sha === h.sha) continue;
    let status: string;
    let additions = 0;
    let deletions = 0;
    const newText = h === undefined ? '' : blobText(store, h.sha);
    const oldText = b === undefined ? '' : blobText(store, b.sha);
    if (b === undefined) {
      status = 'added';
      additions = countLines(newText).length;
    } else if (h === undefined) {
      status = 'removed';
      deletions = countLines(oldText).length;
    } else {
      status = 'modified';
      const newLines = countLines(newText);
      const oldLines = countLines(oldText);
      const oldSet = new Map<string, number>();
      for (const l of oldLines) oldSet.set(l, (oldSet.get(l) ?? 0) + 1);
      for (const l of newLines) {
        const n = oldSet.get(l) ?? 0;
        if (n > 0) oldSet.set(l, n - 1);
        else additions += 1;
      }
      const newSet = new Map<string, number>();
      for (const l of newLines) newSet.set(l, (newSet.get(l) ?? 0) + 1);
      for (const l of oldLines) {
        const n = newSet.get(l) ?? 0;
        if (n > 0) newSet.set(l, n - 1);
        else deletions += 1;
      }
    }
    files.push({
      sha: h !== undefined ? h.sha : b!.sha,
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
      patch: '',
    });
  }
  return files;
}

function blobText(store: Store, sha: string): string {
  const obj = readObject(store, sha);
  if (obj === undefined) return '';
  return obj.data.toString('utf8');
}

/** Compute mergeable for an open pull: true when the 3-way merge has no conflicts. */
function computeMergeable(store: Store, pull: Pull, repo: Repo): boolean | null {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  if (headSha === null || baseSha === null) return null;
  const base = mergeBase(store, baseSha, headSha);
  if (base === null) return false;
  const baseTree = treeShaOfCommit(store, base);
  const oursTree = treeShaOfCommit(store, baseSha);
  const theirsTree = treeShaOfCommit(store, headSha);
  if (baseTree === null || oursTree === null || theirsTree === null) return null;
  return mergeTrees(store, baseTree, oursTree, theirsTree).conflicts.length === 0;
}

function pullObj(store: Store, repo: Repo, pull: Pull): Json {
  const mergeable = pull.merged ? false : computeMergeable(store, pull, repo);
  return {
    id: pull.id,
    node_id: pullNodeId(repo, pull),
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    diff_url: `https://github.com/${repo.fullName}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.fullName}/pull/${pull.number}.patch`,
    issue_url: `/api/v3/repos/${repo.fullName}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.merged ? pull.updatedAt : null,
    merge_commit_sha: pull.mergeSha,
    user: userObj(),
    labels: [],
    milestone: null,
    head: refObj(repo, pull.headRef, repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha),
    base: refObj(repo, pull.baseRef, repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha),
    merged: pull.merged,
    mergeable,
    mergeable_state: pull.merged ? 'unknown' : mergeable === true ? 'clean' : mergeable === false ? 'dirty' : 'unknown',
    merged_by: null,
    comments: 0,
    review_comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    author_association: 'OWNER',
    draft: false,
  };
}

function resolveRef(store: Store, repo: Repo, ref: string): string | null {
  // ref may be a branch name, a full ref, or a commit sha.
  if (SHA40.test(ref)) {
    return readObject(store, ref) !== undefined ? ref : null;
  }
  if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
  return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`) ?? null;
}

function commitObj(store: Store, sha: string): Json | null {
  const obj = readObject(store, sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.data);
  const date = new Date(store.clockSec * 1000).toISOString();
  // Author/committer date from the commit line if parseable, else deterministic clock.
  const authorDate = parseGitDate(parsed.authorLine) ?? date;
  return {
    sha,
    node_id: nodeId('Commit', sha),
    commit: {
      author: { name: VIEWER.name, email: VIEWER.email, date: authorDate },
      committer: { name: VIEWER.name, email: VIEWER.email, date: authorDate },
      message: parsed.message,
      tree: { sha: parsed.tree, url: '' },
      url: '',
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: '',
    html_url: '',
    comments_url: '',
    author: userObj(),
    committer: userObj(),
    parents: parsed.parents.map((p) => ({ sha: p, url: '', html_url: '' })),
  };
}

function parseGitDate(line: string): string | null {
  const m = /(\d{10,}) [+-]\d{4}$/.exec(line);
  if (m === null) return null;
  return new Date(Number(m[1]) * 1000).toISOString();
}

function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; total: number; pageNum: number; perPage: number } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(Math.floor(perPageRaw), 100) : 30;
  const pageRaw = Number(query.get('page') ?? '1');
  const pageNum = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), total: items.length, pageNum, perPage };
}

function linkHeader(req: IncomingMessage, query: URLSearchParams, pageNum: number, perPage: number, total: number): string | null {
  const host = req.headers.host ?? 'localhost';
  const proto = 'http';
  const base = `${proto}://${host}${pathOf(req)}`;
  const links: string[] = [];
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `${base}?${q.toString()}`;
  };
  if (pageNum < totalPages) links.push(`<${urlFor(pageNum + 1)}>; rel="next"`);
  if (pageNum > 1) links.push(`<${urlFor(pageNum - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(totalPages)}>; rel="last"`);
  return links.length === 0 ? null : links.join(', ');
}

function send204(res: ServerResponse, store: Store): void {
  res.writeHead(204, { 'x-github-request-id': store.nextReqId() });
  res.end();
}

/** Read a JSON body; on malformed JSON answer 400 and return null. */
async function readJson(req: IncomingMessage, res: ServerResponse, store: Store): Promise<Record<string, unknown> | null> {
  const body = await readBody(req);
  if (body === null) {
    sendError(res, store, 400, 'Request body too large');
    return null;
  }
  if (body.length === 0) return {};
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    sendError(res, store, 400, 'Problems parsing JSON');
    return null;
  }
  if (!isObject(parsed.value)) {
    sendError(res, store, 400, 'Problems parsing JSON');
    return null;
  }
  return parsed.value;
}

function getRepoOr404(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

/** Create a commit on `branch` (default branch when omitted) changing one path. */
function commitFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  content: string,
  message: string,
  remove: boolean,
): { commitSha: string; blobSha: string | null } {
  const refName = `refs/heads/${branch}`;
  const headSha = repo.refs.get(refName) ?? null;
  const headTree = headSha === null ? null : treeShaOfCommit(store, headSha);
  let newTree: string;
  let blobSha: string | null = null;
  if (remove) {
    newTree = setTreeEntry(store, headTree, path, '100644', null);
  } else {
    blobSha = makeBlob(store, Buffer.from(content, 'utf8'));
    newTree = setTreeEntry(store, headTree, path, '100644', blobSha);
  }
  const parents = headSha === null ? [] : [headSha];
  const commitSha = makeCommit(store, newTree, parents, message, VIEWER.name, VIEWER.email, store.clockSec);
  repo.refs.set(refName, commitSha);
  repo.updatedAt = store.nowIso();
  return { commitSha, blobSha };
}

/** Squash-merge a pull onto its base branch. Returns merge sha or null on conflict. */
function mergePullRequest(store: Store, repo: Repo, pull: Pull): string | null {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  // "Ours" is the CURRENT base-branch tip, not the tip recorded at PR creation:
  // the base may have moved (e.g. another PR merged first), which is exactly
  // what makes a later merge conflict.
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

export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const path = pathOf(req);
  if (!path.startsWith('/api/v3')) return false;
  const method = req.method ?? 'GET';
  const query = queryOf(req);
  const segments = path.split('/').filter((s) => s !== '');

  // Auth on every /api/v3 route.
  if (!isAuthorized(req)) {
    sendError(res, store, 401, 'Requires authentication');
    return true;
  }

  // GET /api/v3 and /api/v3/
  if (segments.length === 2 && method === 'GET') {
    sendJson(res, store, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/meta
  if (segments.length === 3 && segments[2] === 'meta' && method === 'GET') {
    sendJson(res, store, 200, { verifiable_password_authentication: true, installed_version: '1.0.0', git_host: 'github.com' });
    return true;
  }

  // GET/POST /api/v3/user/repos
  if (path === '/api/v3/user/repos' || path === '/api/v3/user/repos/') {
    if (method === 'GET') {
      const repos = [...store.repos.values()].filter((r) => r.owner === VIEWER_LOGIN);
      const { page, total, pageNum, perPage } = paginate(repos, query);
      const headers: Record<string, string> = {};
      const link = linkHeader(req, query, pageNum, perPage, total);
      if (link !== null && pageNum * perPage < total) {
        // Only emit Link when a next page exists (checks parse rel="next").
        const nextLink = link.split(', ').find((l) => l.includes('rel="next"'));
        if (nextLink !== undefined) headers.link = link;
      }
      sendJson(res, store, 200, page.map(repoObj), headers);
      return true;
    }
    if (method === 'POST') {
      const body = await readJson(req, res, store);
      if (body === null) return true;
      const name = strField(body, 'name');
      if (name === undefined || name === '') {
        sendError(res, store, 422, 'Validation Failed: name is required');
        return true;
      }
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) {
        sendError(res, store, 422, 'Repository creation failed: name already exists on this account');
        return true;
      }
      const repo = store.createRepo(name, strField(body, 'description') ?? '', body.private === true);
      sendJson(res, store, 201, repoObj(repo));
      return true;
    }
    sendError(res, store, 404, 'Not Found');
    return true;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 4 && segments[2] === 'repos') {
    const owner = decodeURIComponent(segments[3] ?? '');
    const repoName = decodeURIComponent(segments[4] ?? '');
    const rest = segments.slice(5);
    const repo = getRepoOr404(store, owner, repoName);
    if (repo === null) {
      sendError(res, store, 404, 'Not Found');
      return true;
    }
    const repoPath = `/api/v3/repos/${owner}/${repoName}`;

    // /repos/{o}/{r} itself
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, store, 200, repoObj(repo));
        return true;
      }
      if (method === 'PATCH') {
        const body = await readJson(req, res, store);
        if (body === null) return true;
        const desc = strField(body, 'description');
        if (desc !== undefined) repo.description = desc;
        if (typeof body.private === 'boolean') repo.private = body.private;
        const nb = strField(body, 'default_branch');
        if (nb !== undefined && repo.refs.has(`refs/heads/${nb}`)) repo.defaultBranch = nb;
        repo.updatedAt = store.nowIso();
        sendJson(res, store, 200, repoObj(repo));
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        send204(res, store);
        return true;
      }
      sendError(res, store, 404, 'Not Found');
      return true;
    }

    // POST /git/refs  (create a branch)
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
      const body = await readJson(req, res, store);
      if (body === null) return true;
      const ref = strField(body, 'ref') ?? '';
      const sha = strField(body, 'sha') ?? '';
      if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) {
        sendError(res, store, 422, 'Validation Failed: ref must start with refs/');
        return true;
      }
      if (!SHA40.test(sha) || readObject(store, sha) === undefined) {
        sendError(res, store, 422, 'Validation Failed: sha does not exist');
        return true;
      }
      if (repo.refs.has(ref)) {
        sendError(res, store, 422, 'Validation Failed: ref already exists');
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(res, store, 201, { ref, node_id: nodeId('Ref', `${repo.id}:${ref}`), url: `${repoPath}/git/${ref}`, object: { sha, type: 'commit', url: '' } });
      return true;
    }
    // GET /git/refs/heads/{branch} (not driven by checks, cheap to support)
    if (rest.length >= 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'GET') {
      const ref = rest.slice(2).join('/');
      const sha = repo.refs.get(ref) ?? null;
      if (sha === null) {
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      sendJson(res, store, 201, { ref, object: { sha, type: 'commit', url: '' } });
      return true;
    }

    // GET /branches and /branches/{branch}
    if (rest[0] === 'branches') {
      if (method !== 'GET') {
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      if (rest.length === 1) {
        const branches: Json[] = [];
        for (const [ref, sha] of [...repo.refs.entries()].sort()) {
          if (!ref.startsWith('refs/heads/')) continue;
          branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false });
        }
        sendJson(res, store, 200, branches);
        return true;
      }
      const branch = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`) ?? null;
      if (sha === null) {
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      sendJson(res, store, 200, { name: branch, commit: { sha, url: '' }, protected: false });
      return true;
    }

    // GET /commits and /commits/{sha}
    if (rest[0] === 'commits') {
      if (method !== 'GET') {
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      if (rest.length === 2) {
        const sha = rest[1] ?? '';
        const resolved = resolveRef(store, repo, sha) ?? (SHA40.test(sha) ? sha : null);
        if (resolved === null) {
          sendError(res, store, 404, 'Not Found');
          return true;
        }
        const obj = commitObj(store, resolved);
        if (obj === null) {
          sendError(res, store, 404, 'Not Found');
          return true;
        }
        sendJson(res, store, 200, obj);
        return true;
      }
      const refParam = query.get('sha') ?? repo.defaultBranch;
      const headSha = resolveRef(store, repo, refParam);
      if (headSha === null) {
        sendJson(res, store, 200, []);
        return true;
      }
      const shas = listCommits(store, headSha, 100);
      const commits: Json[] = [];
      for (const sha of shas) {
        const c = commitObj(store, sha);
        if (c !== null) commits.push(c);
      }
      sendJson(res, store, 200, commits);
      return true;
    }

    // /contents/{path...}
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
      const refParam = query.get('ref');
      const branch = refParam ?? repo.defaultBranch;
      if (method === 'GET') {
        const headSha = repo.refs.get(`refs/heads/${branch}`) ?? null;
        if (headSha === null) {
          sendError(res, store, 404, 'Not Found');
          return true;
        }
        const rootTree = treeShaOfCommit(store, headSha);
        if (rootTree === null) {
          sendError(res, store, 404, 'Not Found');
          return true;
        }
        if (filePath === '') {
          // Root directory listing.
          sendJson(res, store, 200, dirListing(store, repo, rootTree, ''));
          return true;
        }
        const entry = getTreeEntry(store, rootTree, filePath);
        if (entry === undefined) {
          sendError(res, store, 404, 'Not Found');
          return true;
        }
        if (entry.mode === '40000') {
          sendJson(res, store, 200, dirListing(store, repo, entry.sha, filePath));
          return true;
        }
        const obj = readObject(store, entry.sha);
        const content = obj === undefined ? Buffer.alloc(0) : obj.data;
        sendJson(res, store, 200, {
          type: 'file',
          encoding: 'base64',
          size: content.length,
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          content: content.toString('base64'),
          sha: entry.sha,
          url: `${repoPath}/contents/${filePath}`,
          git_url: '',
          html_url: `https://github.com/${repo.fullName}/blob/${branch}/${filePath}`,
          download_url: '',
          _links: { self: `${repoPath}/contents/${filePath}`, git: '', html: '' },
        });
        return true;
      }
      if (method === 'PUT') {
        const body = await readJson(req, res, store);
        if (body === null) return true;
        const message = strField(body, 'message') ?? 'Update file';
        const contentB64 = strField(body, 'content');
        if (contentB64 === undefined) {
          sendError(res, store, 422, 'Validation Failed: content is required');
          return true;
        }
        let content: string;
        try {
          content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64').toString('utf8');
        } catch {
          sendError(res, store, 422, 'Validation Failed: content is not valid base64');
          return true;
        }
        const targetBranch = strField(body, 'branch') ?? repo.defaultBranch;
        const headSha = repo.refs.get(`refs/heads/${targetBranch}`) ?? null;
        const rootTree = headSha === null ? null : treeShaOfCommit(store, headSha);
        const existing = rootTree === null ? undefined : getTreeEntry(store, rootTree, filePath);
        const givenSha = strField(body, 'sha');
        if (existing !== undefined) {
          if (givenSha === undefined) {
            sendError(res, store, 422, 'Validation Failed: sha is required to update a file');
            return true;
          }
          if (givenSha.toLowerCase() !== existing.sha.toLowerCase()) {
            sendError(res, store, 409, 'Conflict: sha does not match the current file');
            return true;
          }
          const { commitSha, blobSha } = commitFile(store, repo, targetBranch, filePath, content, message, false);
          sendJson(res, store, 200, {
            content: { name: filePath.split('/').pop(), path: filePath, sha: blobSha, size: Buffer.byteLength(content, 'utf8'), url: '', html_url: '', git_url: '', download_url: '', type: 'file', encoding: 'base64', content: contentB64 },
            commit: { sha: commitSha, message, author: userObj(), committer: userObj() },
          });
          return true;
        }
        const { commitSha, blobSha } = commitFile(store, repo, targetBranch, filePath, content, message, false);
        sendJson(res, store, 201, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: blobSha, size: Buffer.byteLength(content, 'utf8'), url: '', html_url: '', git_url: '', download_url: '', type: 'file', encoding: 'base64', content: contentB64 },
          commit: { sha: commitSha, message, author: userObj(), committer: userObj() },
        });
        return true;
      }
      if (method === 'DELETE') {
        const body = await readJson(req, res, store);
        if (body === null) return true;
        const message = strField(body, 'message') ?? 'Delete file';
        const targetBranch = strField(body, 'branch') ?? repo.defaultBranch;
        const headSha = repo.refs.get(`refs/heads/${targetBranch}`) ?? null;
        if (headSha === null) {
          sendError(res, store, 404, 'Not Found');
          return true;
        }
        const rootTree = treeShaOfCommit(store, headSha);
        if (rootTree === null) {
          sendError(res, store, 404, 'Not Found');
          return true;
        }
        const existing = getTreeEntry(store, rootTree, filePath);
        if (existing === undefined) {
          sendError(res, store, 404, 'Not Found');
          return true;
        }
        const givenSha = strField(body, 'sha');
        if (givenSha !== undefined && givenSha.toLowerCase() !== existing.sha.toLowerCase()) {
          sendError(res, store, 409, 'Conflict: sha does not match the current file');
          return true;
        }
        const { commitSha } = commitFile(store, repo, targetBranch, filePath, '', message, true);
        sendJson(res, store, 200, { commit: { sha: commitSha, message, author: userObj(), committer: userObj() } });
        return true;
      }
      sendError(res, store, 404, 'Not Found');
      return true;
    }

    // POST /labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method === 'POST') {
        const body = await readJson(req, res, store);
        if (body === null) return true;
        const name = strField(body, 'name');
        if (name === undefined || name === '') {
          sendError(res, store, 422, 'Validation Failed: name is required');
          return true;
        }
        if (repo.labels.has(name)) {
          sendError(res, store, 422, 'Validation Failed: label already exists');
          return true;
        }
        const label: Label = { name, color: strField(body, 'color') ?? 'ededed', description: strField(body, 'description') ?? '' };
        repo.labels.set(name, label);
        sendJson(res, store, 201, labelObj(label, repo));
        return true;
      }
      if (method === 'GET') {
        sendJson(res, store, 200, [...repo.labels.values()].map((l) => labelObj(l, repo)));
        return true;
      }
      sendError(res, store, 404, 'Not Found');
      return true;
    }

    // /issues[/{n}[/comments]]
    if (rest[0] === 'issues') {
      // GET/POST /issues
      if (rest.length === 1) {
        if (method === 'GET') {
          let list = [...repo.issues.values()];
          const state = query.get('state') ?? 'open';
          if (state !== 'all') list = list.filter((i) => i.state === state);
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          list.sort((a, b) => {
            let cmp = 0;
            if (sort === 'created') cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number;
            else if (sort === 'updated') cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.number - b.number;
            else cmp = a.number - b.number;
            return direction === 'asc' ? cmp : -cmp;
          });
          const { page, total, pageNum, perPage } = paginate(list, query);
          const headers: Record<string, string> = {};
          const link = linkHeader(req, query, pageNum, perPage, total);
          if (link !== null && pageNum * perPage < total) headers.link = link;
          sendJson(res, store, 200, page.map((i) => issueObj(repo, i)), headers);
          return true;
        }
        if (method === 'POST') {
          const body = await readJson(req, res, store);
          if (body === null) return true;
          const title = strField(body, 'title');
          if (title === undefined || title === '') {
            sendError(res, store, 422, 'Validation Failed: title is required');
            return true;
          }
          const labelNames = parseLabelNames(body.labels);
          for (const name of labelNames) {
            if (!repo.labels.has(name)) {
              sendError(res, store, 422, `Validation Failed: label "${name}" does not exist`);
              return true;
            }
          }
          repo.issueSeq += 1;
          store.issueIdSeq += 1;
          const now = store.nowIso();
          const issue: Issue = {
            id: store.issueIdSeq,
            number: repo.issueSeq,
            title,
            body: strField(body, 'body') ?? '',
            state: 'open',
            labels: labelNames,
            user: VIEWER,
            createdAt: now,
            updatedAt: now,
            comments: [],
          };
          repo.issues.set(issue.number, issue);
          sendJson(res, store, 201, issueObj(repo, issue));
          return true;
        }
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      // /issues/{n}
      const num = Number(rest[1]);
      if (!Number.isInteger(num) || num < 1) {
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      const issue = repo.issues.get(num) ?? null;
      if (issue === null) {
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          sendJson(res, store, 200, issueObj(repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          const body = await readJson(req, res, store);
          if (body === null) return true;
          const title = strField(body, 'title');
          if (title !== undefined) issue.title = title;
          const b = strField(body, 'body');
          if (b !== undefined) issue.body = b;
          const state = strField(body, 'state');
          if (state === 'open' || state === 'closed') issue.state = state;
          if (body.labels !== undefined) {
            const labelNames = parseLabelNames(body.labels);
            for (const name of labelNames) {
              if (!repo.labels.has(name)) {
                sendError(res, store, 422, `Validation Failed: label "${name}" does not exist`);
                return true;
              }
            }
            issue.labels = labelNames;
          }
          issue.updatedAt = store.nowIso();
          sendJson(res, store, 200, issueObj(repo, issue));
          return true;
        }
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      // /issues/{n}/comments
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          const { page } = paginate(issue.comments, query);
          sendJson(res, store, 200, page.map((c) => ({
            id: c.id,
            node_id: nodeId('IssueComment', c.id),
            url: `${repoPath}/issues/${issue.number}/comments/${c.id}`,
            html_url: `https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-${c.id}`,
            body: c.body,
            user: userObj(),
            created_at: c.createdAt,
            updated_at: c.updatedAt,
            author_association: 'OWNER',
          })));
          return true;
        }
        if (method === 'POST') {
          const body = await readJson(req, res, store);
          if (body === null) return true;
          const commentBody = strField(body, 'body');
          if (commentBody === undefined) {
            sendError(res, store, 422, 'Validation Failed: body is required');
            return true;
          }
          store.commentSeq += 1;
          const now = store.nowIso();
          const comment = { id: store.commentSeq, body: commentBody, user: VIEWER, createdAt: now, updatedAt: now };
          issue.comments.push(comment);
          sendJson(res, store, 201, {
            id: comment.id,
            node_id: nodeId('IssueComment', comment.id),
            url: `${repoPath}/issues/${issue.number}/comments/${comment.id}`,
            html_url: `https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
            body: comment.body,
            user: userObj(),
            created_at: comment.createdAt,
            updated_at: comment.updatedAt,
            author_association: 'OWNER',
          });
          return true;
        }
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      sendError(res, store, 404, 'Not Found');
      return true;
    }

    // /pulls[/{n}[/files|/merge]]
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          let list = [...repo.pulls.values()];
          const state = query.get('state') ?? 'open';
          if (state === 'open') list = list.filter((p) => p.state === 'open');
          else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
          list.sort((a, b) => b.number - a.number);
          const { page, total, pageNum, perPage } = paginate(list, query);
          const headers: Record<string, string> = {};
          const link = linkHeader(req, query, pageNum, perPage, total);
          if (link !== null && pageNum * perPage < total) headers.link = link;
          sendJson(res, store, 200, page.map((p) => pullObj(store, repo, p)), headers);
          return true;
        }
        if (method === 'POST') {
          const body = await readJson(req, res, store);
          if (body === null) return true;
          const title = strField(body, 'title');
          const head = strField(body, 'head');
          if (title === undefined || title === '') {
            sendError(res, store, 422, 'Validation Failed: title is required');
            return true;
          }
          if (head === undefined || head === '') {
            sendError(res, store, 422, 'Validation Failed: head is required');
            return true;
          }
          const base = strField(body, 'base') ?? repo.defaultBranch;
          const headSha = repo.refs.get(`refs/heads/${head}`) ?? null;
          const baseSha = repo.refs.get(`refs/heads/${base}`) ?? null;
          if (headSha === null) {
            sendError(res, store, 422, `Validation Failed: head branch "${head}" does not exist`);
            return true;
          }
          if (baseSha === null) {
            sendError(res, store, 422, `Validation Failed: base branch "${base}" does not exist`);
            return true;
          }
          const existing = [...repo.pulls.values()].find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
          if (existing !== undefined) {
            sendError(res, store, 422, 'Validation Failed: A pull request already exists for this head and base');
            return true;
          }
          repo.pullSeq += 1;
          store.pullIdSeq += 1;
          const now = store.nowIso();
          const pull: Pull = {
            id: store.pullIdSeq,
            number: repo.pullSeq,
            title,
            body: strField(body, 'body') ?? '',
            state: 'open',
            merged: false,
            headRef: head,
            baseRef: base,
            headSha,
            baseSha,
            mergeSha: null,
            user: VIEWER,
            createdAt: now,
            updatedAt: now,
          };
          repo.pulls.set(pull.number, pull);
          sendJson(res, store, 201, pullObj(store, repo, pull));
          return true;
        }
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num) || num < 1) {
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      const pull = repo.pulls.get(num) ?? null;
      if (pull === null) {
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          sendJson(res, store, 200, pullObj(store, repo, pull));
          return true;
        }
        sendError(res, store, 404, 'Not Found');
        return true;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (pull.headSha === null || pull.baseSha === null) {
          sendJson(res, store, 200, []);
          return true;
        }
        const base = mergeBase(store, pull.baseSha, pull.headSha);
        const baseTree = base === null ? null : treeShaOfCommit(store, base);
        const headTree = treeShaOfCommit(store, pull.headSha);
        if (headTree === null) {
          sendJson(res, store, 200, []);
          return true;
        }
        sendJson(res, store, 200, diffFiles(store, baseTree, headTree));
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        // Body may be empty; read it (malformed JSON still 400 via readJson only when present).
        const raw = await readBody(req);
        if (raw !== null && raw.length > 0) {
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            sendError(res, store, 400, 'Problems parsing JSON');
            return true;
          }
        }
        if (pull.merged) {
          sendError(res, store, 405, 'Pull Request is already merged');
          return true;
        }
        if (pull.state === 'closed') {
          sendError(res, store, 405, 'Pull Request is closed');
          return true;
        }
        const mergeSha = mergePullRequest(store, repo, pull);
        if (mergeSha === null) {
          sendError(res, store, 405, 'Merge conflict: this branch has conflicts that must be resolved');
          return true;
        }
        sendJson(res, store, 200, { sha: mergeSha, merged: true, message: `Pull Request successfully merged` });
        return true;
      }
      sendError(res, store, 404, 'Not Found');
      return true;
    }

    sendError(res, store, 404, 'Not Found');
    return true;
  }

  // Any other /api/v3 path: unknown route.
  sendError(res, store, 404, 'Not Found');
  return true;
}

function parseLabelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') names.push(entry);
    else if (isObject(entry)) {
      const name = strField(entry, 'name');
      if (name !== undefined) names.push(name);
    }
  }
  return names;
}

function dirListing(store: Store, repo: Repo, treeSha: string, dirPath: string): Json[] {
  const obj = readObject(store, treeSha);
  if (obj === undefined) return [];
  const entries: Json[] = [];
  for (const entry of parseTree(obj.data)) {
    const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    entries.push({
      type: entry.mode === '40000' ? 'dir' : 'file',
      size: entry.mode === '40000' ? 0 : blobSize(store, entry.sha),
      name: entry.name,
      path,
      sha: entry.sha,
      url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
      git_url: '',
      html_url: '',
      download_url: entry.mode === '40000' ? null : '',
      _links: { self: '', git: '', html: '' },
    });
  }
  entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return entries;
}

function blobSize(store: Store, sha: string): number {
  const obj = readObject(store, sha);
  return obj === undefined ? 0 : obj.data.length;
}
