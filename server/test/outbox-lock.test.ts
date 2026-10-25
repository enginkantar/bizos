import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, ingestMessage } from "../src/db.ts";
import { RuleStore } from "../src/rulestore.ts";
import { createDraft, decide } from "../src/drafts.ts";
import { dispatchOutbox, startOutboxLoop } from "../src/outbox.ts";

// Issue #23: another process holding the write lock on DB_PATH - a sqlite3
// shell, a DB viewer - made the outbox timer throw "database is locked" and
// the server exit. Each test holds a real write lock from a second connection,
// the way `sqlite3 $DB_PATH` with BEGIN IMMEDIATE did in the repro.

const RULES = "---\ndomain: support\nversion: 1\npolicy: {}\n---\n- S-1: be kind.\n";

function world() {
  const dir = mkdtempSync(join(tmpdir(), "bizos-23-"));
  mkdirSync(join(dir, "business"));
  writeFileSync(join(dir, "business", "support.rules.md"), RULES);
  const path = join(dir, "t.db");
  // A short busy timeout reaches "database is locked" in 50 ms, not 5 s.
  const db = openDb(path, { busyTimeoutMs: 50 });
  const store = new RuleStore(join(dir, "business"));
  const lock = () => {
    const other = new DatabaseSync(path);
    other.exec("BEGIN IMMEDIATE");
    return () => { other.exec("COMMIT"); other.close(); };
  };
  const approvedReply = (id: string) => {
    const caseId = ingestMessage(db, { channel: "webform", sourceMessageId: id, replyTo: "patient@example.com", text: "hours?" }).caseId;
    const d = createDraft(db, store, { caseId, domain: "support", text: "We open at 7:30.", ruleCitations: ["S-1"] });
    decide(db, store, d.draftId, { decision: "approve", draftVersion: 1, rulesVersion: 1 });
  };
  const outCount = () => (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out'").get() as { n: number }).n;
  return { db, store, lock, approvedReply, outCount, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function recordingLog() {
  const lines: string[] = [];
  return { lines, log: { error: (m: string) => lines.push("error: " + m), log: (m: string) => lines.push("log: " + m) } };
}

test("#23 an idle outbox does not touch the write lock", () => {
  const w = world();
  const release = w.lock();
  try {
    // Before the fix the stuck-recovery UPDATE ran on every pass, idle or not,
    // and threw SQLITE_BUSY here.
    assert.equal(dispatchOutbox(w.db, w.store), 0);
  } finally {
    release();
    w.done();
  }
});

test("#23 a locked database fails a pass, logs once, and the loop sends after the lock is released", () => {
  const w = world();
  w.approvedReply("m-1");
  const { lines, log } = recordingLog();
  const release = w.lock();
  // A long interval so only the explicit ticks below run.
  const loop = startOutboxLoop(w.db, w.store, { intervalMs: 3_600_000, log });
  try {
    assert.doesNotThrow(() => loop.tick(), "the second locked pass is caught too");
    assert.equal(lines.length, 1, "one line per failing streak, not one a second");
    assert.match(lines[0], /^error: outbox: pass failed.*locked/i);
    assert.equal(w.outCount(), 0, "nothing sent while locked");
    release();
    loop.tick();
    assert.equal(w.outCount(), 1, "the queued reply goes out once the lock is gone");
    assert.equal(lines[1], "log: outbox: recovered, sending again");
  } finally {
    loop.stop();
    w.done();
  }
});

test("#23 a job stuck in processing is still recovered and sent", () => {
  const w = world();
  w.approvedReply("m-1");
  // An interrupted send: the job was claimed a minute ago and never finished.
  w.db.prepare("UPDATE outbox SET state = 'processing', updated_at = ?")
    .run(new Date(Date.now() - 60_000).toISOString());
  assert.equal(dispatchOutbox(w.db, w.store), 1);
  assert.equal(w.outCount(), 1);
  w.done();
});
