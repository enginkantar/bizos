import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

// The owner desk is served from the API's own origin. fetch() normalizes
// "../", so traversal is sent raw through node:http to test what an attacker
// can actually send.
function raw(port: number, method: string, path: string): Promise<{ status: number; type: string; body: string; cache: string }> {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, method, path }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => ok({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body, cache: String(res.headers["cache-control"] ?? "") }));
    });
    req.on("error", fail);
    req.end();
  });
}

test("web/ is served at / beside the API, and nothing outside it is", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bizos-web-"));
  const web = join(dir, "web");
  mkdirSync(join(web, "src"), { recursive: true });
  mkdirSync(join(web, "empty"));
  writeFileSync(join(web, "index.html"), "<!doctype html><title>desk</title>");
  writeFileSync(join(web, "src", "app.js"), "export const ok = 1;");
  writeFileSync(join(web, ".env"), "SECRET=1");
  writeFileSync(join(dir, "outside.txt"), "not for the web");
  const db = openDb(join(dir, "t.db"));
  const server = createApp(db, { ...loadConfig({}), rulesDir: join(dir, "business"), webDir: web });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  try {
    const index = await raw(port, "GET", "/");
    assert.equal(index.status, 200);
    assert.match(index.type, /^text\/html/);
    assert.equal(index.cache, "no-store");
    assert.match(index.body, /<title>desk<\/title>/);

    const js = await raw(port, "GET", "/src/app.js");
    assert.equal(js.status, 200);
    assert.match(js.type, /^text\/javascript/, "module scripts need a JavaScript type");

    const head = await raw(port, "HEAD", "/");
    assert.equal(head.status, 200);
    assert.equal(head.body, "");

    for (const path of ["/../outside.txt", "/%2e%2e/outside.txt", "/src/..%2f..%2foutside.txt", "/.env", "/empty/", "/nope"]) {
      const r = await raw(port, "GET", path);
      assert.equal(r.status, 404, path);
      assert.deepEqual(JSON.parse(r.body), { error: "not_found" }, path);
    }

    const api = await raw(port, "GET", "/api/health");
    assert.equal(api.status, 200);
    assert.equal(JSON.parse(api.body).ok, true, "the API still answers under /api/");
    assert.equal((await raw(port, "POST", "/")).status, 404, "only GET and HEAD read files");
  } finally {
    server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
