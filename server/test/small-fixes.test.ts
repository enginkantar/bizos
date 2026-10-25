import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/db.ts";
import { RuleStore, seedFromTemplate } from "../src/rulestore.ts";
import { parseRulesFile } from "../src/rules.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

// The small code bugs from issue #27, one test each.

async function server() {
  const dir = mkdtempSync(join(tmpdir(), "bizos-27s-"));
  const db = openDb(join(dir, "t.db"));
  const rulesDir = join(dir, "not-created-yet");
  const app = createApp(db, { ...loadConfig({}), rulesDir }, new RuleStore(rulesDir));
  await new Promise<void>((ok) => app.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const send = (method: string, path: string, body?: unknown) => fetch(base + path, {
    method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { db, rulesDir, send, done: () => { app.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const envelope = (extra: object = {}) => ({
  message_id: "w-1", source: "webform", reply_to: "patient@example.com", content: { text: "Hi" }, ...extra,
});

test("malformed percent-encoding in a path is a 400, not a 500", async () => {
  const s = await server();
  try {
    const r = await s.send("GET", "/api/cases/%E0%A4%A");
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: "invalid_path" });
  } finally { s.done(); }
});

test("whitespace-only fields count as missing", async () => {
  const s = await server();
  try {
    const r = await s.send("POST", "/api/inbox", envelope({ reply_to: "   " }));
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: "missing_reply_to" });
  } finally { s.done(); }
});

test("received_at must be a real time, and is stored as UTC ISO-8601", async () => {
  const s = await server();
  try {
    const bad = await s.send("POST", "/api/inbox", envelope({ received_at: "yesterday-ish" }));
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: "invalid_received_at" });
    const ok = await s.send("POST", "/api/inbox", envelope({ received_at: "2026-10-25T10:00:00-07:00" }));
    assert.equal(ok.status, 201);
    const row = s.db.prepare("SELECT received_at FROM messages").get() as { received_at: string };
    assert.equal(row.received_at, "2026-10-25T17:00:00.000Z");
  } finally { s.done(); }
});

test("an inbound message id in the outbound reply: namespace is refused", async () => {
  const s = await server();
  try {
    const r = await s.send("POST", "/api/inbox", envelope({ message_id: "reply:abc:v1" }));
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: "reserved_message_id" });
  } finally { s.done(); }
});

test("route: null means no route given", async () => {
  const s = await server();
  try {
    const { case_id } = await (await s.send("POST", "/api/inbox", envelope())).json() as { case_id: string };
    const r = await s.send("POST", `/api/cases/${case_id}/drafts`, { domain: "support", text: "Hello", route: null });
    assert.equal(r.status, 201, "before the fix: 400 invalid_route");
  } finally { s.done(); }
});

test("saving rules when RULES_DIR does not exist creates it", async () => {
  const s = await server();
  try {
    assert.equal(existsSync(s.rulesDir), false);
    const r = await s.send("PUT", "/api/rules/support", {
      content: "---\ndomain: support\nversion: 1\npolicy: {}\n---\nhi\n", expected_version: 0,
    });
    assert.equal(r.status, 200, "before the fix: 500");
    assert.ok(existsSync(join(s.rulesDir, "support.rules.md")));
  } finally { s.done(); }
});

test("the starter pack is found from the server's own folder, not the working directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "bizos-27c-"));
  const before = process.cwd();
  try {
    process.chdir(dir);
    const copied = seedFromTemplate(join(dir, "business"), "dental-office");
    assert.deepEqual(copied.sort(), ["billing.rules.md", "company.rules.md", "front-desk.rules.md"]);
    assert.equal(readdirSync(join(dir, "business")).length, 3);
  } finally {
    process.chdir(before);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the prose-mention warning needs the whole ID, not a longer one containing it", () => {
  const raw = "---\ndomain: billing\nversion: 1\npolicy:\n  REFUND-CAP: { max_amount_cents: 20000, above: block }\n---\n- REFUND-CAP-ALL: something else.\n";
  assert.deepEqual(parseRulesFile(raw).warnings, ["REFUND-CAP is enforced by the gate but not mentioned in the prose rules"]);
  assert.deepEqual(parseRulesFile(raw.replace("REFUND-CAP-ALL", "REFUND-CAP")).warnings, []);
});
