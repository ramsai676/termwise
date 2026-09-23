# Executive briefing

## The friction

A firm with forty people and sixty vendor contracts does not have a legal
operations team. Contracts are signed by whoever needed the service, saved to a
shared drive, and forgotten until something goes wrong. What goes wrong is
predictable:

- **Auto-renewal.** Many SaaS, hosting, facility and equipment contracts renew
  themselves unless notice is given inside a window that closes 30 to 90 days
  before the term ends. The date that matters, the last day to send notice, is
  never written down. It has to be computed from three clauses: when the
  contract started, how long the term is, and how much notice is needed.
  Miss it and the firm is committed to another year.
- **Duties nobody owns.** The contract says the customer must claim service
  credits within 15 days of a bad month, or pay within 30 days before 2% a month
  interest starts, or keep insurance of a stated amount. Each of those sits with
  a different person, and none of them has read the contract.
- **Terms that only bind the other side.** Just as important as what you owe is
  what the vendor owes you: breach notification within 24 hours, returning your
  data within 60 days of exit. If nobody knows those exist, nobody enforces them.

The usual tool is a spreadsheet of contract end dates. It does not hold notice
periods, it goes stale the day its owner changes jobs, and it cannot say where a
date came from.

## What Termwise does

1. Reads the contract text and splits it into numbered clauses.
2. Finds the terms that create a date or a duty, each as an exact quote with its
   clause number.
3. Works out which party each term binds, from the side of the contract the
   workspace says it is on.
4. Computes the real deadlines, showing the arithmetic: start date, plus term,
   minus notice, each figure linked to the sentence it came from.
5. Puts every obligation in one register with an owner, a status and a note, and
   in the team's calendar through a private feed.
6. Records every change in a tamper-evident audit log.

The design choice that sets it apart: Termwise never writes text about a
contract. Every statement it makes is a span of the contract itself. A finance
lead can check any deadline in ten seconds by reading the highlighted sentence,
and an auditor can check that the record of who did what has not been edited.

## Who uses it, who pays

| Person | What they get |
|---|---|
| Finance or operations lead (buyer) | One list of every date the firm is bound to, and the total value that renews by default in the next 90 days |
| Department heads (members) | The obligations assigned to them, in their calendar |
| Founder or director (owner) | Control over who can see and change what; proof of what was done and when |
| External auditor or CA (viewer) | Read-only access and an audit trail that verifies itself |

Target customers are firms of roughly 20 to 500 people that buy services under
written contracts: logistics, manufacturing, healthcare clinics, schools, agencies,
and software companies. They have enough contracts to lose track and too few to
justify an enterprise contract lifecycle suite, which is priced and staffed for
companies with in-house legal teams.

## Why now, why this way

Contract tools that summarise with a language model produce fluent text that
may or may not be in the contract. For a deadline that commits real money, a
plausible date is worse than no date. Termwise inverts that: it only points at
text, it states its assumptions next to the date, and a person confirms before
anything is treated as final. That makes it usable by people who would never
trust a summary.

## Status

Working product, deployed, with a demo workspace anyone can open. 39 automated
tests cover the engine's no-fabrication guarantee, date arithmetic, role
enforcement, plan limits under concurrent requests, and audit chain tamper
detection. Payments run in test mode.
