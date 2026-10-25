# Owner desk, revision 2

Plain HTML, CSS and ES modules. No build step, browser dependencies, remote fonts,
CDNs or scripts. The same `web/` folder works at `/` and under a GitHub Pages
project path. Serve it over HTTP, rather than opening a `file:` URL.

From the repository root, `npm run web` serves fixtures at http://127.0.0.1:5173/
using Python's standard-library static server. No npm install is needed for the UI.
Refresh resets demo data. The persistent ribbon identifies fixture mode.

The first `/api/rules` request selects live mode if the API responds. A failed
initial request loads synthetic dental fixtures. Later live failures preserve
last-loaded live data and show an error; they never silently switch to fixtures.

For live mode, the Node server must serve `web/` at `/` on its own origin. The
current base branch has JSON routes only. Static serving is Petr's separate
server change and is a dependency for `npm start` to show this UI. This PR does
not modify the server. GitHub Pages is a demo fallback, with no localhost bridge.

Try the demo:

1. The $500 refund shows `Gate: BLOCK`, `Status: blocked`, and
   `Blocked by REFUND-CAP: $200`.
2. Approve the hours reply in one tap. Its gate PASS still required approval.
   Demo approvals remain local and never send a message or make a payment.
3. Edit company.rules.md, changing `max_amount_cents: 20000` to `25000`.
   Save shows v4 and the diff. Add a $225 request to see a held draft under v4.
   Earlier held drafts retain v3 and require rechecking.
4. Click KNOW-HOURS to highlight the cited rule. Live mode finds the right file
   among API-provided domains (company, front-desk, billing in the dental pack).

Live policy readouts come only from API-compiled policy. Rules saves use
`expected_version`; 422 refusals explain that nothing was saved, and 409 errors
ask the owner to reload/recheck. Approval submits the displayed draft and rules
versions. Only a server-confirmed `sent` case is shown as sent.

Demo controls submit labeled synthetic inbound messages and canned suggestions
to the real gate in live mode. They do not call a model. The local fixture editor
is intentionally limited to the displayed amounts and hours; it is a simulation,
not a YAML parser or a security boundary. Live edits support the full server format.
The fixtures illustrate the team's $200 REFUND-CAP storyline. The current starter
pack has different money policies; live mode always shows the real server verdict.

`npm test` runs server and dependency-free web behavioral tests. `npm run build`
type-checks the server; `npm run lint` checks JavaScript syntax.
