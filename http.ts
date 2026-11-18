// Shared HTTP plumbing for the four surfaces: body reads, JSON replies, and the
// X-GitHub-Request-Id every reply carries. Nothing here knows a route.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** The most bytes a request body may hold (packfiles included; the suite's are small). */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Read the whole request body as bytes, or null when it is over MAX_BODY_BYTES. */
export function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: Buffer | null): void => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', () => finish(null));
  });
}

/** Read the body and parse it as JSON: { ok: true, value } or { ok: false } on bad JSON/empty. */
export function parseJsonBody(body: Buffer | null): { ok: true; value: unknown } | { ok: false } {
  if (body === null || body.length === 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

/** Answer with a JSON body, always carrying the request id. Extra headers go beside it. */
export function sendJson(
  res: ServerResponse,
  store: Store,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': store.nextReqId(),
    ...headers,
  });
  res.end(text);
}

/** A JSON error body: {"message": "<string>"}, the shape every surface's errors carry. */
export function sendError(res: ServerResponse, store: Store, status: number, message: string): void {
  sendJson(res, store, status, { message });
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** The query of a request URL as URLSearchParams (empty when it does not parse). */
export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Whether `value` is a plain JSON object (not an array, not null). */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A JSON string field, or undefined when the field is absent or not a string. */
export function strField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === 'string' ? value : undefined;
}
