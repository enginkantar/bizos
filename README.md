# BizOS — Your AI Staff, Your Rules

**Built live at the Claude Impact Lab hackathon · thinkspace Seattle · Oct 25, 2026**

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

## How it works (3 steps)

1. **Write your rules once** — plain text files, one per department
   (`sales.rules.md`, `support.rules.md`, …). Each file carries a structured
   `policy:` block: limits live there, versioned.
2. **Messages flow in** (chat widget, webhook, email) → an Orchestrator AI
   reads each one and hands it to the right department AI.
3. **The department AI drafts a reply using only your rules** — and cites the
   rule it followed. Money limits are enforced by a **Policy Gate in code,
   compiled from the same rules file** — so the model and the code can never
   believe two different policies. Anything your rules don't cover waits in
   your approval queue instead of being guessed.

## Quick start

```bash
git clone https://github.com/enginkantar/bizos
cd bizos
npm install
npm start
```

*(Code lands here during the hackathon build day — Sun Oct 25. If you're
reading this before ~17:00 PDT, you're watching it being built.)*

## What's in this repo

- [`BIZOS_DESIGN.md`](./BIZOS_DESIGN.md) — full design document v1.2
  (architecture, envelope format, Policy Gate, trust model, MVP plan).
  Adversarially reviewed by multiple AI models before build day.
- [`templates/`](./templates/) — industry starter rule packs: pick one,
  edit the limits, you're live.

## Honest framing

App, rules, and records run under your control — your machine, your API key,
one SQLite file. The content needed to draft a reply goes to the Claude API.
"Free" means this source code; API usage is metered on your own key.

## License

MIT — see [LICENSE](./LICENSE).

---
*Team BizOS · Claude Impact Lab · Seattle 2026*
