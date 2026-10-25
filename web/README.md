# Owner desk, revision 3

Plain HTML, CSS and ES modules. No build step, browser dependencies, remote fonts,
CDNs or scripts. The same `web/` folder works at `/` and under a GitHub Pages
project path. Serve it over HTTP, rather than opening a `file:` URL.

`npm start` serves this desk at `/` beside the API (live mode). From the repository
root, `npm run web` serves it alone at http://127.0.0.1:5173/ with synthetic dental
fixtures, using Python's standard-library static server. Refresh resets demo data;
the top bar says "Demo data · server offline" in that mode.

The first `/api/rules` request selects live mode if the API responds. A failed
initial request loads the fixtures. Later live failures keep the last live data and
show a notice; they never silently switch to fixtures.

## Layout (1440x756 and up)

- **Top bar:** BizOS, the pack badge, counts (received, drafted, approved, blocked),
  the rules pill for the file behind the case on screen (`RULES company · v4`, from
  the API, flashes when any file's version moves), the live heartbeat, and a link to
  the stage view `/demo.html`.
- **Cases:** filter tabs All / Gate Hold / Blocked / Sent. Gate Hold is the server's
  approval queue (`GET /api/approvals`): escalations first, with a rose URGENT pill.
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

1. **New patient** posts the inquiry; approve it and the reply appears in the thread.
2. **$500 refund** is blocked by REFUND-CAP ($200, company.rules.md).
3. Edit `max_amount_cents: 20000` to `60000` in company.rules.md and save, then
   **Re-run same request**: BLOCK becomes REVIEW, held for the owner.
4. Close on the Activity tab and the header counts.

The Simulate buttons post labeled synthetic messages and scripted drafts to the real
gate; they never call a model. The fixture editor in demo mode only accepts changes
to the displayed amounts and hours; it is a simulation, not a security boundary.

`npm test` runs server and dependency-free web behavioral tests. `npm run build`
type-checks the server; `npm run lint` checks JavaScript syntax.
