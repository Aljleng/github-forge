// The forge's whole store: one in-memory database every surface (git smart HTTP, REST v3,
// GraphQL v4, MCP) reads and writes. No disk, no clock, no randomness: every timestamp comes from
// the store's deterministic clock (one second per tick from the scenario epoch) and every id from a
// counter, so two runs driven with the same requests answer byte for byte the same.
//
// The token's login is the scenario's viewer. The suite's scenario is sealed and public
// (program/env/src/wire.ts buildScenario()): users are generated from SCENARIO_SEED and the viewer
// is users[0], login "adaiversen", id 1000. Repositories the suite creates belong to that login;
// any other owner is 404, never 403.

import type { IncomingMessage } from 'node:http';

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

export const VIEWER: User = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});
export const VIEWER_LOGIN = VIEWER.login;
/** The scenario's other named users (only ever read back as 404 owners, never as repo owners). */
export const TEAMMATE_LOGIN = 'quinnkeller';
export const STRANGER_LOGIN = 'olgabauer';
export const ORG_LOGIN = 'faint-meadow-org';

/** The scenario epoch: every generated timestamp is this plus a seeded offset (wire.ts). */
export const SCENARIO_EPOCH_SEC = 1_735_689_600;

export type IssueState = 'open' | 'closed';

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: User;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  user: User;
  createdAt: string;
  updatedAt: string;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  /** The head branch's tip when the pull was created/last read (null when the branch is gone). */
  headSha: string | null;
  baseSha: string | null;
  mergeSha: string | null;
  user: User;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  /** Full ref names ("refs/heads/main", "refs/tags/v1") to commit shas. */
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  issueSeq: number;
  pulls: Map<number, Pull>;
  pullSeq: number;
  labels: Map<string, Label>;
  commentSeq: number;
}

/** One git object, as the object store holds it: its type and its raw (uncompressed) bytes. */
export interface GitObject {
  type: string;
  data: Buffer;
}

export interface Store {
  /** Git objects by SHA-1 hex. */
  objects: Map<string, GitObject>;
  /** Repositories by "owner/name". */
  repos: Map<string, Repo>;
  repoSeq: number;
  issueIdSeq: number;
  pullIdSeq: number;
  commentSeq: number;
  reqSeq: number;
  /** Seconds since the Unix epoch for the deterministic clock; starts at the scenario epoch. */
  clockSec: number;
  /** The next deterministic timestamp (ISO 8601, one second later than the previous tick). */
  nowIso(): string;
  /** The next deterministic X-GitHub-Request-Id value. */
  nextReqId(): string;
  getRepo(owner: string, name: string): Repo | undefined;
  createRepo(name: string, description: string, isPrivate: boolean): Repo;
  deleteRepo(owner: string, name: string): boolean;
}

export function createStore(): Store {
  const store: Store = {
    objects: new Map(),
    repos: new Map(),
    repoSeq: 0,
    issueIdSeq: 0,
    pullIdSeq: 0,
    commentSeq: 0,
    reqSeq: 0,
    clockSec: SCENARIO_EPOCH_SEC,
    nowIso(): string {
      this.clockSec += 1;
      return new Date(this.clockSec * 1000).toISOString();
    },
    nextReqId(): string {
      this.reqSeq += 1;
      return `req-${this.reqSeq.toString(16).padStart(8, '0')}`;
    },
    getRepo(owner: string, name: string): Repo | undefined {
      return this.repos.get(`${owner}/${name}`);
    },
    createRepo(name: string, description: string, isPrivate: boolean): Repo {
      this.repoSeq += 1;
      const now = this.nowIso();
      const repo: Repo = {
        id: this.repoSeq,
        name,
        fullName: `${VIEWER_LOGIN}/${name}`,
        owner: VIEWER_LOGIN,
        description,
        private: isPrivate,
        defaultBranch: 'main',
        createdAt: now,
        updatedAt: now,
        refs: new Map(),
        issues: new Map(),
        issueSeq: 0,
        pulls: new Map(),
        pullSeq: 0,
        labels: new Map(),
        commentSeq: 0,
      };
      this.repos.set(repo.fullName, repo);
      return repo;
    },
    deleteRepo(owner: string, name: string): boolean {
      return this.repos.delete(`${owner}/${name}`);
    },
  };
  return store;
}

// ---------------------------------------------------------------- auth

/** The bearer token the suite presents, from this process's environment. */
export function shopToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/**
 * Whether the request carries the suite's token. A missing or wrong token is refused; with no token
 * configured (local runs without MAKEFUN_SHOP_TOKEN) any non-empty Bearer passes, so the forge can
 * still be driven by hand.
 */
export function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (match === null) return false;
  const expected = shopToken();
  if (expected === '') return match[1] !== undefined && match[1] !== '';
  return match[1] === expected;
}

// ---------------------------------------------------------------- GraphQL node ids

/** A GitHub-style opaque node id: base64 of "<Kind>:<id>" (e.g. "Repository:3"). */
export function nodeId(kind: string, id: string | number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

/** The kind and id a node id carries, or null when it does not parse. */
export function parseNodeId(id: string): { kind: string; id: string } | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const at = text.indexOf(':');
  if (at <= 0) return null;
  return { kind: text.slice(0, at), id: text.slice(at + 1) };
}

/** The node id of a repository (its REST id, shared across surfaces). */
export function repoNodeId(repo: Repo): string {
  return nodeId('Repository', repo.id);
}

/** The node id of an issue (repo id + issue number, so it round-trips without a lookup table). */
export function issueNodeId(repo: Repo, issue: Issue): string {
  return nodeId('Issue', `${repo.id}:${issue.number}`);
}

/** The node id of a pull request. */
export function pullNodeId(repo: Repo, pull: Pull): string {
  return nodeId('PullRequest', `${repo.id}:${pull.number}`);
}
