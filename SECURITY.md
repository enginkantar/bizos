# Security reporting

BizOS answers a business's customers and enforces limits on refunds and other
money decisions. So the most serious bugs here are the ones that let a message
get around those limits, or leak what customers wrote.

## How to report

**Please do not open a public issue for a security problem.** Use GitHub's
private vulnerability reporting on this repository: the **Security** tab, then
**Report a vulnerability**.

This is a hackathon project maintained by volunteers, so there is no response
SLA.

## What is in scope

- A customer message that gets the Policy Gate to allow an action its rules
  file's `policy:` block forbids — on any path, including retries and approvals
- A customer message that changes a rules file, or anything else only the owner
  should change (prompt injection reaching the privileged rules path)
- A reply sent to a recipient other than the verified channel the message came
  from
- An approval that applies to a draft, rules version or recipient other than
  the one the owner saw
- Customer messages, drafts or API keys recoverable from this repository, its
  history, logs or a default install
- A check in `claims.ini` that passes while the property it protects is false

## What is out of scope

- **What the model says.** The model can be talked into proposing something
  foolish; the design assumes it will. The gate deciding what actually happens
  is what is in scope.
- **The machine you run it on.** BizOS runs under your control, with your API
  key. It does not make that machine secure.
- **The Claude API.** The content needed to draft a reply is sent to it. Report
  issues with the API itself to Anthropic.

## Running it safely

The hackathon build has **no sign-in** for editing rules. It listens on
localhost only by default; do not expose it to a network you do not trust until
owner authentication is added.
