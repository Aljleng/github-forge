// The forge's HTTP server: one process, one store, four surfaces. main.ts owns the lifecycle
// (bind, register, wait for done); this file owns the routing.
//
//   GET /healthz            200 {"ok":true} — the env's boot probe, no auth.
//   POST /api/graphql       GraphQL v4 (graphql.ts).
//   POST /mcp               MCP over streamable HTTP (mcp.ts).
//   /api/v3/*               REST v3 (rest.ts), bearer auth on every route.
//   /{owner}/{repo}.git/*  git smart HTTP (git.ts).
//   anything else           404 {"message":"Not Found"}.
//
// A handler answers true when it owned the request; anything unowned falls through to the 404.
// A handler that throws never kills the server: the request answers 500 JSON instead.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStore, type Store } from './store.ts';
import { pathOf, sendJson } from './http.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store: Store = createStore();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, store, 200, { ok: true });
          return;
        }

        if (path === '/api/graphql' && (await handleGraphql(req, res, store))) return;
        if (path === '/mcp' && (await handleMcp(req, res, store))) return;
        if ((path === '/api/v3' || path.startsWith('/api/v3/')) && (await handleRest(req, res, store))) return;
        if (path.includes('.git') && (await handleGit(req, res, store))) return;

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, store, 404, { message: 'Not Found' });
      } catch {
        try {
          sendJson(res, store, 500, { message: 'Internal Server Error' });
        } catch {
          // The socket is already gone; there is nothing left to answer.
        }
      }
    })();
  });
}
