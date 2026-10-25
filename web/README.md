# Owner desk, revision 3

Plain HTML, CSS and ES modules. No build step, browser dependencies, remote fonts,
CDNs or scripts. The same `web/` folder works at `/` and under a GitHub Pages
project path. Serve it over HTTP, rather than opening a `file:` URL.

`npm start` serves this desk at `/` beside the API (live mode). From the repository
root, `npm run web` serves it alone at http://127.0.0.1:5173/ with synthetic dental
fixtures, using Python's standard-library static server. The top bar says
"Demo data · server offline" in that mode. The fixtures are trimmed
copies of the dental pack at the versions a fresh install seeds (company v4 with
REFUND-CAP $200, billing v3 with REFUND-APPROVAL $120, front-desk v2), and the fixture
editor opens any of the three files.

`/widget.html` probes `/api/health` on load. With no server it uses the
[browser-local demo](../README.md#what-it-does). Submissions use `localStorage`,
scoped to the same origin and site path, including a Pages project path. Each saved
submission becomes one urgent review case with a placeholder draft. The desk polls
every two seconds while no desk form is focused and no action is pending. Browser
storage must be allowed; a failed widget save shows an error.

Reloading the desk resets rule edits and decisions, then imports saved widget
submissions again as undecided cases. **Start empty** and **Reset demo** ignore older
submissions for the current desk run without deleting them from storage. Clear the
site's browser storage to delete saved intake. **Handle in person** removes an
imported case from the review queue even after a rules edit; approval under stale
rules remains blocked.

The first `/api/rules` request selects live mode if the API responds with a rules
list. A failed initial request or a response without a rules list loads the fixtures.
Later live failures keep the last live data and show a notice; they never silently
switch to fixtures.

## Layout (1440x756 and up)

- **Top bar:** BizOS, the pack badge, counts (received, drafted, approved, blocked),
  the rules pill for the file behind the case on screen (`RULES company · v4`, from
  the API, flashes when any file's version moves), the live heartbeat, and a link to
  the stage view `/demo.html`.
- **Cases:** filter tabs All / Waiting / Blocked / Sent. Waiting is the server's
  approval queue (`GET /api/approvals`): escalations first, with a rose URGENT pill.
  A held case whose draft passed the gate reads OWNER REVIEW; one the gate held
  (money over an approval threshold) reads GATE HOLD.
  Each row shows only the customer, the status pill and the department.
- **Case:** the message thread, and a pinned gate box. Held drafts get the amber
  gate box with Approve & Send (approves the shown draft and rules versions) and
  Escalate (the reject decision). Blocked drafts get the banner
  `BLOCKED: <policy> · Requested · Maximum permitted · Rules version` and
  **Re-run same request**, which posts the newest draft again so the gate judges it
  under the current rules. The agent's `evidence` shows as Supporting information,
  `missing_info` as Required information.
- **Rules & gate:** the file and limits behind the case, each citation with its quote
  or rule line, and the gate result exactly as the API stored it, plus the draft
  history. **Activity** is the audit feed.
- **Rules editor:** opens in the middle column from the rules pill, a citation, or
  the inspector. Saving shows the version bump and the diff.

## Try the demo

1. **New patient** creates a scripted inquiry and draft. In live mode, approve it
   and the reply appears in the thread; offline approval only records the decision.
2. **$500 refund** is blocked by REFUND-CAP ($200, company.rules.md).
3. In company.rules.md, change the limit in **both** places, then save:
   - the policy line: `max_amount_cents: 20000` to `60000`
   - the REFUND-CAP sentence: "never refund more than $200" to "$600"

   Then **Re-run same request**: BLOCK becomes REVIEW, held for the owner. Edit both
   lines: the gate reads the number, but the AI reads the whole file, so a stale
   "$200" sentence can end up quoted in its reply. Nothing checks yet that the
   two match.
4. Close on the Activity tab and the header counts.

In live mode, the Simulate buttons post labeled synthetic messages and scripted
drafts to the real gate; offline, they update only the fixture desk. They never call
a model. The fixture editor in demo mode only accepts changes to the displayed
amounts and hours; it is a simulation, not a security boundary.

`npm test` runs server and dependency-free web behavioral tests. `npm run build`
type-checks the server; `npm run lint` checks JavaScript syntax.
