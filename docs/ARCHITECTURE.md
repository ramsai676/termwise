# Architecture

## Shape

    browser (public/, plain ES modules)
        │  fetch, JSON, session cookie, X-Termwise header on writes
        ▼
    Netlify CDN ── static files, security headers, CSP
        │  /api/*
        ▼
    Netlify Function  netlify/functions/api.mjs
        │
        ├── lib/api.js        routing, CSRF check, session lookup, error mapping
        ├── lib/service.js    roles, plan limits, contracts, obligations, members,
        │                     billing, export, erasure
        ├── lib/engine/       segment → extract → schedule (pure functions)
        ├── lib/audit.js      hash-chained append-only log
        └── lib/store/        get / put(ifMatch | ifNew) / del / list
                │
                ▼
          Netlify Blobs, store "termwise", strong consistency

    Scheduled function  netlify/functions/sweep.mjs  (hourly)
        deletes demo workspaces older than 24 hours

The engine has no I/O and no clock of its own: it takes text and a date and
returns findings and a schedule. That is what makes it testable to the day, and
it is why the schedule is recomputed on every read rather than stored. A contract
that renews itself rolls forward to its next term without any background job.

## Stack

| Part | Choice | Why |
|---|---|---|
| Runtime | Node 20+, ES modules | Same code in the function, the local server and tests |
| API | One Netlify Function on web `Request`/`Response` | No framework to learn or patch; the handler is 150 lines |
| Storage | Netlify Blobs | Free tier, no server to run, conditional writes available |
| Front end | Vanilla JS modules, no build step | Nothing to compile; `h()` builds DOM nodes so contract text is never parsed as HTML |
| Tests | `node:test` | Built in; 39 tests run in under two seconds |
| Dependencies | `@netlify/blobs` only | Small attack surface, nothing to audit but one SDK |

## Data model

Blobs is a key-value store, so the schema is a key layout. JSON values
throughout.

| Key | Value |
|---|---|
| `user/<sha256(email)>` | `{ id, email, name, salt, hash, workspaces[] }`. Email is hashed in the key so listing keys does not list addresses |
| `session/<sha256(token)>` | `{ userId, email, wsId, expires }`. The raw token only ever lives in the cookie |
| `ws/<ws>/meta` | `{ id, name, plan, members[{ userId, email, name, role }], feed, demo, expiresAt }` |
| `ws/<ws>/index` | `[ summary ]` one entry per contract. Plan limits are enforced on writes to this key |
| `ws/<ws>/contract/<id>` | `{ title, perspective, parties, text, textHash, findings[], clauses[], state: { items{}, findings{} } }` |
| `ws/<ws>/audit/<000000042>` | `{ seq, at, actor, action, target, detail, prev, hash }` |
| `ws/<ws>/audit-head` | `{ seq, hash }`, a hint for the next append |
| `invite/<sha256(token)>` | `{ wsId, email, role, invitedBy, expires }`, deleted on use |
| `feed/<sha256(token)>` | `{ wsId }`, one live calendar feed per workspace |
| `rl/login/<sha256(email)>` | `{ start, count }`, fixed-window login rate limit |

A finding:

    {
      id: "f4", type: "renewal_notice", kind: "fact",
      clause: { id: "c7", number: "2.2", label: "2.2 Thereafter this Agreement..." },
      span:  { start: 812, end: 1004 },     // the sentence, offsets into text
      match: { start: 931, end: 964 },     // the words that matched
      quote: "Thereafter this Agreement shall automatically renew ...",
      subject: "either", appliesToUs: true,
      value: { duration: { n: 60, unit: "days", business: false } }
    }

An obligation, computed on read:

    {
      key: "renewal_decision", kind: "deadline", severity: "high",
      title: "Decide: renew, renegotiate or send non-renewal notice",
      due: "2026-11-02", renewsOn: "2027-01-01", daysLeft: 40,
      citations: ["f1", "f2", "f3", "f4"],  // effective date, term, renewal, notice
      assumptions: [], status: "open", owner: { id, name }, confirmed: { by, at }
    }

Item keys are stable across re-extraction (same text, same rules, same ids), so
owner, status and notes stay attached when someone switches which party the
workspace is on.

## Concurrency

Blobs has no transactions. It has conditional writes: create-only and
write-if-etag-matches. Everything that must not race is built on those.

- **Read-modify-write.** `update()` in `lib/store/index.js` reads a key with its
  etag, applies a function and writes with `ifMatch`. A lost race re-reads and
  retries with jittered backoff.
- **Plan limits.** The contract count check runs inside the `update()` of the
  workspace index, so two uploads racing for the last free slot cannot both win.
  `test/api.test.js` fires nine parallel uploads at a five-contract plan and
  checks exactly five land.
- **Audit appends.** Event N is written with `ifNew` at key `audit/N`. Two
  writers cannot both create N; the loser moves to N+1 and re-links to the
  winner's hash. The head pointer is only a hint. A test fires twelve parallel
  updates and verifies the chain is unbroken with exactly the expected count.

## Security

- Passwords: scrypt (N=16384, r=8, p=1), 16-byte random salt, constant-time
  compare. Login does the same hashing work for unknown emails, so timing does
  not reveal which accounts exist.
- Sessions: 32 random bytes in an `HttpOnly; SameSite=Lax; Secure` cookie.
  Only the SHA-256 is stored. 14-day expiry. Roles are read from the workspace
  on every request, so a demotion or removal bites immediately.
- CSRF: every non-GET request must carry `X-Termwise: 1`. A cross-site form
  cannot set custom headers, and a cross-site `fetch` that tries triggers a CORS
  preflight this API never answers.
- XSS: the front end never uses `innerHTML`; contract text goes into text
  nodes. The CSP allows scripts from the site's own origin only.
- Headers: HSTS, `X-Frame-Options: DENY`, `nosniff`, strict referrer policy.
- Rate limits: 8 login attempts per email per 15 minutes.
- Input caps: 300,000 characters per contract, 1 MB per request.

## Governance controls

What the product does, mapped to the control areas an auditor usually asks about.
This is a description of features, not a claim of certification.

| Control area | How Termwise covers it |
|---|---|
| Access control | Four roles, checked server-side on every call. Only owners change admin roles or billing. The last owner cannot be removed |
| Logging and monitoring | Every state change is an audit event. The chain is SHA-256 linked; `GET /api/audit/verify` recomputes it and names the first bad event |
| Integrity of records | Contract text is hashed at upload. Findings cite offsets into exactly that text |
| Human oversight | Findings start unreviewed. Confirming records who and when. Rejecting requires a reason, and deadlines built on a rejected finding drop out of the register |
| Data minimisation | Audit events never hold contract text, only its hash and the quoted snippet a person reviewed |
| Right to erasure | Erasing a contract deletes text and findings; the log keeps the hash, proving what was removed without keeping it. Owners can erase a whole workspace |
| Portability | Full JSON export of a workspace; audit log as JSON Lines |
| Retention | Demo workspaces are deleted after 24 hours by a scheduled function |

## Scaling notes

The register reads every contract document in a workspace and recomputes
schedules. At the plan limits (150 and 2,000 contracts) that is fine for the
first while: the sample contract documents are 6 to 17 KB stored, and the engine
extracts and schedules one in under a millisecond. Real contracts run longer, but
not by orders of magnitude. The next step, when it is needed, is to
store each contract's next due date in the index entry, refreshed on write and
by a nightly job, so the overview reads one key.

The audit list reads events one key at a time. For long chains the verifier
should checkpoint: store a signed `{ seq, hash }` every thousand events and
verify from the latest checkpoint forward.
