# BizOS — Build Day Plan (Sun Oct 25)

**What we build:** the BIZOS_DESIGN.md MVP — Orchestrator (Haiku) routes incoming messages → department agents (Sonnet, Sales + Support) draft replies **citing the business's own rules files** → a **Policy Gate in code** (not AI) enforces money limits → anything uncovered waits in the owner's approval queue.
**Stack:** Node + TypeScript + SQLite (one file, WAL, `UNIQUE(channel, source_message_id)`), `npm install && npm start`, MIT.
**One source of truth:** each rules file starts with a structured YAML block (version, rule IDs, limits). Both the model's context AND the Policy Gate are compiled from that block — no separate gate config to drift. Editing the file changes both.
**Not building today:** real payments, live email/IMAP (positioning only; adapter only if time after 2:30), CRM, Academy (stretch), auto rule-editing.

*Times assume doors ~9:00; shift everything with the official schedule.*

## Roles (4 people, one owner per piece)

| Role | Owner | Owns |
|---|---|---|
| **Chief Architect / Product** | Engin | Design calls, Policy Gate spec, rules content (with Siddharth), final sign-off on every piece — floats to unblock anyone |
| **Lead Engineer** | Petr | Backend core: server, SQLite (UNIQUE + outbox), API, Policy Gate + the minimal dashboard scaffold. Owns the repo and every merge — and drives the live demo on stage |
| **Coordinator + Prompt Engineer** | Siddharth | Calls the gates out loud, tracks blockers, owns the submission form. The AI brain: orchestrator + agent prompts, rules files + 3 industry templates (with Engin), synthetic test messages, pitch numbers |
| **QA + Demo** | Sohara | Tests everything against the acceptance checklist, negative tests, the 14:00 clean-install on her laptop, demo script + slides + the 4:15 video — co-presents: she tells the story, Petr drives |

Rule of the day: a blocker older than 10 minutes goes to Engin. No silent stalling.

## Timeline

*Every slot has ONE thing to PROVE. Siddharth calls each gate out loud. A slipping slot cuts scope — never pushes time.*

| Time | Prove |
|---|---|
| 9:00–10:30 | Kickoff: scope locked, Adam's two answers (model requirement? fresh-code rule confirmed?), **everyone applies on the portal**, repo cloned on every laptop: `github.com/enginkantar/bizos`. |
| 10:30–11:00 | **Contract frozen:** API routes fixed (`/api/inbox`, `/api/cases`, `/api/approvals`, `/api/rules`, `/api/audit` — no SSE, UI polls 2s), single policy format (YAML `policy:` block), amounts in integer cents, SQLite up, API key makes one real test call. |
| 11:00–12:30 | **One message end-to-end:** widget → Haiku routes → Sonnet drafts citing a rule → gate → SQLite → visible in the real UI. Duplicate `(channel, source_message_id)` makes no second case. |
| 12:30–14:00 | **Approvals + versioned rules:** approval flow works; rule edit v3→v4 changes the answer AND the gate limit together. Approval binds to draft+rules+recipient+action, voids on any change, gate re-runs at send, double-click safe. (Lunch in shifts — no merges while eating.) |
| 14:00–14:30 | **Clean install:** fresh clone on Sohara's laptop, `npm install && npm start`, under 10 minutes. |
| 14:30–15:30 | **Torture pass:** duplicate message → one case; double approval → one send; restart → nothing lost; API error paths → clean failures; $500 via labeled "unsafe suggestion" fixture → BLOCK; $199.99 → REVIEW. Email adapter go/no-go (.eml import = honest fallback). Demo rehearsal ×2. |
| 15:30–16:00 | **Freeze:** bug fixes only; `git tag demo-good` (rollback = checkout tag + restart). P0 fixes need Engin's sign-off. |
| 16:00+ | **Ship:** demo video (~4:15 slot, two takes max), README final, submission before 5:30 — GitHub link + who-did-what (everyone's real contribution). |

## Demo script (6 minutes)

1. **Hook (30s):** "We surveyed 38 local businesses: 68% don't trust AI with their business. BizOS is AI your rules control and code constrains."
2. Customer sends a message in the widget → orchestrator routes → Sales agent drafts a reply **citing SALES rule S-2, v3**.
3. **$500 refund request** (labeled unsafe test input) → red **HARD-1 banner: BLOCKED by code, not by the model.** Money sentences in drafts are rendered from validated fields, and draft text is scanned for amounts above the approved one.
4. **Live rule edit:** owner changes the limit in `sales.rules.md` (v3→v4) → same request now behaves per the new rule — **and the gate limit changed with it, because both compile from the same file.** *"The owner just reprogrammed their AI staff in plain text."*
5. Uncovered question → lands in **approval queue** → owner clicks **Approve reply** (a reply, never a payment) → their edit becomes tomorrow's example. Bonus beat if built: case in `quote_sent` → "Generate follow-up" → follow-up draft citing the rule.
6. Close: audit trail view + honest privacy line: *"App, rules and records run under your control — your machine, your API key, one SQLite file. The content needed to draft a reply goes to the Claude API."* Differentiation: owned & versioned policy, code-enforced limits, every action traceable to a rules version.

## Acceptance (must all pass before freeze)

- [ ] Fresh clone → `npm install && npm start` → working, under 10 min (proven at 14:00, second laptop)
- [ ] Draft reply cites a real rule ID + version, verified to exist in the active rules version
- [ ] $500 refund blocked by gate even if the model says yes
- [ ] Duplicate `(channel, source_message_id)` creates no second case
- [ ] Rule edit v3→v4 changes model behavior AND gate limit without restart
- [ ] Stale approval (draft or rules changed) cannot be sent; gate re-runs at send
- [ ] App restart: pending work resumes, nothing lost
- [ ] Unknown request goes to approval queue, never guessed
- [ ] Recipient comes from the channel record, never from model output
- [ ] No API keys in the repo or in the browser

## Risk owners

| Risk | Owner | Response |
|---|---|---|
| Anthropic API slow/down | Petr | Retry + cached canned run for video |
| Demo machine dies | Infra | Second laptop cloned + tagged at freeze |
| Scope creep | Engin | "Backlog" — written down, not built |
| Time slips | QA/PM | Calls every gate out loud; 14:30 cut is final |

**Roadmap slide (say, don't build):** email/WhatsApp adapters, edge deploy (Cloudflare Workers) + Oracle Always Free archive, Academy agent trained from the same rules files, trust ladder autonomy.
