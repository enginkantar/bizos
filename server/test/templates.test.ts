import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuleStore, seedFromTemplate } from "../src/rulestore.ts";
import { evaluate } from "../src/gate.ts";

const ROOT = "templates";
const packs = readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

// Every starter pack must load exactly as shipped: no parse errors, and no
// policy limit missing from the prose that mirrors it. A pack that loads with a
// warning is one where the owner reads one rule and the gate enforces another.
for (const pack of packs) {
  test(`starter pack ${pack} loads with no errors and no drift warnings`, () => {
    const store = new RuleStore(join(ROOT, pack));
    const domains = store.list();
    assert.ok(domains.length > 0, "a pack needs at least one rules file");
    for (const { domain, state } of domains) {
      assert.equal(state.error, undefined, `${domain}: ${state.error?.errors.join("; ")}`);
      assert.deepEqual(state.active?.warnings, [], domain);
    }
  });
}

test("the dental office enforces what its prose says", () => {
  const store = new RuleStore(join(ROOT, "dental-office"));
  const check = (domain: string, type: string, cents: number) => {
    const g = evaluate(store, { domain, type, amountCents: cents });
    return `${g.verdict}${g.policyId ? " " + g.policyId : ""}`;
  };
  // Billing: refunds, courtesy discounts, payment plans.
  assert.equal(check("billing", "refund", 9500), "pass");
  assert.equal(check("billing", "refund", 15000), "review REFUND-APPROVAL");
  assert.equal(check("billing", "refund", 50000), "block REFUND-CAP", "the demo's $500 refund");
  assert.equal(check("billing", "discount", 5000), "pass", "$50 is the line, not over it");
  assert.equal(check("billing", "discount", 7500), "review DISCOUNT-APPROVAL");
  assert.equal(check("billing", "discount", 20000), "block DISCOUNT-CAP");
  assert.equal(check("billing", "payment_plan", 120000), "pass");
  // $2,400 is far over REFUND-CAP, but that cap applies_to refunds only.
  assert.equal(check("billing", "payment_plan", 240000), "review PAYMENT-PLAN-APPROVAL");
  // Front desk: every fee waiver needs a person; more than $75 never.
  assert.equal(check("front-desk", "fee_waiver", 5000), "review FEE-WAIVER-APPROVAL");
  assert.equal(check("front-desk", "fee_waiver", 10000), "block FEE-WAIVER-CAP");
  // Company limits bind every department.
  assert.equal(check("billing", "write_off", 60000), "block WRITE-OFF-CAP");
  assert.equal(check("front-desk", "write_off", 60000), "block WRITE-OFF-CAP");
});

test("first start copies the starter pack, and never touches an existing folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "bizos-seed-"));
  const target = join(dir, "business");
  const copied = seedFromTemplate(target, "dental-office", ROOT);
  assert.deepEqual(copied.sort(), ["billing.rules.md", "company.rules.md", "front-desk.rules.md"]);
  assert.equal(readFileSync(join(target, "billing.rules.md"), "utf8"),
    readFileSync(join(ROOT, "dental-office", "billing.rules.md"), "utf8"));

  writeFileSync(join(target, "billing.rules.md"), "the owner's own edit");
  assert.deepEqual(seedFromTemplate(target, "dental-office", ROOT), [], "existing folder: nothing copied");
  assert.equal(readFileSync(join(target, "billing.rules.md"), "utf8"), "the owner's own edit");

  const empty = join(dir, "emptied");
  mkdirSync(empty);
  assert.deepEqual(seedFromTemplate(empty, "dental-office", ROOT), [], "an emptied folder stays empty");
  assert.deepEqual(seedFromTemplate(join(dir, "x"), "", ROOT), [], "STARTER_TEMPLATE empty: never copy");
  assert.equal(existsSync(join(dir, "x")), false);
  assert.deepEqual(seedFromTemplate(join(dir, "y"), "no-such-pack", ROOT), []);
  rmSync(dir, { recursive: true, force: true });
});
