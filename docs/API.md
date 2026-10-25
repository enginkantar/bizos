# BizOS API

How to run the server and talk to it. For **why** it works this way, see
[BIZOS_DESIGN.md](../BIZOS_DESIGN.md); for the rules file format in depth, see the
[policy section](#the-policy-block) below.

Everything is JSON over HTTP on `http://127.0.0.1:3000`. There is no sign-in yet, which
is why the server listens on localhost only by default.

---

## Run it

You need **Node 24** (`node --version`).

```bash
npm install
cp .env.example .env      # add ANTHROPIC_API_KEY; the server starts without it
npm start                 # or `npm run dev` to restart on every save
```

| setting (`.env`) | default | what it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | needed once the agents call Claude; `/api/health` says whether it is set |
| `HOST` | `127.0.0.1` | keep it on localhost: rule edits have no sign-in |
| `PORT` | `3000` | |
| `RULES_DIR` | `business` | where `<domain>.rules.md` files are read from (gitignored: the business's own data) |
| `STARTER_TEMPLATE` | `dental-office` | on first start, if `RULES_DIR` doesn't exist, copies `templates/<name>/` into it. Empty = never |
| `DB_PATH` | `data/bizos.db` | one SQLite file; gitignored, never commit it |
| `ROUTER_MODEL` / `AGENT_MODEL` | `claude-haiku-5-5` / `claude-sonnet-5-5` | Haiku routes, Sonnet drafts |

Checks before a PR: `npm run build` (type-check), `npm test`, and
`python tools/claimcheck/claimcheck.py`.

---

## Conventions

- **Money is always integer cents.** `amount_cents: 19999` is $199.99. Never send or
  expect a float amount.
- **Errors** are `{ "error": "<code>" }` with a 4xx/5xx status, plus extra fields where
  noted (`errors`, `current_version`).
- **The UI polls** `/api/cases` and `/api/approvals` every 2 seconds. There is no
  websocket or server-sent events stream in v1.
- Timestamps are ISO-8601 strings in UTC.

---

## Routes

| route | status | |
|---|---|---|
| `GET /api/health` | ✅ live | is it up, is a key set |
| `POST /api/inbox` | ✅ live | a customer message arrives |
| `GET /api/cases` | ✅ live | list of conversations |
| `GET /api/cases/:id` | ✅ live | one conversation with drafts and outbox |
| `GET /api/rules` | ✅ live | every rules file and the limits it enforces |
| `GET /api/rules/:domain` | ✅ live | one rules file, including its text |
| `PUT /api/rules/:domain` | ✅ live | save an edited rules file |
| `GET /api/audit` | ✅ live | the latest 100 events |
| `POST /api/cases/:id/drafts` | ✅ live | an agent (or a test fixture) proposes a reply; the gate decides |
| `GET /api/approvals` | ✅ live | drafts waiting for the owner |
| `POST /api/approvals/:id` | ✅ live | approve or reject one draft |

### `GET /api/health`

```json
{ "ok": true, "api_key_configured": false }
```

### `POST /api/inbox`

The channel-agnostic envelope (design §4). The chat widget, a webhook or a test script
all send this.

```bash
curl -X POST http://127.0.0.1:3000/api/inbox \
  -H "content-type: application/json" \
  -d '{
    "message_id": "widget-0001",
    "source": "webform",
    "reply_to": "customer@example.com",
    "customer": { "name": "Dana" },
    "content": { "type": "text", "text": "Can I get a refund for my order?" }
  }'
```

| field | required | meaning |
|---|---|---|
| `source` | yes | the channel: `webform`, `email`, `whatsapp`… |
| `message_id` (or `source_message_id`) | yes | the channel's own id for this message. **Resending the same id on the same channel creates no second case** |
| `reply_to` | yes | where the reply goes. Stored on the case; replies never go anywhere else |
| `content.text` | yes | the message |
| `customer.name` | no | shown in the UI |
| `received_at` | no | defaults to now |

Responses:

- `201 { "case_id": "…", "duplicate": false }`: a new case
- `200 { "case_id": "…", "duplicate": true }`: seen before; same case, nothing written
- `400 { "error": "missing_source" }` (or `missing_reply_to`, `missing_content.text`, …)

The widget should generate a fresh `message_id` per message (`crypto.randomUUID()`), and
reuse it only when retrying the same send.

### `GET /api/cases`

Newest first, up to 200.

```json
[
  {
    "id": "e8d7e4b8-…",
    "channel": "webform",
    "customer": "Dana",
    "status": "new",
    "domain": null,
    "created_at": "2026-10-25T17:49:30.580Z",
    "updated_at": "2026-10-25T17:49:30.580Z"
  }
]
```

**`status`** is one of:

| status | meaning |
|---|---|
| `new` | arrived, not routed yet |
| `routed` | the orchestrator picked a department (`domain`) |
| `drafted` | a department agent wrote a reply |
| `held` | the reply waits in the approval queue |
| `approved` | the owner approved it; it is in the outbox |
| `sent` | delivered |
| `blocked` | the Policy Gate refused it |
| `escalated` | a person must handle it (lawyer, fraud, or the owner rejected the draft) |
| `quote_sent` | a quote went out; a follow-up can be drafted |

### `GET /api/cases/:id`

The case, plus everything attached to it. `404 { "error": "case_not_found" }` if unknown.

```json
{
  "id": "e8d7e4b8-…",
  "channel": "webform",
  "reply_to": "customer@example.com",
  "customer": "Dana",
  "status": "held",
  "domain": "support",
  "created_at": "…",
  "updated_at": "…",
  "messages": [
    { "id": "…", "direction": "in", "text": "Can I get a refund…", "received_at": "…" }
  ],
  "drafts": [
    {
      "id": "…",
      "version": 1,
      "text": "Sorry about that! I can refund $150.00 …",
      "domain": "support",
      "rules_version": 3,
      "rule_citations": "[\"REFUND-APPROVAL\"]",
      "amount_cents": 15000,
      "action_type": "refund",
      "gate_verdict": "review",
      "gate_policy_id": "REFUND-APPROVAL",
      "gate_reason": "$150.00 is over REFUND-APPROVAL ($120.00)",
      "rules_versions": "{\"support\":3}"
    }
  ],
  "outbox": [
    { "id": "…", "draft_id": "…", "state": "pending", "attempts": 0, "last_error": null }
  ]
}
```

- `reply_to` is the verified recipient from the channel. **Show this as "To:" on a draft.**
  Never show an address the model wrote.
- `rule_citations` is a JSON string of rule IDs; `JSON.parse` it for the chips.
- `gate_verdict` is `pass`, `review` or `block`. On `block`, show the red banner with
  `gate_policy_id`: *"Blocked by REFUND-CAP"*.
- `outbox[].state` is `pending → processing → sent | failed | delivery_unknown`.

### `GET /api/rules`

Every rules file in `RULES_DIR`, with the limits the gate **actually enforces**, compiled
from its `policy:` block.

```json
[
  {
    "domain": "support",
    "version": 3,
    "policy": [
      { "id": "REFUND-CAP", "limit_cents": 20000, "outcome": "block", "applies_to": "*" },
      { "id": "REFUND-APPROVAL", "limit_cents": 12000, "outcome": "review", "applies_to": "*" }
    ],
    "warnings": ["REFUND-APPROVAL is enforced by the gate but not mentioned in the prose rules"],
    "error": null
  }
]
```

- `outcome` is `block` or `review` (the file's `draft_for_approval` shows as `review`).
- `applies_to` is `"*"` (every money action) or a list like `["refund"]`.
- `error` is set when the file **on disk** is broken, e.g. after an edit in a text
  editor: `{ "errors": ["…"], "at": "…" }`. `version` and `policy` are then the **last good**
  version, which is still the one enforced. Show both.
- An empty list means no rules are loaded: the server log says to copy a starter pack
  from `templates/`.

### `GET /api/rules/:domain`

The same object as one list entry, plus `"content"`: the whole file as text, for the
editor. `404 { "error": "rules_not_found" }` if there is no such file.

### `PUT /api/rules/:domain`

Save an edited file. Send the **whole file** and the version you loaded:

```json
{ "content": "---\ndomain: support\nversion: 3\n…", "expected_version": 3 }
```

- **The server sets the version**: it saves as `expected_version + 1` whatever the
  `version:` line in `content` says, so nobody has to remember to bump it.
- `200`: the same shape as `GET /api/rules/:domain` without `content`, plus
  `previous_version` and `diff`: a list of `{ "op": "same" | "add" | "del", "text": "…" }`
  lines, for showing the change v3 → v4.
- `422 { "error": "invalid_rules", "errors": ["policy REFUND-CAP: unknown key \"max_ammount_cents\"", …] }`:
  every problem at once. **Nothing was saved**; the old version is still enforced.
- `409 { "error": "version_conflict", "current_version": 4 }`: someone saved since you
  loaded. Reload, then re-apply the edit.
- The change is written to the audit log with the changed lines.

The gate reads the new limits on its very next check: no restart.

### `GET /api/audit`

The latest 100 events, newest first.

```json
[
  { "id": 2, "at": "…", "case_id": null, "event": "rules_updated",
    "detail": "{\"domain\":\"support\",\"from_version\":3,\"to_version\":4,\"changes\":[…]}" },
  { "id": 1, "at": "…", "case_id": "e8d7e4b8-…", "event": "received",
    "detail": "{\"channel\":\"webform\",\"source_message_id\":\"widget-0001\"}" }
]
```

`detail` is a JSON string.

### `POST /api/cases/:id/drafts`

The one door every proposed reply comes through: department agents call it, and so does
the demo's labeled **"unsafe suggestion"** fixture. The model proposes; this decides.

```json
{
  "domain": "support",
  "text": "Sorry about that! I can refund $150.00 to your card.",
  "rule_citations": ["REFUND-APPROVAL"],
  "action": { "type": "refund", "amount_cents": 15000 },
  "route": "draft_for_approval"
}
```

| field | required | meaning |
|---|---|---|
| `domain` | yes | which rules file applies |
| `text` (or `reply`) | yes | the reply. `reply` is the agent output contract's name for it (#29) |
| `rule_citations` | no | rule IDs the reply relied on. **Only an ID defined exactly once in the rules in force counts** (see below); anything else holds it for the owner |
| `evidence` | no | `[{ "rule_id", "quote" }]`: which rule backs which claim, **in the rule's own words**. Each `rule_id` also counts as a citation. A quote that doesn't appear in the rule it cites holds the reply (see below) |
| `missing_info` | no | `["preferred days and times"]`: what the agent still needs from the customer. Stored and shown on the approval card |
| `action` | no | the money the reply commits to. The gate checks `amount_cents` against the `policy:` limits for `type` |
| `route` | no | the orchestrator's verdict: `auto_reply`, `draft_for_approval` (default) or `human_now` |

**An agent's output can be posted as-is** (issue #29), with `domain` added:

```json
{
  "domain": "front-desk",
  "reply": "Yes, we see children from age 3. Would you like us to book a first visit?",
  "evidence": [{ "rule_id": "KNOW-CHILDREN", "quote": "we see children from age 3" }],
  "missing_info": ["preferred days and times"],
  "action": null,
  "route": "draft_for_approval"
}
```

`201`:

```json
{
  "draft_id": "…", "version": 1,
  "verdict": "review", "policy_id": "REFUND-APPROVAL",
  "reasons": ["$150.00 is over REFUND-APPROVAL ($120.00)"],
  "status": "held", "outbox_id": null
}
```

How `status` is decided:

| when | `status` |
|---|---|
| the gate says `block` | `blocked`: nothing is queued, whatever the route |
| `route: human_now` | `escalated` |
| anything else, **including `pass` with `route: auto_reply`** | `held`: in the approval queue |

**Auto-send is off** (decision 2, Oct 25): no reply reaches a customer without the owner's
approval, whatever the route. A clean `auto_reply` draft is held with the reason
`auto-send is off: every reply waits for the owner`, and `outbox_id` is always `null` here.

A reply is also held, never sent, when its **text** mentions a dollar amount above the
validated `amount_cents` (or any amount when there is no `action`), or when its citations
don't hold up. A citation counts only if the ID is **defined exactly once** in the rules in
force (the department's file plus `company.rules.md`), as a `policy:` key or as the ID that
**starts a rule line**: `- REFUND-CAP: …` or `- [S-2] …`. No citation, an unknown ID, an ID
defined twice, or a word that merely appears in the file (`the`, a heading, an ID mentioned
inside a sentence) holds the reply; the reason names the ID.

**Evidence quotes are checked too.** A real rule ID with invented content must not pass, so
each `quote` must appear in the text of the rule its `rule_id` starts: the rule line plus
its wrapped lines, in the department's file or `company.rules.md`. Case and spacing are
ignored; the words are not. Otherwise the reply is held with
`quotes a rule that does not say this: KNOW-CHILDREN ("we see children from age 1")`.
An ID that exists only as a `policy:` key has no rule text, so quote its prose rule line
instead.

`404 { "error": "case_not_found" }`; `400` for a missing field, `invalid_evidence` (not a
list of non-empty `rule_id` and `quote` strings) or `invalid_missing_info` (not a list of
non-empty strings).

The **$500 fixture** for the demo:

```bash
curl -X POST http://127.0.0.1:3000/api/cases/$CASE_ID/drafts \
  -H "content-type: application/json" \
  -d '{"domain":"support","text":"Sure, refunding $500 now.","rule_citations":["REFUND-CAP"],
       "action":{"type":"refund","amount_cents":50000},"route":"auto_reply"}'
# -> "verdict": "block", "policy_id": "REFUND-CAP", "status": "blocked"
```

### `GET /api/approvals`

Drafts waiting for the owner: the newest draft of every `held` case, oldest first.

```json
[
  {
    "draft_id": "…",
    "case_id": "…",
    "draft_version": 1,
    "rules_version": 3,
    "domain": "support",
    "customer": "Dana",
    "recipient": "customer@example.com",
    "channel": "webform",
    "text": "Sorry about that! I can refund $150.00 …",
    "amount_cents": 15000,
    "rule_citations": ["REFUND-APPROVAL"],
    "gate_verdict": "review",
    "gate_policy_id": "REFUND-APPROVAL",
    "gate_reason": "$150.00 is over REFUND-APPROVAL ($120.00)",
    "evidence": [{ "rule_id": "REFUND-APPROVAL", "quote": "refunds over $120 wait for the billing coordinator" }],
    "missing_info": [],
    "created_at": "…"
  }
]
```

`rule_citations`, `evidence` and `missing_info` are already lists here. `gate_reason` says
why it is waiting: show it under the draft. Show one chip per `evidence` item (rule ID and
quote), and the `missing_info` the reply asks for. In `GET /api/cases/:id`, a draft's
`evidence` and `missing_info` are JSON strings, like `rule_citations`.

### `POST /api/approvals/:draft_id`

The **"Approve reply"** button. It approves sending a message, never a payment.

```json
{ "decision": "approve", "draft_version": 1, "rules_version": 3 }
```

Send back the `draft_version` and `rules_version` **you showed the owner**. If either has
changed since, the approval is void:

- `200 { "case_id": "…", "status": "approved", "outbox_id": "…" }`: queued to send.
  Clicking twice is safe: the second click returns the same result and sends nothing more.
- `200 { "case_id": "…", "status": "escalated" }` for `"decision": "reject"`
- `409 { "error": "stale_draft" }`: a newer draft exists; reload the queue
- `409 { "error": "rules_changed", "current_rules_version": 4 }`: the rules were edited
  after this draft was checked; it goes back through the gate
- `422 { "error": "blocked", "policy_id": "REFUND-CAP" }`: the gate re-ran with the
  current rules and refuses it
- `409 { "error": "not_awaiting_approval", "case_status": "…" }`: the case is not held
- `400` for a bad `decision` or a missing version

After an approval the reply is sent at once: the case moves to `sent` and the reply
appears in its `messages` with `direction: "out"`. **The gate runs again at send time**, so
if the rules were tightened in between, the send fails, the case becomes `blocked`, and the
outbox entry's `last_error` says which rule. Replies only go to the case's `reply_to`.

---

## The `policy:` block

Every `<domain>.rules.md` starts with YAML front matter. The `policy:` block is the only
place a limit lives: the agent reads the file and the gate compiles its limits from the
same parse, so they can never disagree.

```yaml
---
domain: support          # must match the file name: support.rules.md
version: 3               # the server bumps this on every save
policy:
  REFUND-CAP:      { max_amount_cents: 20000, above: block }
  REFUND-APPROVAL: { over_cents: 12000, action: draft_for_approval }
  DISCOUNT-CAP:    { max_amount_cents: 5000, above: block, applies_to: discount }
---
## HARD RULES
- REFUND-CAP: never refund more than $200.
…
```

- **A limit trips when the amount is strictly over it.** `over_cents: 12000` allows
  $120.00 and holds $120.01.
- `above:` (with `max_amount_cents`) or `action:` (with `over_cents`) is `block` or
  `draft_for_approval`.
- `applies_to` (optional) is an action type or a list: `refund`, `discount`, `quote`…
  Without it the limit covers **every** money action.
- **The strictest tripped limit wins:** block beats review, then the lower limit.
- `company.rules.md` limits apply to every department, alongside the department's own.
- **Unknown keys, non-whole-cent amounts and a missing `policy:` are refused**, with every
  problem listed. Use `policy: {}` for a department with no limits.
- **An empty `policy:` and a rule ID outside the block are refused too.** One indentation
  slip (`REFUND-CAP:` not indented under `policy:`) used to load the file with zero limits
  and save with a 200. Now the save gets a 422 naming the line, and the old limits stay in
  force (issue #22).
- A policy ID that the prose never mentions loads, with a warning: the prose is the
  human-readable mirror of the block.
- **A rule line starts with its ID:** `- REFUND-CAP: …` or `- [S-2] …`. Those IDs and the
  `policy:` keys are the only things a draft can cite. Define each ID once across a
  department's file and `company.rules.md`; a duplicate makes every draft citing it wait for
  the owner.
- **The gate fails closed:** a department with no rules file goes to review, and a
  malformed amount is blocked.
  - A department with no rules file **still gets the company limits**: a company block
    still blocks. The department name comes from the model, so an invented one must not
    dodge `company.rules.md`.
  - If `company.rules.md` exists but **has never loaded**, every department goes to review
    until it's fixed. If it broke after loading, its last good version stays in force.
- **An action type no rule names goes to review** whenever the rules in force scope any
  limit with `applies_to`. The type comes from the model, so a $500 refund proposed as
  `store_credit` must not skip the refund limits (issue #7). Rules that never use
  `applies_to` cover every type with every limit, so nothing changes there.
- **Keep one cap without `applies_to`** in `company.rules.md` as a backstop: it blocks any
  money action over it, whatever the label. The dental pack's `MONEY-CAP` blocks anything
  over $5,000.
