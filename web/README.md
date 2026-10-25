# Owner desk, revision 1

A local UX demo for team feedback: cases, customer conversations, drafts and rule
citations, an approval queue, an audit feed, and editable rules on one screen.
The starting design comes from `UX.md` and the completed rev 1 in
`haplesshippo/bizos-scratch`, written for this hackathon.

## Run

With Node 24, run this one command from the repository root:

```sh
npm ci && npm run web
```

Open **http://127.0.0.1:5173/**. No environment variables, API keys, server,
database, or account are needed. The demo binds to localhost and refuses to pick
another port if 5173 is occupied. Stop with Ctrl+C. Refresh restores the fixtures.
The existing root `npm start` still launches the separate BizOS server.

```sh
npm run build               # server type-check, web lint and production build
npm test                    # server and demo-store behavioral tests
npm run lint                # web lint
npm run preview --workspace web # built UI on port 5173; stop dev first
```

The npm workspace shares the root lockfile and existing `install` CI check.
Dependencies are installed once at the root. Build output in `web/dist/` and
`node_modules/` is ignored.

## Try the two demo moments

1. **Reset demo** loads five invented cases with rules v3 and a $200 refund cap.
   Alex's $500 unsafe suggestion is blocked with its audit event visible.
2. Add a **$225 request**. It is blocked at v3. Click its **REFUND-CAP** citation
   to select the exact line in the rules editor beside the case on desktop.
3. Change `max_amount_cents: 20000` to `max_amount_cents: 25000`.
   The readout shows **Unsaved preview**. **Save rules** activates v4, displays
   the saved diff, and marks pending approvals for a fresh check.
4. Add another **$225 request**. The new draft cites v4, mentions $250, and is
   **HELD**. **Review reply** selects it in the queue. **Approve reply** records
   **Approved locally**, explicitly without sending a message or making a payment.
5. **Unsafe $500** remains blocked at the new cap. This is a deliberately unsafe
   fixture suggestion, not an adversarial model test.

**Support question** simulates an hours reply. **Sales lead** adds a held draft.
Reject escalates locally. A seeded international shipping rules gap requires a
person; adding a rule from that gap is outside this revision. **Start empty**
shows empty states. **Reset demo** restores cases, rules, counts, and demo time.
Search and status filters narrow cases. Approval and audit paging keep entries
readable. Click a queue customer's name to read the full draft. On phones the
panels stack and cases scroll horizontally. Alt+1 through Alt+4 add fixtures.

## What is simulated

- All customers, messages, drafts, decisions, counts, and timestamps are fixture
  data. The deterministic clock is labeled demo time. Local templates draft
  replies; no model is called. There are no claimed latency, trust, or savings
  metrics.
- State lives only in browser memory. No API, database, channel, email service,
  payment system, or persistence is connected. Tabs do not share state. Approval
  records a local decision; it never sends or pays. Simulated replies are labeled.
- The browser parses one demo `company.rules.md` string for template answers and
  per-suggestion refund checks. This illustrates the workflow and is **not a
  production security boundary** or the server's Policy Gate. It does not cover
  cumulative refunds, relabeled actions, authentication, or prompt injection.
- Invalid saves preserve active rules and version. Existing drafts retain their
  original policy snapshot. Recheck creates a new draft version. Local approvals
  bind the shown draft/rules versions, recipient, channel, and action. These
  checks confer no client-side security guarantee.

## Code boundary and later API integration

`src/demo-store.js` owns fixtures, rules, and local decisions. Its public methods
are `snapshot`, `inject`, `saveRules`, `recheck`, `review`, and `reset`.
`src/app.js` renders snapshots; `src/style.css` owns layout. Tests exercise the
store interface, including thresholds, invalid saves, stale approvals and reset.

Corresponding draft fields use the API's `rules_version`, `amount_cents`,
`action_type`, `rule_citations`, and `gate_verdict`; the case's `reply_to` supplies
the displayed recipient. Channel/domain values use `webform`/`email` and
`support`/`sales`. The fixture store is not a complete API response schema:
`simulated`, `gap`, and `rejected` are local presentation states, citations are
arrays, and approved means only locally recorded.

Follow [docs/API.md](../docs/API.md) and the merged approval flow at
https://github.com/enginkantar/bizos/pull/5 for a later live adapter:

- Poll cases, approvals, and audit at the documented two-second interval, with
  asynchronous loading, empty, and error states. Load case detail separately.
- Replace browser parsing with the server's compiled policy, versions, verdicts,
  and rule saves using `expected_version`. Handle 409 conflicts and 422 errors.
- Submit the draft ID and exact versions displayed. Take recipients from verified
  case records. Only confirmed delivery can show `sent`; render pending, failed,
  and unknown delivery states as well. Approval is permission to reply, never pay.
- Coordinate live serving and fixture injection with the server owner. This
  revision deliberately has no live mode or base-URL switch.
