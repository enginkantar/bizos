import { createReadStream, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

// The owner desk and the chat widget are plain files in web/, served by this
// same process: one origin means no CORS code anywhere, and the whole product
// is still `npm start`. Browsers refuse a module script served with the wrong
// type, so the table is explicit; anything else is a download, never a guess.
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

// Returns false when the request is not for a file under root, so the router
// answers it - an unknown path still gets the API's JSON 404.
export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    return false;
  }
  // Hidden files (.env, .DS_Store) are never part of the UI, whatever lands in web/.
  if (pathname.split("/").some((part) => part.startsWith("."))) return false;
  if (pathname.endsWith("/")) pathname += "index.html";
  const base = resolve(root);
  const file = resolve(base, "." + pathname);
  // Nothing outside web/, however the path is spelled or encoded.
  if (!file.startsWith(base + sep)) return false;
  let size: number;
  try {
    const st = statSync(file);
    if (!st.isFile()) return false;
    size = st.size;
  } catch {
    return false;
  }
  // no-store: on build day every reload must show the file as it is now.
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "content-length": size,
    "cache-control": "no-store",
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  // A file removed between stat and read must not take the API down with it.
  createReadStream(file).on("error", () => res.destroy()).pipe(res);
  return true;
}
