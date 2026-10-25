# BizOS — Your AI Staff, Your Rules

**Built live at the Claude Impact Lab hackathon · thinkspace Seattle · Oct 25, 2026**

**Try it now, no install:** [live demo](https://enginkantar.github.io/bizos/web/demo.html)
(stage view: patient chat beside the owner's desk) ·
[owner desk](https://enginkantar.github.io/bizos/web/) ·
[patient chat](https://enginkantar.github.io/bizos/web/widget.html).
The hosted copy runs on built-in demo data; nothing you type leaves the page.

## What it does

**Try the demo:** [Owner desk](web/) · [Stage view: desk + widget](web/demo.html) ·
[Patient widget](web/widget.html?name=Dana&email=dana@example.com).
On GitHub Pages these are browser-local simulations: widget messages appear in the
demo desk in the same browser. No AI runs, nothing reaches a clinic, and approvals
send nothing. Use invented details. Run the local server below for the real API path.
See the [demo guide](web/README.md) for storage, reset behavior, and the rule-edit walkthrough.

If you run a small business, every email, DM, refund question, and new-hire
question lands on **you**. BizOS gives you an AI staff that handles them —
**following rules you wrote, not rules a vendor wrote.**

The demo business is Harbor Smile Dental (fictional, about 10 people). A patient
asks for a $500 refund; the AI drafts a reply, the Policy Gate blocks it because
the owner's rules cap refunds at $200, and nothing reaches the patient until the
owner approves.

## How it works (3 steps)

1. **Write your rules once** — plain Markdown files, one per department
   (`company.rules.md`, `front-desk.rules.md`, `billing.rules.md`). Each file
   carries a structured `policy:` block: limits live there, versioned.
2. **Messages flow in** through the web form → a router AI (Claude Haiku)
   reads each one and hands it to the right department AI.
3. **The department AI (Claude Sonnet) drafts a reply using only your rules** —
   and cites the rule it followed. Money limits are enforced by a **Policy Gate
   in code, compiled from the same rules file** — so the model and the code can
   never believe two different policies. Nothing is sent until you approve it in
   your queue; anything your rules don't cover is escalated instead of guessed.

[`docs/BizOS-Architecture.pdf`](./docs/BizOS-Architecture.pdf) walks a message
through all of it in six pages, with a diagram.

## Quick start

Needs [Node.js 24](https://nodejs.org/) or newer and a
[Claude API key](https://console.anthropic.com/).

```bash
git clone https://github.com/enginkantar/bizos
cd bizos
npm install
cp .env.example .env
```

Open `.env`, set `ANTHROPIC_API_KEY=` to your key, then:

```bash
npm start
```

Open http://127.0.0.1:3000 for the owner desk, `/widget.html` for the patient
chat and `/demo.html` for both side by side.

- On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`.
- The first start copies the dental starter pack into `business/`. Those are
  your files now: edit them in the desk's rules editor or any text editor, and
  the change applies to the next message, with no restart.
- No key yet? `npm start` still runs. The agents stay off and the desk works on
  drafts you post yourself; the demo buttons work too.
- `.env`, `business/` and the SQLite database (`data/bizos.db`) are
  gitignored. Keep them that way: they hold your key, your rules and your
  customers' messages.

The demo steps are in [`web/README.md`](./web/README.md#try-the-demo).

### Settings (`.env`)

| Setting | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Your Claude API key. Without it the agents are off |
| `ROUTER_MODEL` | `claude-haiku-5-5` | Picks the department for each message |
| `AGENT_MODEL` | `claude-sonnet-5-5` | Drafts the reply |
| `HOST`, `PORT` | `127.0.0.1`, `3000` | Where the server listens. Keep it on localhost: this build has no sign-in |
| `STARTER_TEMPLATE` | `dental-office` | The pack copied into `business/` on first start. Empty = never |
| `AGENTS` | `on` | `off` keeps the models off even with a key set |

## What's built today

| Working now | Not yet |
|---|---|
| Web form in, reply out (`POST /api/inbox`) | Email, SMS and other channels (one adapter each) |
| Router + drafter agents, citing rules and quoting them | More starter packs (coffee shop, machine shop, engineering firm) |
| Policy Gate: block or review by amount and action type, from `policy:` blocks only | Catching one refund split into several small ones ([#7](https://github.com/enginkantar/bizos/issues/7)) |
| Approval queue, urgent escalations first; approvals bound to the exact draft and rules version | Follow-up messages threaded into one case ([#25](https://github.com/enginkantar/bizos/issues/25)) |
| Live rules editing with version history and diffs | Owner sign-in, so the server can leave localhost |
| Outbox that sends each approved reply once, re-checking the gate | Flagging a rule sentence that disagrees with its limit ([#48](https://github.com/enginkantar/bizos/issues/48)) |
| Audit log of every message, draft, verdict and decision | |
| Owner desk, patient chat page and stage view, also hosted on GitHub Pages | |

`npm test` runs the server and web tests; `python3 tools/claimcheck/claimcheck.py`
checks the promises in [`claims.ini`](./claims.ini) (no keys committed, the gate
reads limits only from rules files, agent code cannot send).

## What's in this repo

- [`docs/BizOS-Architecture.pdf`](./docs/BizOS-Architecture.pdf) — the
  architecture walkthrough: how a message becomes an approved reply, the five
  parts, the safety guarantees.
- [`docs/API.md`](./docs/API.md) — the HTTP API and the rules-file format,
  with curl examples.
- [`BIZOS_DESIGN.md`](./BIZOS_DESIGN.md) — full design document v1.2
  (architecture, envelope format, Policy Gate, trust model, MVP plan).
  Adversarially reviewed by multiple AI models before build day.
- [`templates/`](./templates/) — industry starter rule packs: pick one,
  edit the limits, you're live.
- [`server/`](./server/) — Node + TypeScript server, SQLite, agents, Policy Gate.
- [`web/`](./web/) — owner desk and patient chat: plain HTML, CSS and JS, no build step.
- [`AGENTS.md`](./AGENTS.md), [`CONTRIBUTING.md`](./CONTRIBUTING.md) — how we
  work: branches, reviews, claims.

## Honest framing

App, rules, and records run under your control — your machine, your API key,
one SQLite file. The content needed to draft a reply goes to the Claude API.
"Free" means this source code; API usage is metered on your own key.

## License

MIT — see [LICENSE](./LICENSE).

---
*Team BizOS · Claude Impact Lab · Seattle 2026*
