// The MCP endpoint: POST /mcp, JSON-RPC 2.0 over Streamable HTTP (plain JSON answers).
//
// Speaks both protocol eras the suite accepts:
//   modern 2026-07-28: `server/discover` answers identity, capabilities and supportedVersions;
//           every request declares its revision in `_meta`; no handshake, no session.
//   legacy 2025-11-25 and earlier: `initialize` + `notifications/initialized`, optional
//           Mcp-Session-Id; `server/discover` is answered anyway, so the client negotiates modern.
//
// Every tool operates directly on the shared store, so a repo/issue/PR created over MCP is the
// objects must be the SAME objects REST serves (same ids, same fields — operate directly on
// store.repos/store.issues/store.pulls; the serializers below are rest.ts's repoObj/issueObj/
// pullObj field for field). The squash merge is REST's mergePullRequest exactly: same
// merge-base, same trees, same commit message, same state updates.
// No clock, no randomness in responses: timestamps come from store.nowIso(), ids from counters.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Issue, Pull, Repo, Store } from './store.ts';
import { VIEWER, VIEWER_LOGIN, isAuthorized, issueNodeId, nodeId, pullNodeId, repoNodeId } from './store.ts';
import { isObject, pathOf, readBody, sendError, sendJson } from './http.ts';
import { makeCommit, mergeTrees, readObject } from './gitobj.ts';

// ---------------------------------------------------------------- constants

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '0.1.0';
const PREFERRED_REVISION = '2026-07-28';
const SUPPORTED_VERSIONS: readonly string[] = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const UNSUPPORTED_VERSION = -32022;

// ---------------------------------------------------------------- tool catalogue (built once: tools/list is byte-identical every call)

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, "owner/repo".' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, "owner/repo".' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, "owner/repo".' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by issue state.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, "owner/repo".' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch (the branch with the changes).' },
        base: { type: 'string', description: 'The base branch (the branch the changes go into).' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge an open pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, "owner/repo".' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

/** Canonical tool names plus the obvious aliases, normalized (lowercase, alphanumerics only). */
const TOOL_ALIASES: Readonly<Record<string, string>> = {
  createrepo: 'create_repo',
  createrepository: 'create_repo',
  repocreate: 'create_repo',
  reposcreate: 'create_repo',
  repositorycreate: 'create_repo',
  getrepo: 'get_repo',
  getrepository: 'get_repo',
  repoget: 'get_repo',
  reposget: 'get_repo',
  repositoryget: 'get_repo',
  createissue: 'create_issue',
  issuecreate: 'create_issue',
  issuescreate: 'create_issue',
  listissues: 'list_issues',
  issueslist: 'list_issues',
  issuelist: 'list_issues',
  createpullrequest: 'create_pull_request',
  pullrequestcreate: 'create_pull_request',
  pullscreate: 'create_pull_request',
  createpr: 'create_pull_request',
  prcreate: 'create_pull_request',
  mergepullrequest: 'merge_pull_request',
  pullrequestmerge: 'merge_pull_request',
  pullsmerge: 'merge_pull_request',
  mergepr: 'merge_pull_request',
  prmerge: 'merge_pull_request',
};

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The canonical tool for a name, matched by normalized suffix (a server prefix is allowed). */
function resolveToolName(name: string): string | null {
  const normalized = normalizeToolName(name);
  if (normalized === '') return null;
  if (Object.prototype.hasOwnProperty.call(TOOL_ALIASES, normalized)) return TOOL_ALIASES[normalized]!;
  for (const canonical of Object.keys(TOOL_ALIASES)) {
    if (normalized.length > canonical.length && normalized.endsWith(canonical)) return TOOL_ALIASES[canonical]!;
  }
  return null;
}

// ---------------------------------------------------------------- serializers
// The GitHub-shaped objects REST serves (rest.ts repoObj/issueObj/pullObj), field for field
// and in the same key order, so an MCP result and a REST read are the same object.

function userJson(): Record<string, unknown> {
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

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoNodeId(repo),
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(),
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

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  if (label === undefined) return { name, color: 'ededed', description: '' };
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

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
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
    user: userJson(),
    labels: issue.labels.map((name) => labelJson(repo, name)),
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

function refJson(repo: Repo, ref: string, sha: string | null): Record<string, unknown> {
  return {
    label: `${VIEWER_LOGIN}:${ref}`,
    ref,
    sha: sha ?? '',
    user: userJson(),
    repo: repoJson(repo),
  };
}

/** Whether an open pull merges cleanly (REST's computeMergeable); null when unknowable. */
function mergeableOf(store: Store, pull: Pull): boolean | null {
  if (pull.merged) return false;
  const headSha = pull.headSha;
  const baseSha = pull.baseSha;
  if (headSha === null || baseSha === null) return null;
  const base = mergeBaseOf(store, baseSha, headSha);
  if (base === null) return false;
  const baseCommit = commitOf(store, base);
  const oursCommit = commitOf(store, baseSha);
  const theirsCommit = commitOf(store, headSha);
  if (baseCommit === null || oursCommit === null || theirsCommit === null) return null;
  try {
    return mergeTrees(store, baseCommit.tree, oursCommit.tree, theirsCommit.tree).conflicts.length === 0;
  } catch {
    return null;
  }
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const mergeable = mergeableOf(store, pull);
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
    user: userJson(),
    labels: [],
    milestone: null,
    head: refJson(repo, pull.headRef, pull.headSha),
    base: refJson(repo, pull.baseRef, pull.baseSha),
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

// ---------------------------------------------------------------- argument helpers

type Args = Record<string, unknown>;

function strArg(args: Args, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function intArg(args: Args, names: readonly string[]): number | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

/** Split a "owner/repo" full name, or null. */
function splitFullName(value: string | undefined): { owner: string; repo: string } | null {
  if (value === undefined) return null;
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return null;
  return { owner: value.slice(0, slash), repo: value.slice(slash + 1) };
}

/** Owner + repo out of the documented names, their aliases, or full_name. */
function resolveOwnerRepo(args: Args): { owner: string; repo: string } | { missing: string[] } {
  const fullName = strArg(args, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']);
  const split = splitFullName(fullName);
  const owner = strArg(args, ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']) ?? split?.owner;
  const repo = strArg(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name']) ?? split?.repo;
  const missing: string[] = [];
  if (owner === undefined) missing.push('owner');
  if (repo === undefined) missing.push('repo');
  if (missing.length > 0) return { missing };
  return { owner: owner!, repo: repo! };
}

function toolError(text: string): { content: { type: string; text: string }[]; isError: boolean } {
  return { content: [{ type: 'text', text }], isError: true };
}

function toolOk(value: unknown): { content: { type: string; text: string }[]; structuredContent: unknown; isError: boolean } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

function validRepoName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[^\w.-]/.test(name) && !name.includes('..');
}

// ---------------------------------------------------------------- tool implementations (all synchronous on the store)

function doCreateRepo(store: Store, args: Args): ReturnType<typeof toolOk> | ReturnType<typeof toolError> {
  const name = strArg(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']) ?? splitFullName(strArg(args, ['full_name', 'repo_full_name', 'repository_full_name']))?.repo;
  if (name === undefined) return toolError('create_repo: missing required argument: name');
  if (!validRepoName(name)) return toolError(`create_repo: invalid repository name: ${JSON.stringify(name)}`);
  if (store.getRepo(VIEWER.login, name) !== undefined) return toolError(`create_repo: repository ${VIEWER.login}/${name} already exists`);
  const description = strArg(args, ['description', 'about', 'summary', 'body']) ?? '';
  const isPrivate = args.private === true || args.is_private === true;
  const repo = store.createRepo(name, description, isPrivate);
  return toolOk(repoJson(repo));
}

function doGetRepo(store: Store, args: Args): ReturnType<typeof toolOk> | ReturnType<typeof toolError> {
  const resolved = resolveOwnerRepo(args);
  if ('missing' in resolved) return toolError(`get_repo: missing required argument(s): ${resolved.missing.join(', ')}`);
  const repo = store.getRepo(resolved.owner, resolved.repo);
  if (repo === undefined) return toolError(`get_repo: repository ${resolved.owner}/${resolved.repo} not found`);
  return toolOk(repoJson(repo));
}

function doCreateIssue(store: Store, args: Args): ReturnType<typeof toolOk> | ReturnType<typeof toolError> {
  const resolved = resolveOwnerRepo(args);
  const title = strArg(args, ['title', 'issue_title', 'subject']);
  const missing: string[] = [];
  if ('missing' in resolved) missing.push(...resolved.missing);
  if (title === undefined) missing.push('title');
  if (missing.length > 0) return toolError(`create_issue: missing required argument(s): ${missing.join(', ')}`);
  const { owner, repo: repoName } = resolved as { owner: string; repo: string };
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return toolError(`create_issue: repository ${owner}/${repoName} not found`);
  const body = strArg(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']) ?? '';
  const labelsRaw = args.labels;
  const labels: string[] = [];
  if (labelsRaw !== undefined) {
    if (!Array.isArray(labelsRaw) || labelsRaw.some((entry) => typeof entry !== 'string')) {
      return toolError('create_issue: labels must be an array of strings');
    }
    for (const label of labelsRaw as string[]) {
      if (!repo.labels.has(label)) return toolError(`create_issue: unknown label: ${label}`);
      labels.push(label);
    }
  }
  const now = store.nowIso();
  store.issueIdSeq += 1;
  repo.issueSeq += 1;
  const issue: Issue = {
    id: store.issueIdSeq,
    number: repo.issueSeq,
    title: title!,
    body,
    state: 'open',
    labels,
    user: VIEWER,
    createdAt: now,
    updatedAt: now,
    comments: [],
  };
  repo.issues.set(issue.number, issue);
  return toolOk(issueJson(repo, issue));
}

function doListIssues(store: Store, args: Args): ReturnType<typeof toolOk> | ReturnType<typeof toolError> {
  const resolved = resolveOwnerRepo(args);
  if ('missing' in resolved) return toolError(`list_issues: missing required argument(s): ${resolved.missing.join(', ')}`);
  const repo = store.getRepo(resolved.owner, resolved.repo);
  if (repo === undefined) return toolError(`list_issues: repository ${resolved.owner}/${resolved.repo} not found`);
  const state = strArg(args, ['state', 'status']) ?? 'open';
  if (state !== 'open' && state !== 'closed' && state !== 'all') {
    return toolError(`list_issues: invalid state: ${JSON.stringify(state)}`);
  }
  const issues = [...repo.issues.values()]
    .filter((issue) => state === 'all' || issue.state === state)
    .sort((a, b) => a.number - b.number)
    .map((issue) => issueJson(repo, issue));
  return toolOk(issues);
}

function doCreatePullRequest(store: Store, args: Args): ReturnType<typeof toolOk> | ReturnType<typeof toolError> {
  const resolved = resolveOwnerRepo(args);
  const title = strArg(args, ['title', 'pr_title', 'pull_request_title', 'subject']);
  const head = strArg(args, ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch']);
  const base = strArg(args, ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch']);
  const missing: string[] = [];
  if ('missing' in resolved) missing.push(...resolved.missing);
  if (title === undefined) missing.push('title');
  if (head === undefined) missing.push('head');
  if (base === undefined) missing.push('base');
  if (missing.length > 0) return toolError(`create_pull_request: missing required argument(s): ${missing.join(', ')}`);
  const { owner, repo: repoName } = resolved as { owner: string; repo: string };
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return toolError(`create_pull_request: repository ${owner}/${repoName} not found`);
  const headSha = repo.refs.get(`refs/heads/${head!}`);
  if (headSha === undefined) return toolError(`create_pull_request: head branch ${head!} not found`);
  const baseSha = repo.refs.get(`refs/heads/${base!}`);
  if (baseSha === undefined) return toolError(`create_pull_request: base branch ${base!} not found`);
  const body = strArg(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']) ?? '';
  const now = store.nowIso();
  store.pullIdSeq += 1;
  repo.pullSeq += 1;
  const pull: Pull = {
    id: store.pullIdSeq,
    number: repo.pullSeq,
    title: title!,
    body,
    state: 'open',
    merged: false,
    headRef: head!,
    baseRef: base!,
    headSha,
    baseSha,
    mergeSha: null,
    user: VIEWER,
    createdAt: now,
    updatedAt: now,
  };
  repo.pulls.set(pull.number, pull);
  return toolOk(pullJson(store, repo, pull));
}

// ---------------------------------------------------------------- squash merge (gitobj.ts)

interface ParsedCommit {
  tree: string;
  parents: string[];
}

/** The tree sha and parent shas of a commit object, from its header block only. */
function parseCommit(data: Buffer): ParsedCommit | null {
  const text = data.toString('utf8');
  const header = text.split('\n\n', 1)[0] ?? '';
  const tree = /^tree ([0-9a-f]{40})$/m.exec(header)?.[1];
  if (tree === undefined) return null;
  const parents: string[] = [];
  const parentRe = /^parent ([0-9a-f]{40})$/gm;
  let match: RegExpExecArray | null;
  while ((match = parentRe.exec(header)) !== null) parents.push(match[1]!);
  return { tree, parents };
}

function commitOf(store: Store, sha: string): ParsedCommit | null {
  const object = readObject(store, sha);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data);
}

/** All ancestors of `sha` (itself included), breadth-first over parents. */
function ancestorsOf(store: Store, sha: string): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [sha];
  let steps = 0;
  while (queue.length > 0 && steps < 100000) {
    steps += 1;
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const commit = commitOf(store, current);
    if (commit === null) continue;
    for (const parent of commit.parents) if (!seen.has(parent)) queue.push(parent);
  }
  return seen;
}

/** The merge base of two commits: the first common ancestor reached from `headSha`. */
function mergeBaseOf(store: Store, baseSha: string, headSha: string): string | null {
  const baseAncestors = ancestorsOf(store, baseSha);
  const queue: string[] = [headSha];
  const seen = new Set<string>();
  let steps = 0;
  while (queue.length > 0 && steps < 100000) {
    steps += 1;
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (baseAncestors.has(current)) return current;
    const commit = commitOf(store, current);
    if (commit === null) continue;
    for (const parent of commit.parents) if (!seen.has(parent)) queue.push(parent);
  }
  return null;
}

function doMergePullRequest(store: Store, args: Args): ReturnType<typeof toolOk> | ReturnType<typeof toolError> {
  const resolved = resolveOwnerRepo(args);
  const pullNumber = intArg(args, ['pull_number', 'pullNumber', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']);
  const missing: string[] = [];
  if ('missing' in resolved) missing.push(...resolved.missing);
  if (pullNumber === undefined) missing.push('pull_number');
  if (missing.length > 0) return toolError(`merge_pull_request: missing required argument(s): ${missing.join(', ')}`);
  const { owner, repo: repoName } = resolved as { owner: string; repo: string };
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return toolError(`merge_pull_request: repository ${owner}/${repoName} not found`);
  const pull = repo.pulls.get(pullNumber!);
  if (pull === undefined) return toolError(`merge_pull_request: pull request #${pullNumber} not found`);
  if (pull.merged) return toolError(`merge_pull_request: pull request #${pullNumber} is already merged`);
  if (pull.state !== 'open') return toolError(`merge_pull_request: pull request #${pullNumber} is ${pull.state}`);
  // The merge runs on the shas recorded on the pull (as REST does), falling back to the live
  // branch tips only when the pull carries none.
  const baseSha = pull.baseSha ?? repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseSha === undefined) return toolError(`merge_pull_request: base branch ${pull.baseRef} not found`);
  const headSha = pull.headSha ?? repo.refs.get(`refs/heads/${pull.headRef}`);
  if (headSha === undefined) return toolError(`merge_pull_request: head branch ${pull.headRef} not found`);
  const baseCommit = commitOf(store, baseSha);
  const headCommit = commitOf(store, headSha);
  if (baseCommit === null) return toolError(`merge_pull_request: base commit ${baseSha} is not a commit`);
  if (headCommit === undefined || headCommit === null) return toolError(`merge_pull_request: head commit ${headSha} is not a commit`);
  const mergeBaseSha = mergeBaseOf(store, baseSha, headSha);
  if (mergeBaseSha === null) return toolError('merge_pull_request: no merge base between head and base');
  const mergeBaseCommit = commitOf(store, mergeBaseSha);
  if (mergeBaseCommit === null) return toolError('merge_pull_request: merge base is not a commit');
  const baseTreeSha = mergeBaseCommit.tree;
  // A gitobj that throws on a conflict (instead of reporting one) is still a failed merge,
  // not an endpoint failure: answer isError, never a JSON-RPC internal error.
  let merged: { treeSha: string; conflicts: string[] };
  try {
    merged = mergeTrees(store, baseTreeSha, baseCommit.tree, headCommit.tree);
  } catch (error) {
    return toolError(`merge_pull_request: merge failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (merged.conflicts.length > 0) {
    return toolError(`merge_pull_request: merge conflict in ${merged.conflicts.join(', ')}`);
  }
  // The squash commit message, and the state updates, are REST's exactly (rest.ts
  // mergePullRequest): same message, same merge sha for the same merge.
  const message = `Merge pull request #${pull.number} from ${VIEWER_LOGIN}/${pull.headRef}\n\n${pull.title}`;
  let mergeSha: string;
  try {
    mergeSha = makeCommit(store, merged.treeSha, [baseSha], message, VIEWER.name, VIEWER.email, store.clockSec);
  } catch (error) {
    return toolError(`merge_pull_request: merge failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeSha = mergeSha;
  pull.headSha = headSha;
  pull.baseSha = mergeSha;
  pull.updatedAt = store.nowIso();
  repo.updatedAt = store.nowIso();
  return toolOk({
    sha: mergeSha,
    merged: true,
    message,
    pull: pullJson(store, repo, pull),
  });
}

function callTool(store: Store, name: string, args: Args): ReturnType<typeof toolOk> | ReturnType<typeof toolError> {
  switch (name) {
    case 'create_repo':
      return doCreateRepo(store, args);
    case 'get_repo':
      return doGetRepo(store, args);
    case 'create_issue':
      return doCreateIssue(store, args);
    case 'list_issues':
      return doListIssues(store, args);
    case 'create_pull_request':
      return doCreatePullRequest(store, args);
    case 'merge_pull_request':
      return doMergePullRequest(store, args);
    default:
      return toolError(`unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC plumbing

type JsonRpcId = string | number;

function rpcResult(res: ServerResponse, store: Store, id: JsonRpcId, result: unknown): void {
  sendJson(res, store, 200, { jsonrpc: '2.0', id, result });
}

function rpcError(res: ServerResponse, store: Store, status: number, id: JsonRpcId | null, code: number, message: string, data?: unknown): void {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  sendJson(res, store, status, { jsonrpc: '2.0', id, error });
}

/** The revision a request declares: `_meta` first, then a bare `protocolVersion` (initialize). */
function declaredRevision(params: Args): string | undefined {
  const meta = params._meta;
  if (isObject(meta)) {
    const fromMeta = meta['io.modelcontextprotocol/protocolVersion'];
    if (typeof fromMeta === 'string' && fromMeta !== '') return fromMeta;
    const plain = meta.protocolVersion;
    if (typeof plain === 'string' && plain !== '') return plain;
  }
  const bare = params.protocolVersion;
  return typeof bare === 'string' && bare !== '' ? bare : undefined;
}

function serverInfoJson(): { name: string; version: string } {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function capabilitiesJson(): Record<string, unknown> {
  return { tools: { listChanged: false } };
}

function discoverResult(): Record<string, unknown> {
  const serverInfo = serverInfoJson();
  return {
    protocolVersion: PREFERRED_REVISION,
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: capabilitiesJson(),
    serverInfo,
    instructions: 'A GitHub-compatible forge: create repositories, issues and pull requests, and merge them.',
    _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
  };
}

/** Answer one JSON-RPC request object. Notifications (no id) get HTTP 202 with an empty body. */
function handleRpc(res: ServerResponse, store: Store, request: Record<string, unknown>): void {
  const hasId = Object.prototype.hasOwnProperty.call(request, 'id');
  const rawId = request.id;
  const id: JsonRpcId | null =
    typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
  const isNotification = !hasId;

  const method = request.method;
  if (typeof method !== 'string' || method === '') {
    if (isNotification) {
      res.writeHead(202, { 'x-github-request-id': store.nextReqId() });
      res.end();
      return;
    }
    rpcError(res, store, 200, id, INVALID_REQUEST, 'Invalid Request: method must be a non-empty string');
    return;
  }
  if (request.jsonrpc !== undefined && request.jsonrpc !== '2.0') {
    if (isNotification) {
      res.writeHead(202, { 'x-github-request-id': store.nextReqId() });
      res.end();
      return;
    }
    rpcError(res, store, 200, id, INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"');
    return;
  }

  const rawParams = request.params;
  if (rawParams !== undefined && !isObject(rawParams) && !Array.isArray(rawParams)) {
    if (isNotification) {
      res.writeHead(202, { 'x-github-request-id': store.nextReqId() });
      res.end();
      return;
    }
    rpcError(res, store, 200, id, INVALID_PARAMS, 'Invalid params: params must be an object');
    return;
  }
  const params: Args = isObject(rawParams) ? rawParams : {};

  // Notifications never carry a result: acknowledge and stop.
  if (isNotification) {
    res.writeHead(202, { 'x-github-request-id': store.nextReqId() });
    res.end();
    return;
  }

  // A revision the server does not speak is a -32022, naming what it does speak (initialize
  // negotiates instead: it answers with the newest revision it shares with the client).
  const revision = declaredRevision(params);
  if (revision !== undefined && !SUPPORTED_VERSIONS.includes(revision) && method !== 'initialize') {
    rpcError(res, store, 200, id, UNSUPPORTED_VERSION, `Unsupported protocol version: ${revision}`, {
      supported: [...SUPPORTED_VERSIONS],
    });
    return;
  }

  try {
    switch (method) {
      case 'server/discover': {
        rpcResult(res, store, id!, discoverResult());
        return;
      }
      case 'initialize': {
        const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
        const negotiated = offered !== undefined && SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
        rpcResult(res, store, id!, {
          protocolVersion: negotiated,
          capabilities: capabilitiesJson(),
          serverInfo: serverInfoJson(),
        });
        return;
      }
      case 'ping': {
        rpcResult(res, store, id!, {});
        return;
      }
      case 'tools/list': {
        rpcResult(res, store, id!, { tools: TOOLS });
        return;
      }
      case 'tools/call': {
        const name = params.name;
        if (typeof name !== 'string' || name === '') {
          rpcError(res, store, 200, id, INVALID_PARAMS, 'Invalid params: tools/call requires a tool name');
          return;
        }
        const argsRaw = params.arguments;
        if (argsRaw !== undefined && !isObject(argsRaw)) {
          rpcError(res, store, 200, id, INVALID_PARAMS, 'Invalid params: arguments must be an object');
          return;
        }
        const canonical = resolveToolName(name);
        if (canonical === null) {
          rpcError(res, store, 200, id, INVALID_PARAMS, `Unknown tool: ${name}`);
          return;
        }
        const outcome = callTool(store, canonical, isObject(argsRaw) ? argsRaw : {});
        rpcResult(res, store, id!, outcome);
        return;
      }
      default: {
        rpcError(res, store, 200, id, METHOD_NOT_FOUND, `Method not found: ${method}`);
        return;
      }
    }
  } catch (error) {
    // A handler must never take the endpoint down with it.
    if (!res.writableEnded) {
      rpcError(res, store, 200, id, -32603, `Internal error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// ---------------------------------------------------------------- entry point

/**
 * Answer POST /mcp. Returns true when the path was /mcp and the request was answered,
 * false otherwise (any other path or method belongs to another surface).
 */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  if (pathOf(req) !== '/mcp') return false;
  if ((req.method ?? '') !== 'POST') return false;
  try {
    if (!isAuthorized(req)) {
      sendError(res, store, 401, 'Unauthorized');
      return true;
    }
    const body = await readBody(req);
    if (body === null) {
      rpcError(res, store, 400, null, PARSE_ERROR, 'Parse error: request body too large');
      return true;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      rpcError(res, store, 400, null, PARSE_ERROR, 'Parse error: request body is not valid JSON');
      return true;
    }
    if (Array.isArray(parsed)) {
      rpcError(res, store, 400, null, INVALID_REQUEST, 'Invalid Request: batch requests are not supported');
      return true;
    }
    if (!isObject(parsed)) {
      rpcError(res, store, 400, null, INVALID_REQUEST, 'Invalid Request: request must be a JSON object');
      return true;
    }
    handleRpc(res, store, parsed);
    return true;
  } catch (error) {
    if (!res.writableEnded) {
      try {
        rpcError(res, store, 200, null, -32603, `Internal error: ${error instanceof Error ? error.message : String(error)}`);
      } catch {
        // The socket is already gone; nothing left to answer on.
      }
    }
    return true;
  }
}
