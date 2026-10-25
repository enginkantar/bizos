# Contributing

BizOS was built in one day at the Claude Impact Lab hackathon, and it is meant
to be taken and used by small businesses. The most useful contributions are the
ones that make that easier.

## The most useful things you can send

1. **A starter template for your kind of business.** Copy one from
   `templates/`, write the rules your business actually runs on, and set real
   limits in the `policy:` block. A template is plain Markdown; no code needed.
2. **A channel adapter.** Every channel normalizes to one message envelope at
   `POST /api/inbox`. Email, WhatsApp and SMS adapters are on the roadmap.
3. **A rule the gate should enforce but cannot yet.** Open an issue describing
   the limit, the business it comes from, and what should happen when it trips.
4. **Telling us the quickstart is wrong.** If you followed the README and
   something did not happen the way it said, that is a bug in the README.

## Before you open a pull request

```bash
python3 tools/claimcheck/claimcheck.py    # what this project claims is true
npm install && npm start                  # still starts from a clean checkout
```

Then read [AGENTS.md](AGENTS.md): branch per change, one approving review, and
nothing in the diff that cannot be public.

🔴 **Never relax a claim to get a check through.** If a claim is wrong, say so
in the PR and change it deliberately.

## House rules, and why

**Nothing enters history that could not be public.** No API keys, no database
files, no real customer messages. A key removed in a later commit is still
published; the only fix is revoking it.

**One source for every limit.** A refund cap lives in a rules file's `policy:`
block and nowhere else. Both the AI's instructions and the code's enforcement
compile from it, so they can never disagree.

**Comments say why, not what.** The code says what it does. The comment is for
the person about to "simplify" something that is load-bearing.
