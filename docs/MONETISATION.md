# Monetisation blueprint

## Model

Subscription per workspace, billed monthly or yearly, with limits on contracts
and seats. Priced per workspace rather than per contract so that adding the next
contract never needs approval, which is the behaviour the product depends on: a
register is only useful if everything is in it.

| Plan | Monthly | Yearly (2 months free) | Contracts | Seats | Paid features |
|---|---|---|---|---|---|
| Starter | Free | Free | 5 | 2 | Register, audit log, cited findings |
| Team | ₹1,999 | ₹19,990 | 150 | 10 | Calendar feed, audit export |
| Business | ₹7,999 | ₹79,990 | 2,000 | 50 | Everything in Team, onboarding help |

All limits and gates are enforced by the API (`lib/plans.js`, checked in
`lib/service.js`), not by the page. Downgrades are refused while a workspace is
over the lower plan's limits.

## Why the free plan exists

Five contracts is enough to prove the product on the contracts that matter most
(hosting, the office, the biggest software subscription) and not enough to run a
firm on. The upgrade trigger is natural: the sixth contract, the third person,
or wanting deadlines in the calendar.

## Value to the customer

The price has to be small next to what a single miss costs. The sample CRM
contract in this repo renews at ₹18,00,000 a year with a 60-day notice window.
Missing that window once costs 75 years of the Team plan
(₹18,00,000 ÷ ₹23,988 a year). The overview page shows this number directly:
the total value that renews by default in the next 90 days unless someone acts.

## Cost to serve

Architecture choices keep the marginal cost of a workspace near zero:

- No database server. State is in Netlify Blobs, billed on storage and
  operations. A contract with its findings is tens of kilobytes.
- No model inference. Extraction is deterministic pattern matching, so there is
  no per-document AI bill and no GPU to rent.
- One serverless function. Cost follows requests; an idle workspace costs
  nothing.

At the pilot scale this runs inside Netlify's free allowance. Past it, the fixed
cost is a Netlify Pro seat plus metered usage, which a handful of Team
subscriptions covers. Gross margin on paid plans is expected to be well above
90% because there is no per-document inference cost.

## Revenue plan

1. **Direct self-serve.** Landing page, live demo with no sign-up, free plan.
   The demo workspace is the sales pitch: it opens on the renewal-exposure figure.
2. **Chartered accountant partners.** Indian SMEs already rely on their CA for
   a calendar of statutory due dates (GST returns, TDS, ROC filings). Contract
   deadlines belong in the same calendar. A partner plan (roadmap: one CA firm,
   many client workspaces, a revenue share) turns each CA into a channel to
   dozens of firms.
3. **Expansion inside accounts.** Seats and contract counts grow as more
   departments add their contracts. Business plan for multi-department firms.

## Add-ons on the roadmap

| Add-on | Price idea | Why someone pays |
|---|---|---|
| Email and WhatsApp reminders to owners | Included in Team | Reduces churn, drives daily use |
| Assisted intake: a reviewer checks and confirms findings on upload | ₹199 per contract | For firms that want the register without the review work |
| PDF and Word import with OCR | Included in Team | Removes the copy-paste step |
| SSO and audit log streaming | Business | Required by larger buyers' IT teams |

## Payments

Checkout currently runs in test mode: changing plan applies every limit for real
and writes a `billing.plan_changed` audit event marked `mode: "test"`, but no
card is taken. Going live means putting a payment provider's hosted checkout in
front of `POST /api/billing/plan` and having its webhook call the same service
method, so the audit trail records real payments the same way.
