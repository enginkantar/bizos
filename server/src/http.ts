import type { IncomingMessage, ServerResponse } from "node:http";

// A router small enough to read in one sitting. Built on node:http rather than
// a framework so `npm install` pulls no runtime dependencies - the install has
// to work on a stranger's laptop in under ten minutes.

export interface Reply {
  status: number;
  body: unknown;
}

export type Handler = (req: IncomingMessage, params: Record<string, string>, body: unknown) => Reply | Promise<Reply>;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_BODY_BYTES = 1_000_000;

export class Router {
  private routes: Route[] = [];

  on(method: string, path: string, handler: Handler): this {
    this.routes.push({ method, parts: path.split("/").filter(Boolean), handler });
    return this;
  }

  private match(method: string, path: string) {
    const parts = path.split("/").filter(Boolean);
    let pathMatched = false;
    for (const r of this.routes) {
      if (r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      const ok = r.parts.every((p, i) => {
        if (p.startsWith(":")) { params[p.slice(1)] = decodeURIComponent(parts[i]); return true; }
        return p === parts[i];
      });
      if (!ok) continue;
      pathMatched = true;
      if (r.method === method) return { route: r, params };
    }
    return { route: undefined, params: {}, pathMatched };
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    let reply: Reply;
    try {
      const found = this.match(req.method ?? "GET", url.pathname);
      if (!found.route) {
        reply = "pathMatched" in found && found.pathMatched
          ? { status: 405, body: { error: "method_not_allowed" } }
          : { status: 404, body: { error: "not_found" } };
      } else {
        const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readJson(req);
        reply = await found.route.handler(req, found.params, body);
      }
    } catch (e) {
      if (e instanceof HttpError) {
        reply = { status: e.status, body: { error: e.message } };
      } else {
        // Log the detail here; the client gets no stack trace or SQL.
        console.error(e);
        reply = { status: 500, body: { error: "internal_error" } };
      }
    }
    res.writeHead(reply.status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(reply.body));
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}
