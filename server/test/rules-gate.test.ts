import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { parseRulesFile, withVersion, RulesError } from "../src/rules.ts";
import { RuleStore } from "../src/rulestore.ts";
import { evaluate } from "../src/gate.ts";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

// The design document's own example (v1.2 §2), as a support file. Invented
// business, no real contact details.
const SUPPORT = `---
domain: support
owner: owner@example.com
version: 3            # bump on every edit
updated: 2026-10-25
policy:
  REFUND-CAP:      { max_amount_cents: 20000, above: block }
  REFUND-APPROVAL: { over_cents: 12000, action: draft_for_approval }
---

## HARD RULES
- REFUND-CAP: never refund more than $200.
- REFUND-APPROVAL: refunds over $120 wait for the owner.
`;

const COMPANY = `---
domain: company
version: 1
policy:
  DISCOUNT-CAP: { max_amount_cents: 5000, above: block, applies_to: discount }
---
- DISCOUNT-CAP: no discount over $50.
`;

function rulesDir(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "bizos-rules-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const errorsOf = (raw: string) => {
  try { parseRulesFile(raw); return []; } catch (e) { return (e as RulesError).errors; }
};

test("the v1.2 example compiles to the thresholds the gate enforces", () => {
  const f = parseRulesFile(SUPPORT, "support");
  assert.equal(f.version, 3);
  assert.deepEqual(f.thresholds, [
    { id: "REFUND-CAP", limitCents: 20000, outcome: "block", appliesTo: "*" },
    { id: "REFUND-APPROVAL", limitCents: 12000, outcome: "review", appliesTo: "*" },
  ]);
  assert.deepEqual(f.warnings, []);
});

test("a typo in a policy key is refused, not silently dropped", () => {
  const typo = SUPPORT.replace("max_amount_cents", "max_ammount_cents");
  assert.ok(errorsOf(typo).some((e) => e.includes('unknown key "max_ammount_cents"')));
});

test("the parser reports every problem at once", () => {
  const bad = `---
domain: Support
version: 0
policy:
  refund-cap: { max_amount_cents: 199.99, above: maybe }
---
`;
  const errs = errorsOf(bad);
  assert.ok(errs.length >= 4, errs.join(" | "));
});

test("a file without a policy block is refused", () => {
  assert.ok(errorsOf("---\ndomain: sales\nversion: 1\n---\nhi\n").some((e) => e.startsWith("policy:")));
});

test("a file named for one domain cannot claim another", () => {
  assert.throws(() => parseRulesFile(SUPPORT, "sales"), RulesError);
});

test("a policy ID the prose never mentions is a warning", () => {
  const f = parseRulesFile(SUPPORT.replace("- REFUND-CAP:", "- The cap:"), "support");
  assert.deepEqual(f.warnings, ["REFUND-CAP is enforced by the gate but not mentioned in the prose rules"]);
});

test("withVersion rewrites only the version line and keeps its comment", () => {
  const out = withVersion(SUPPORT, 4);
  assert.match(out, /^version: 4\s+# bump on every edit$/m);
  assert.equal(out.replace("version: 4", "version: 3"), SUPPORT);
});

test("the gate: the DAY_PLAN amounts land where the plan says", () => {
  const { dir, done } = rulesDir({ "support.rules.md": SUPPORT });
  const store = new RuleStore(dir);
  const check = (cents: number) => evaluate(store, { domain: "support", type: "refund", amountCents: cents });
  assert.equal(check(12000).verdict, "pass", "the limit itself is allowed");
  assert.equal(check(12001).verdict, "review");
  assert.equal(check(19999).verdict, "review", "$199.99 -> REVIEW");
  assert.equal(check(20000).verdict, "review");
  const big = check(50000);
  assert.equal(big.verdict, "block", "$500 -> BLOCK");
  assert.equal(big.policyId, "REFUND-CAP");
  assert.equal(big.limitCents, 20000);
  assert.deepEqual(big.rulesVersions, { support: 3 });
  done();
});

test("the gate fails closed", () => {
  const { dir, done } = rulesDir({ "support.rules.md": SUPPORT });
  const store = new RuleStore(dir);
  assert.equal(evaluate(store, { domain: "support", type: "refund", amountCents: 100.5 }).verdict, "block");
  assert.equal(evaluate(store, { domain: "support", type: "refund", amountCents: -1 }).verdict, "block");
  assert.equal(evaluate(store, { domain: "sales", type: "refund", amountCents: 1 }).verdict, "review", "no rules -> a person decides");
  done();
});

test("company policies bind every domain, and applies_to scopes them", () => {
  const { dir, done } = rulesDir({ "support.rules.md": SUPPORT, "company.rules.md": COMPANY });
  const store = new RuleStore(dir);
  const d = evaluate(store, { domain: "support", type: "discount", amountCents: 6000 });
  assert.equal(d.verdict, "block");
  assert.equal(d.policyId, "DISCOUNT-CAP");
  assert.deepEqual(d.rulesVersions, { support: 3, company: 1 });
  // A $40 discount is a type the rules name, under every limit: it passes.
  assert.equal(evaluate(store, { domain: "support", type: "discount", amountCents: 4000 }).verdict, "pass");
  // DISCOUNT-CAP scopes the rules by type, and none of them names "refund", so a
  // $60 refund fails closed to review (issue #7) even though no limit trips.
  const r = evaluate(store, { domain: "support", type: "refund", amountCents: 6000 });
  assert.equal(r.verdict, "review");
  assert.match(r.reason, /"refund" is not an action type any rule names \(discount\)/);
  done();
});

test("an edit changes the gate on the next check, without a restart", () => {
  const { dir, done } = rulesDir({ "support.rules.md": SUPPORT });
  const store = new RuleStore(dir);
  const check = () => evaluate(store, { domain: "support", type: "refund", amountCents: 15000 });
  assert.equal(check().verdict, "review");
  const saved = store.save("support", SUPPORT.replace("max_amount_cents: 20000", "max_amount_cents: 10000"), 3);
  assert.equal(saved.file.version, 4, "the server bumps the version");
  const after = check();
  assert.equal(after.verdict, "block");
  assert.equal(after.policyId, "REFUND-CAP");
  assert.deepEqual(after.rulesVersions, { support: 4 });
  done();
});

test("a broken edit outside the API keeps the last good rules enforced", () => {
  const { dir, done } = rulesDir({ "support.rules.md": SUPPORT });
  const store = new RuleStore(dir);
  const path = join(dir, "support.rules.md");
  writeFileSync(path, SUPPORT.replace("20000", "lots"));
  utimesSync(path, new Date(), new Date(Date.now() + 5000)); // a new mtime, whatever the clock resolution
  const s = store.get("support")!;
  assert.ok(s.error, "the broken file is reported");
  assert.equal(s.active!.version, 3, "the last good version stays active");
  assert.equal(evaluate(store, { domain: "support", type: "refund", amountCents: 50000 }).verdict, "block");
  done();
});

test("HTTP: list, read, save with a diff, refuse a bad save, refuse a stale save", async () => {
  const { dir, done } = rulesDir({ "support.rules.md": SUPPORT });
  const dbDir = mkdtempSync(join(tmpdir(), "bizos-db-"));
  const db = openDb(join(dbDir, "t.db"));
  const server = createApp(db, { ...loadConfig({}), rulesDir: dir });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const put = (body: unknown) => fetch(`${base}/api/rules/support`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const list = await (await fetch(`${base}/api/rules`)).json() as any[];
    assert.equal(list[0].domain, "support");
    assert.equal(list[0].version, 3);
    assert.deepEqual(list[0].policy[0], { id: "REFUND-CAP", limit_cents: 20000, outcome: "block", applies_to: "*" });

    const one = await (await fetch(`${base}/api/rules/support`)).json() as any;
    assert.equal(one.content, SUPPORT);

    const edited = SUPPORT.replace("max_amount_cents: 20000", "max_amount_cents: 10000");
    const ok = await put({ content: edited, expected_version: 3 });
    assert.equal(ok.status, 200);
    const saved = await ok.json() as any;
    assert.equal(saved.version, 4);
    assert.equal(saved.previous_version, 3);
    const changed = saved.diff.filter((l: any) => l.op !== "same").map((l: any) => l.op + " " + l.text.trim());
    assert.ok(changed.includes("add REFUND-CAP:      { max_amount_cents: 10000, above: block }"), changed.join(" | "));
    assert.ok(changed.some((l: string) => l.startsWith("add version: 4")));
    assert.match(readFileSync(join(dir, "support.rules.md"), "utf8"), /max_amount_cents: 10000/);

    const bad = await put({ content: edited.replace("10000", "ten dollars"), expected_version: 4 });
    assert.equal(bad.status, 422);
    assert.ok(((await bad.json()) as any).errors.length > 0);
    assert.match(readFileSync(join(dir, "support.rules.md"), "utf8"), /max_amount_cents: 10000/, "file untouched");

    const stale = await put({ content: edited, expected_version: 3 });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { error: "version_conflict", current_version: 4 });

    const auditRows = await (await fetch(`${base}/api/audit`)).json() as any[];
    const upd = auditRows.find((a) => a.event === "rules_updated");
    assert.deepEqual(JSON.parse(upd.detail).to_version, 4);

    assert.equal((await fetch(`${base}/api/rules/nope`)).status, 404);
  } finally {
    server.close();
    db.close();
    rmSync(dbDir, { recursive: true, force: true });
    done();
  }
});
