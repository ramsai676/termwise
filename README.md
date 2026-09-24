# Termwise

Termwise reads a contract, finds the terms that create deadlines or duties
(renewal windows, notice periods, payment terms, breach notification windows,
insurance, lock-ins, fee escalations), works out the actual dates, and keeps them
in a register where each one has an owner and a status. Every finding is a quote
from the contract with its clause number and character offsets. Every change is
written to a hash-chained audit log.

Live: https://termwise-app.netlify.app (the "Open the live demo" button makes a
throwaway workspace with four sample contracts, no sign-up)

It is aimed at small and mid-sized firms that sign a lot of vendor contracts but
have no legal ops team. See [docs/BRIEFING.md](docs/BRIEFING.md) for the problem
and who pays, [docs/MONETISATION.md](docs/MONETISATION.md) for the pricing model,
and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it is built.

## Run it

Needs Node 20 or later. No database to install.

    npm install
    npm start          # http://localhost:8787, state is kept in .data/
    npm test           # engine, API and MCP tests

Locally the app runs the same request handler as production, with a folder on
disk standing in for Netlify Blobs.

## Deploy

    netlify deploy --prod --dir public --functions netlify/functions

The API is one Netlify Function (`netlify/functions/api.mjs`) mounted at
`/api/*`. A second, scheduled function deletes expired demo workspaces every
hour. Storage is Netlify Blobs, so there is nothing else to provision.

## Ask it from a voice assistant (MCP)

Termwise is also an MCP server, so Alexa+ or any MCP client can ask "what
contract deadlines are coming up?", hear the clauses behind a date, give an
obligation an owner, or mark it done.

    Endpoint   https://termwise-app.netlify.app/mcp
    Transport  Streamable HTTP, stateless, MCP 2025-11-25
    Auth       Authorization: Bearer <workspace key>   (Settings, Connect a voice assistant)

| Tool | What it does |
|---|---|
| `upcoming_deadlines` | Open dated obligations in the next N days, read out as full dates |
| `renewal_exposure` | Yearly value that renews by default unless notice goes out, with the last day to send it |
| `list_contracts` | Contracts with counterparty, term end and next action |
| `contract_obligations` | What one contract holds you to; name it the way a person would ("the hosting one") |
| `explain_deadline` | How a date was worked out, quoting every clause it depends on |
| `assign_obligation` | Give an obligation an owner |
| `complete_obligation` | Mark it done, with a required note |
| `verify_audit_trail` | Recompute the hash chain and say whether anything was altered |

A key acts as the person who made it and never with more access: its role is
capped by that person's current role, so demoting them demotes their keys.
Only the key's hash is stored. Every change an assistant makes lands in the
audit trail marked `via: mcp` with the key id. Answers are written to be spoken:
the text says "16 October 2026, in 22 days" and "46.8 lakh rupees", while
`structuredContent` carries the same data as fields.

Try it with the MCP Inspector:

    npx @modelcontextprotocol/inspector
    # Transport: Streamable HTTP, URL: https://termwise-app.netlify.app/mcp
    # Header: Authorization: Bearer tw_...

## What is in here

    lib/engine/     contract parsing: clauses, durations, dates, extraction, scheduling
    lib/audit.js    hash-chained audit log
    lib/service.js  every business rule: roles, plan limits, obligations, erasure
    lib/api.js      HTTP routes on web-standard Request/Response
    lib/mcp.js      MCP server: tools for voice assistants, bearer-key auth
    lib/store/      key-value store with conditional writes (Blobs, disk, memory)
    public/         landing page and the app, plain ES modules, no build step
    samples/        four sample contracts used by tests and the demo workspace
    test/           node:test suites

## How extraction works, and why it cannot make things up

There is no language model in the extraction path. Each rule in
`lib/engine/extract.js` is a pattern that locates a kind of term and reports the
sentence it found, with offsets. The scheduler then does date arithmetic on those
findings (effective date + term length, minus the notice period) and records
which findings each deadline was computed from.

So every claim Termwise makes can be checked by reading the quoted sentence.
`test/engine.test.js` checks that for every sample: each quote must equal the
text at its stored offsets, sit inside the clause it is cited to, and every
number the finding reports must appear in that quote.

The trade-off is recall. A rule-based reader misses terms written in ways the
patterns do not cover. That is why nothing counts until a person confirms it,
and why a person can reject a finding with a reason.

## Known gaps

- Input is plain text. PDF and Word files have to be copied and pasted for now.
- Clause numbering in the style "Section 4(b)(ii)" is read as clause 4.
- Payments are in test mode. Changing plan applies the real limits and is logged
  as a test-mode change, but no card is taken.
- Email reminders are not built. The calendar feed covers reminders for now.
- Parties are only read from the opening paragraph. Contracts that define the
  parties on a cover page with no "between X and Y" sentence get no parties,
  and findings are shown without saying who they bind.

## Licence

MIT
