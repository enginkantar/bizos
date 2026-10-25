import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRulesFile, RulesError } from "../src/rules.ts";
import { RuleStore } from "../src/rulestore.ts";
import { evaluate } from "../src/gate.ts";

// Issue #22: three places the gate failed OPEN, each found by the API test run.

const errorsOf = (raw: string) => {
  try { parseRulesFile(raw); return []; } catch (e) { return (e as RulesError).errors; }
};

const BILLING_V3 = `---
domain: billing
version: 3
policy:
  REFUND-CAP: { max_amount_cents: 20000, above: block, applies_to: refund }
---
- REFUND-CAP: never refund more than $200.
`;

// The live v3 -> v4 edit with one indentation slip (#22's exact repro).
const SLIPPED = `---
domain: billing
version: 4
policy:
REFUND-CAP: { max_amount_cents: 20000, above: block, applies_to: refund }
---
- REFUND-CAP: never refund more than $200.
`;

function dir(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), "bizos-22-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text);
  return { d, done: () => rmSync(d, { recursive: true, force: true }) };
}

test("#22.1 a policy entry slipped out of the block is refused, not loaded with zero limits", () => {
  const errs = errorsOf(SLIPPED);
  assert.ok(errs.some((e) => e.startsWith("REFUND-CAP: a policy entry outside the policy: block")), errs.join(" | "));
  assert.ok(errs.some((e) => e.startsWith("policy: is empty")), errs.join(" | "));
});

test("#22.1 a bare policy: is refused; policy: {} is the way to say no limits", () => {
  assert.ok(errorsOf("---\ndomain: billing\nversion: 1\npolicy:\n---\nhi\n").some((e) => e.startsWith("policy: is empty")));
  assert.deepEqual(errorsOf("---\ndomain: billing\nversion: 1\npolicy: {}\n---\nhi\n"), []);
});

test("#22.1 saving the slipped edit is refused and the v3 limits stay enforced", () => {
  const { d, done } = dir({ "billing.rules.md": BILLING_V3 });
  const store = new RuleStore(d);
  assert.throws(() => store.save("billing", SLIPPED, 3), RulesError);
  assert.equal(store.active("billing")!.version, 3);
  assert.equal(evaluate(store, { domain: "billing", type: "refund", amountCents: 50000 }).verdict, "block");
  assert.equal(readFileSync(join(d, "billing.rules.md"), "utf8"), BILLING_V3, "the file on disk is untouched");
  done();
});

test("#22.2 a company file that never loaded holds every department for a person", () => {
  const brokenCompany = `---
domain: company
version: 1
policy:
  REFUND-CAP-ALL: { max_amount_cents: 10000, above: blok }
---
- REFUND-CAP-ALL: no refund over $100 anywhere.
`;
  const support = "---\ndomain: support\nversion: 1\npolicy: {}\n---\nhi\n";
  const { d, done } = dir({ "company.rules.md": brokenCompany, "support.rules.md": support });
  const store = new RuleStore(d);
  assert.ok(store.get("company")!.error, "the company file is reported broken");
  const r = evaluate(store, { domain: "support", type: "refund", amountCents: 15000 });
  assert.equal(r.verdict, "review", "before the fix: pass, with the company cap silently gone");
  assert.match(r.reason, /company\.rules\.md failed to load/);
  done();
});

test("#22.2 a company file that broke after loading keeps enforcing its last good version", () => {
  const company = "---\ndomain: company\nversion: 1\npolicy:\n  WRITE-OFF-CAP: { max_amount_cents: 50000, above: block }\n---\n- WRITE-OFF-CAP: max $500.\n";
  const support = "---\ndomain: support\nversion: 1\npolicy: {}\n---\nhi\n";
  const { d, done } = dir({ "company.rules.md": company, "support.rules.md": support });
  const store = new RuleStore(d);
  const path = join(d, "company.rules.md");
  writeFileSync(path, company.replace("block", "blok"));
  utimesSync(path, new Date(), new Date(Date.now() + 5000)); // a new mtime, whatever the clock resolution
  assert.ok(store.get("company")!.error, "the broken edit is reported");
  const r = evaluate(store, { domain: "support", type: "write_off", amountCents: 60000 });
  assert.equal(r.verdict, "block");
  assert.equal(r.policyId, "WRITE-OFF-CAP");
  done();
});

test("#22.3 a department with no rules file still gets the company caps", () => {
  const { d, done } = dir({});
  for (const f of ["company.rules.md", "billing.rules.md"]) copyFileSync(join("templates", "dental-office", f), join(d, f));
  const store = new RuleStore(d);
  const known = evaluate(store, { domain: "billing", type: "write_off", amountCents: 60000 });
  const unknown = evaluate(store, { domain: "no-such-dept", type: "write_off", amountCents: 60000 });
  assert.equal(known.policyId, "WRITE-OFF-CAP");
  assert.equal(unknown.verdict, "block", "before the fix: review, with no policy - the cap was dodged");
  assert.equal(unknown.policyId, "WRITE-OFF-CAP");
  assert.deepEqual(unknown.rulesVersions, { company: 2 });
  const small = evaluate(store, { domain: "no-such-dept", type: "write_off", amountCents: 10000 });
  assert.equal(small.verdict, "review", "under every company cap, an unknown department still waits for a person");
  assert.match(small.reason, /no active rules for no-such-dept/);
  done();
});
