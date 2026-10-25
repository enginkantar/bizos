import type { RuleStore } from "./rulestore.ts";
import type { Outcome, Threshold } from "./rules.ts";

// The Policy Gate (design v1.2 §2-3): deterministic code that every money
// action passes before anything reaches a customer. "The model proposes; the
// gate disposes." It holds no limits of its own - every threshold comes from
// a policy: block in the live rules, read at the moment of the check, so an
// owner's edit changes enforcement on the very next action.
//
// It fails CLOSED. Anything it cannot evaluate - a missing or broken rules
// file, an amount that is not a whole number of cents - is never a pass.

export type Verdict = "pass" | "review" | "block";

export interface GateAction {
  domain: string;
  // What the money is for: refund, discount, quote... matched against a
  // threshold's applies_to.
  type: string;
  amountCents: number;
}

export interface GateResult {
  verdict: Verdict;
  // The rule that decided it, for the red banner and the audit trail.
  policyId: string | null;
  limitCents: number | null;
  reason: string;
  // Which file versions were consulted, so a draft can record exactly what it
  // was checked against and an approval can be voided when they change.
  rulesVersions: Record<string, number>;
}

const SHARED = "company";
const rank: Record<Outcome, number> = { review: 1, block: 2 };

export function evaluate(store: RuleStore, action: GateAction): GateResult {
  const versions: Record<string, number> = {};
  const fail = (verdict: Verdict, reason: string): GateResult =>
    ({ verdict, policyId: null, limitCents: null, reason, rulesVersions: versions });

  if (!Number.isSafeInteger(action.amountCents) || action.amountCents < 0) {
    return fail("block", "amount is not a whole, non-negative number of cents");
  }

  // Shared policies live once in company.rules.md (v1.2 §2) and bind every
  // domain alongside its own.
  //
  // 🔴 A company file that exists but has NEVER loaded (issue #22) used to be
  //    skipped: store.active() was undefined, so every company cap silently
  //    stopped applying everywhere. Nobody can tell which limits it meant to
  //    set, so every department waits for a person until it is fixed. A file
  //    that broke AFTER loading keeps its last good version, enforced below.
  const companyState = action.domain === SHARED ? undefined : store.get(SHARED);
  if (companyState && !companyState.active) {
    return fail("review", "company.rules.md failed to load and has no good version; a person decides");
  }

  // A broken file on disk (state.error) does not change what is enforced: the
  // last good version stays active. Holding everything for review would stall
  // the business over a typo, and the rules editor already shows the error.
  const domainState = store.get(action.domain);
  const files = [];
  if (domainState?.active) { files.push(domainState.active); versions[action.domain] = domainState.active.version; }
  if (companyState?.active) { files.push(companyState.active); versions[SHARED] = companyState.active.version; }

  const thresholds = files.flatMap((f) => f.thresholds);
  const applies = (t: Threshold) => t.appliesTo === "*" || t.appliesTo.includes(action.type);
  const tripped = thresholds
    .filter((t) => applies(t) && action.amountCents > t.limitCents)
    // Strictest first: block beats review, then the lower limit, so the banner
    // names the rule that bit hardest.
    .sort((a, b) => rank[b.outcome] - rank[a.outcome] || a.limitCents - b.limitCents);
  const worst = tripped[0];
  const overLimit = worst && {
    verdict: worst.outcome as Verdict,
    policyId: worst.id,
    limitCents: worst.limitCents,
    reason: `${formatCents(action.amountCents)} is over ${worst.id} (${formatCents(worst.limitCents)})`,
    rulesVersions: versions,
  };

  // 🔴 THE DOMAIN IS MODEL OUTPUT TOO (issue #22). A department with no rules
  //    file used to return review before the company file was even read, so
  //    a $600 write-off on "no-such-dept" dodged WRITE-OFF-CAP. Company limits
  //    are now applied first: a company block still blocks, and anything else
  //    goes to a person, because the department's own limits are unknown.
  if (!domainState?.active) {
    const noRules = `no active rules for ${action.domain}; a person decides`;
    if (overLimit?.verdict === "block") return overLimit;
    return overLimit
      ? { ...overLimit, verdict: "review", reason: `${overLimit.reason}; ${noRules}` }
      : { verdict: "review", policyId: null, limitCents: null, reason: noRules, rulesVersions: versions };
  }

  // 🔴 THE ACTION TYPE IS MODEL OUTPUT (issue #7). Once the rules sort money by
  //    type - any threshold scoped with applies_to - a type they never name is
  //    the shape of a relabel: a $500 refund proposed as "store_credit" skips
  //    every refund limit and passes. So an unnamed type fails closed to review.
  //    A block from an unscoped cap still wins: a backstop binds whatever the
  //    label. Rules that never scope a threshold apply every limit to every
  //    type, so there is nothing to escape and nothing changes there.
  const vocabulary = [...new Set(thresholds.flatMap((t) => (t.appliesTo === "*" ? [] : t.appliesTo)))];
  if (vocabulary.length > 0 && !vocabulary.includes(action.type) && overLimit?.verdict !== "block") {
    const unnamed = `"${action.type}" is not an action type any rule names (${vocabulary.join(", ")}); a person decides`;
    return overLimit
      ? { ...overLimit, verdict: "review", reason: `${overLimit.reason}; ${unnamed}` }
      : { verdict: "review", policyId: null, limitCents: null, reason: unnamed, rulesVersions: versions };
  }

  return overLimit
    ?? { verdict: "pass", policyId: null, limitCents: null, reason: "within every limit", rulesVersions: versions };
}

export const formatCents = (c: number) => `$${(c / 100).toFixed(2)}`;
