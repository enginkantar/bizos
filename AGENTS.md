# BizOS — rules for every agent and every human in this repo

**BizOS** is a self-hosted AI front desk for small businesses. The owner writes rules once in plain
Markdown files; AI staff follow them; hard limits are enforced in code by a Policy Gate. Built at
the Claude Impact Lab hackathon, Seattle, October 25 2026, open source under MIT.

**[BIZOS_DESIGN.md](BIZOS_DESIGN.md) (v1.2) is the source of truth, and [DAY_PLAN.md](DAY_PLAN.md)
is the schedule.** Where anything here disagrees with them, they win; ask before guessing.

Claude Code reads this file through `CLAUDE.md`. Other agents read it directly.

---

## 🔴 Git rules — no exceptions, including for agents

1. **Never commit to `main`.** Branch protection enforces this once a repo admin turns it on; until then it is on us. Every piece of work starts with:
   ```bash
   git switch main && git pull && git switch -c <area>/<short-what>
   ```
   Areas: `server/`, `web/`, `prompts/`, `rules/` (templates and rules files), `test/`, `docs/`,
   `ci/`. Example: `server/policy-gate`, `web/approval-queue`, `rules/coffee-shop`.
2. **One branch, one change.** Small PRs merge fast; a three-hour branch conflicts with everything.
   Aim for a PR every 30–60 minutes.
3. **Open a PR only when it works.** Before `gh pr create`:
   - `python3 tools/claimcheck/claimcheck.py` — every claim held
   - `npm install && npm start` still starts from a clean checkout
   - you **tried the thing you changed**, and the PR says how. "Looks like it works" is not a PR
4. **Every PR needs one approving review** from someone who did not write it, and passing
   `claims` and `install` checks. **Petr merges** (DAY_PLAN: owns the repo and every merge);
   squash-merge, then delete the branch. No merges while eating.
5. **After the 15:30 freeze:** bug fixes only, and P0 fixes need Engin's sign-off. The last good
   state is tagged `demo-good`; rollback is checking out that tag and restarting.
6. **Never force-push a shared branch, never rewrite `main`, never push to someone else's branch**
   without asking them.
7. **Stay in your area.** Parallel sessions collide when two of them edit the same file. Roles from
   DAY_PLAN.md:

   | area | owner |
   |---|---|
   | server, SQLite, API, Policy Gate, dashboard scaffold, repo and merges | Petr |
   | orchestrator and agent prompts, rules files, `templates/`, synthetic test messages | Siddharth (rules content with Engin) |
   | acceptance tests, negative tests, clean-install check, demo script | Sohara |
   | `BIZOS_DESIGN.md`, `DAY_PLAN.md`, Policy Gate spec, final sign-off | Engin |

   The API contract (routes, types, the `policy:` format) is frozen at 11:00 and changes **only in a
   PR that Engin and Petr both review.**

   **A blocker older than 10 minutes goes to Engin.**

## 🔴 Everything committed here is public, forever

The repo is public and git history does not forget. A secret removed in a later commit is still
published, and the only fix for a leaked key is revoking it.

- **No API keys, tokens or passwords** — not in code, tests, fixtures, docs or comments. Keys live
  in `.env`, which is gitignored. `.env.example` holds placeholders only
- **No database files.** The SQLite file holds every message typed into the demo
- **No real customer data in fixtures.** Use `example.com` addresses, `555-01xx` phone numbers and
  invented names
- **Scan your diff before every commit.** The `claims` check catches the common shapes; it does
  not catch everything

## Claims

`claims.ini` lists what this project promises is true, each with a cheap proof and a `why`.

- 🔴 **Never relax or delete a claim to get a check green.** A claim loosened to pass is a check
  that cannot fail. If a claim is wrong, say so in the PR and change it deliberately.
- **Add a claim when something breaks silently today** — the demo still ran, nothing errored, and
  a promise was quietly false. Read the `why` fields for examples.
- **Falsify every new claim once:** break the thing it guards, watch it fail, put it back.
- On Windows, run the checker from any shell; it uses Git for Windows' bash for the proofs.

## Built today, from scratch

The event rule is **nothing pre-built**: all application code is written at the event. The only
code carried in is `tools/claimcheck/` (MIT, from the author's own public repository) — repo
tooling, not application code. Do not paste code from other projects; describe the pattern and
write it fresh.

## How we write things

- **Comments say why**, not what. The code says what it does.
- **Commit messages say what is now true and how it was checked.**
- **The rules file is the product.** A `policy:` block is the single source of every limit; the
  agent's context and the gate's checks both compile from it. Never add a second place a limit
  can live.
