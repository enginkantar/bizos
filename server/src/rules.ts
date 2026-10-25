import { parse as parseYaml } from "yaml";

// A rules file is Markdown with a YAML front matter header (design v1.2 §2):
//
//   ---
//   domain: support
//   version: 3
//   policy:
//     REFUND-CAP:      { max_amount_cents: 20000, above: block }
//     REFUND-APPROVAL: { over_cents: 12000, action: draft_for_approval }
//   ---
//   ## IDENTITY ...
//
// The policy: block is the ONLY place a limit lives. The agent reads the whole
// file; the gate compiles its thresholds from the same parse. Nothing else in
// the codebase may hold a limit, or the model and the gate can believe two
// different policies (the v1.2 "two decision loops" bug).
//
// 🔴 Validation is strict on purpose. A typo like `max_ammount_cents` in a
//    lenient parser yields a policy with no limit: the file loads, the demo
//    answers, and the gate enforces nothing. Unknown keys are an error.

export type Outcome = "block" | "review";

export interface Threshold {
  id: string;
  // The action is held or blocked when its amount is STRICTLY greater than
  // this. Integer cents: 20000 means $200.00 is allowed and $200.01 is not.
  limitCents: number;
  outcome: Outcome;
  // Action types this applies to, or "*" for every money action. Not in the
  // v1.2 example (open question for Engin); "*" is the cautious default - a
  // refund cap that also catches a quote holds it for review, it never lets
  // anything through that it should not.
  appliesTo: string[] | "*";
}

export interface RulesFile {
  domain: string;
  version: number;
  meta: Record<string, unknown>;
  thresholds: Threshold[];
  // The IDs the prose defines: the ID that starts a rule line, written
  // "- REFUND-CAP: ..." or "- [S-2] ...". These and the policy: keys are the
  // only rules a draft can cite; an ID merely mentioned inside a sentence
  // defines nothing. Repeats are kept, so a duplicate can be refused.
  ruleIds: string[];
  body: string;
  raw: string;
  warnings: string[];
}

export class RulesError extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super(errors.join("; "));
    this.errors = errors;
  }
}

// v1.2 writes the action as `draft_for_approval`; the gate's verdict for it is
// `review`. Both spellings are accepted in the file.
const OUTCOMES: Record<string, Outcome> = {
  block: "block",
  review: "review",
  draft_for_approval: "review",
};

const ID = "[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*";
const ID_PATTERN = new RegExp(`^${ID}$`);
const RULE_LINE = new RegExp(`^\\s*[-*+]\\s+(?:\\[(${ID})\\]|(${ID}):)(?=\\s|$)`);

export function splitFrontMatter(raw: string): { header: string; body: string } {
  const text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) throw new RulesError(["file must start with a --- front matter line"]);
  const end = text.indexOf("\n---", 4);
  if (end === -1) throw new RulesError(["front matter has no closing --- line"]);
  const after = text.indexOf("\n", end + 4);
  return { header: text.slice(4, end), body: after === -1 ? "" : text.slice(after + 1) };
}

function compileEntry(id: string, value: unknown, errors: string[]): Threshold | undefined {
  if (!ID_PATTERN.test(id)) errors.push(`policy ${id}: IDs are UPPER-CASE words joined by dashes, like REFUND-CAP`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(`policy ${id}: expected a { ... } map`);
    return undefined;
  }
  const v = value as Record<string, unknown>;
  const allowed = new Set(["max_amount_cents", "above", "over_cents", "action", "applies_to"]);
  for (const k of Object.keys(v)) if (!allowed.has(k)) errors.push(`policy ${id}: unknown key "${k}"`);

  // Two spellings of one idea, both from v1.2: a cap (max_amount_cents +
  // above) and an approval threshold (over_cents + action).
  let limit: unknown, outcomeName: unknown;
  if ("max_amount_cents" in v && "over_cents" in v) {
    errors.push(`policy ${id}: use max_amount_cents or over_cents, not both`);
    return undefined;
  } else if ("max_amount_cents" in v) {
    limit = v.max_amount_cents; outcomeName = v.above;
    if ("action" in v) errors.push(`policy ${id}: a max_amount_cents cap takes "above", not "action"`);
  } else if ("over_cents" in v) {
    limit = v.over_cents; outcomeName = v.action;
    if ("above" in v) errors.push(`policy ${id}: an over_cents threshold takes "action", not "above"`);
  } else {
    errors.push(`policy ${id}: needs max_amount_cents or over_cents`);
    return undefined;
  }
  if (!Number.isSafeInteger(limit) || (limit as number) < 0) {
    errors.push(`policy ${id}: the amount must be a whole number of cents, like 20000 for $200`);
  }
  const outcome = typeof outcomeName === "string" ? OUTCOMES[outcomeName] : undefined;
  if (!outcome) errors.push(`policy ${id}: outcome must be block or draft_for_approval`);

  let appliesTo: string[] | "*" = "*";
  if ("applies_to" in v) {
    const a = v.applies_to;
    const list = typeof a === "string" ? [a] : a;
    if (!Array.isArray(list) || list.length === 0 || !list.every((x) => typeof x === "string" && x)) {
      errors.push(`policy ${id}: applies_to is an action type or a list of them, like [refund]`);
    } else {
      appliesTo = list.includes("*") ? "*" : list;
    }
  }
  if (!outcome || !Number.isSafeInteger(limit)) return undefined;
  return { id, limitCents: limit as number, outcome, appliesTo };
}

// Parses and validates one file. Throws RulesError with EVERY problem found,
// not just the first: an owner fixing a file on stage needs the whole list.
export function parseRulesFile(raw: string, expectedDomain?: string): RulesFile {
  const { header, body } = splitFrontMatter(raw);
  let meta: unknown;
  try {
    meta = parseYaml(header);
  } catch (e) {
    throw new RulesError([`front matter is not valid YAML: ${(e as Error).message.split("\n")[0]}`]);
  }
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    throw new RulesError(["front matter must be key: value lines"]);
  }
  const m = meta as Record<string, unknown>;
  const errors: string[] = [];

  const domain = m.domain;
  if (typeof domain !== "string" || !/^[a-z][a-z0-9-]*$/.test(domain)) {
    errors.push("domain: required, lower-case, like support");
  } else if (expectedDomain && domain !== expectedDomain) {
    errors.push(`domain: the file says "${domain}" but is named for "${expectedDomain}"`);
  }
  const version = m.version;
  if (!Number.isSafeInteger(version) || (version as number) < 1) errors.push("version: required, a whole number from 1");

  const thresholds: Threshold[] = [];
  if (!("policy" in m)) {
    errors.push("policy: required, even if empty (policy: {}) - it is where every limit lives");
  } else if (m.policy !== null && (typeof m.policy !== "object" || Array.isArray(m.policy))) {
    errors.push("policy: expected rule IDs mapped to limits");
  } else {
    for (const [id, value] of Object.entries((m.policy ?? {}) as Record<string, unknown>)) {
      const t = compileEntry(id, value, errors);
      if (t) thresholds.push(t);
    }
  }
  if (errors.length) throw new RulesError(errors);

  // The prose HARD RULES are the human-readable mirror of the policy block.
  // A policy ID the prose never mentions is the drift v1.2 warns about, but
  // the ID scheme for prose rules is still open, so this warns, not refuses.
  const warnings = thresholds
    .filter((t) => !body.includes(t.id))
    .map((t) => `${t.id} is enforced by the gate but not mentioned in the prose rules`);

  const ruleIds = body.split("\n").flatMap((line) => {
    const r = RULE_LINE.exec(line);
    return r ? [r[1] ?? r[2]] : [];
  });

  return { domain: domain as string, version: version as number, meta: m, thresholds, ruleIds, body, raw, warnings };
}

// The version bump on save is the server's job, not the editor's: an owner who
// forgets to bump would otherwise publish a changed policy under the old
// version number, and every draft would cite a version that no longer says
// what it said. Rewrites only the version: line, leaving the rest of the file
// byte for byte as the owner wrote it.
export function withVersion(raw: string, version: number): string {
  const text = raw.replace(/\r\n/g, "\n");
  const { header } = splitFrontMatter(text);
  const re = /^version:[^\n#]*?(\s*#.*)?$/m;
  if (!re.test(header)) throw new RulesError(["version: line not found in the front matter"]);
  const newHeader = header.replace(re, (_l, comment = "") => `version: ${version}${comment}`);
  return text.replace(header, newHeader);
}
