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
npm run lint && npm run build && npm test # code checks
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

## Code file length

Aim for **500 physical lines or fewer** per code file. `npm run lint` warns
above **800** lines and fails above **1000**. Exactly 800 is quiet; exactly
1000 warns and passes. Warnings do not fail CI. The existing `install` CI
job runs lint, build and tests.

The check counts blank lines and comments, including a final unterminated
line. LF and CRLF count the same; a final newline adds no phantom line.
It discovers tracked and non-ignored untracked files across the repository,
including tests, tooling, build/CI/config code and executable fixture
generators. Application HTML and CSS are code. A code file in `templates/`,
`data/` or `fixtures/` is still code.

Prose, rules Markdown, raw text/tabular data, images, binary files, JSON
payloads under `data/`, `fixtures/` and `testdata/`, lockfiles, dependency/vendor
trees and `dist/`/`coverage/` output are exempt. Package and TypeScript JSON
configuration remains code even in payload directories. There are currently
no generated source files outside those output trees. Any future generated-source exemption must name its
reviewed paths explicitly; generators themselves remain code. Symlinks are
not followed. Unknown text formats are checked by default. When adding a new content or generated format,
review its actual contents and update `tools/loc/check.mjs` and its tests
with a narrow exemption, rather than exempting a mixed code/content tree.

Run the policy regression tests with `node --test tools/loc/check.test.mjs`
(or `npm test`). Split growing code along meaningful responsibilities;
the 500-line target is guidance, not another failing threshold.
