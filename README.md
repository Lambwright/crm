# CRM

The "Wrapper" — a company/contact database, bid-pipeline stage tracker, tender
email log, and hot-lead weighting layer that replaces NetSuite's *CRM* role
(not its ERP/accounting role) for Einbau. Built because Procore is CRM-narrow
(a Bid Board, not a customer database) and configuring NetSuite properly as a
CRM was scoped as a multi-week, multi-phase project (see the two source docs
below) — this is the faster, cheaper alternative built on infrastructure the
suite already runs.

Full design context — the two original NetSuite planning docs, how they map
onto this suite instead, and every decision made getting from "NetSuite CRM"
to "this app" — lives in
[`crm-app-kickoff-prompt-v1.md`](crm-app-kickoff-prompt-v1.md). Read it before
extending this app; it explains *why* the shape below is what it is, not just
what the shape is.

The two original documents this was scoped from are kept alongside it for
reference:
- [`Einbau_Phase_1_Customer_Journey_Validation.docx`](Einbau_Phase_1_Customer_Journey_Validation.docx) — the approved business model (opportunity stages, account segments).
- [`Einbau_NetSuite_Technical_Implementation_Playbook.docx.pdf`](Einbau_NetSuite_Technical_Implementation_Playbook.docx.pdf) — the technical spec this app implements against Postgres instead of NetSuite.

## What it does

- **Companies + Contacts** — one row per legal/trading entity, cross-referenced
  to Procore's Directory and NetSuite's Customer record where they exist, with
  an **Account Segment** (Unreviewed → Qualified Target → Active Prospect →
  Engaged Prospect → Customer → Dormant Customer → Do Not Pursue/Work With) —
  the company-level relationship, independent of any one bid's outcome.
- **Bids** — one row per Procore RFQ ID, carrying SCOUT's qualification result
  and score, and its own **Opportunity Stage** (the approved 10-stage journey:
  RFQ Imported → Qualified-Estimating → Bid in Preparation → Bid Submitted →
  Client Evaluation → Clarification/Negotiation → Awarded-Handoff → Closed
  Won/Lost, plus On Hold and No Bid). Stage moves are gated — the required
  fields for that transition (owner, values, dates, lost/no-bid reason, etc.)
  must be present before the move is accepted, mirroring the Playbook's
  Workflow B validation table.
- **Tender email log** — a mailto popout to compose, plus a log of what was
  sent/received per bid. Item 2 of the original ask.
- **Hot-lead weighting** — a manual, admin-set per-company flag/reason that
  SCOUT reads at scoring time to give a flagged account's borderline RFQ a
  passing tier more often, even at a lower raw score. Recorded here and
  best-effort mirrored into NetSuite's Customer record during the parallel-run
  period (see kickoff prompt for why parallel, not immediate cutover).
- **Stale-bid follow-ups** — a daily sweep flags open bids past their
  next-action date, or with no owner, into a notifications ledger surfaced in
  the UI. Real Teams/email delivery is stubbed for now, same decision HANDOFF
  already made for its own escalation ledger.
- **Dashboard v1** — pipeline by stage, win rate, aging, hot-lead count.

## Layout

```
worker/   crm-worker — Cloudflare Worker: companies/contacts/bids API, the
          stage machine, tender email log, SCOUT intake, NetSuite hot-lead
          mirror, the daily staleness sweep.
web/      React + Vite frontend (Einbau ID gated), GitHub Pages.
.github/  GitHub Pages deploy workflow for web/.
```

See [`worker/README.md`](worker/README.md) — TODO, not yet written; the route
table and every design decision are documented at the top of
[`worker/src/index.js`](worker/src/index.js) in the meantime.

## Stack

- **Frontend**: React/Vite, GitHub Pages, matching the suite's existing pattern
  exactly (theme, login, dev proxy copied from TALLY/HANDOFF). Accent color is
  violet — green is SCOUT/INTAKE, orange is TALLY, aquamarine is HANDOFF,
  steel-gray is HELM, blue is reserved for LEDGER.
- **Auth**: Einbau ID (`https://auth.ben-a90.workers.dev`) — no changes needed.
  Gated the same way as TALLY (`ALLOWED_ROLES`), broader than TALLY's named-user
  list since this tool is meant for wide internal use (estimating, follow-up,
  leadership).
- **Backend**: a single Cloudflare Worker (`crm-worker`).
- **Database**: a dedicated Neon Postgres project (`crm`) — not shared with
  any other app's project, same reasoning as every other suite app's own
  dedicated project.

## Explicitly deferred / not built here

See the kickoff prompt for the full list and reasoning. In short: fuzzy
company/contact matching (MVP uses exact-name matching — replace with or
delegate to INTAKE's matcher before this runs at real volume), real inbound
tender-email ingestion (no intake mailbox exists yet — TALLY's Power Automate
folder-watch pattern is the template once one does), real Teams/email
notification delivery, a full region/vertical/job-type hot-lead affinity table
(HANDOFF's PM-affinity table is that richer shape — start with the flat
per-company override above and revisit only if it proves insufficient), and
any deeper NetSuite decommissioning beyond its CRM role.

## Deploy order

1. **Neon** — create a dedicated `crm` project, apply `worker/schema.sql`.
2. **crm-worker** — set secrets (`DATABASE_URL`, `CRM_SERVICE_KEY`,
   `NETSUITE_SERVICE_KEY`), confirm the `NETSUITE_WORKER` service binding name
   in `wrangler.jsonc` against the actual Cloudflare dashboard (marked
   `TODO(ben)` — not yet verified), `wrangler deploy`.
3. **Frontend** — create a `crm` GitHub repo, push `web/`, set
   `VITE_CRM_API` / `VITE_AUTH_API` repo variables, enable Pages (Source:
   GitHub Actions). Confirm `https://lambwright.github.io/crm/` loads and logs in.
4. **SCOUT integration** — once this is live, wire SCOUT to also POST to
   `/intake/scout` (with `X-CRM-Service-Key`) alongside its existing NetSuite
   Opportunity write, per the parallel-run decision — not done yet, this repo
   only has the receiving end built.
5. **Accounts** — reuse existing Einbau ID logins; no new user creation needed
   unless HELM's `apps` allowlist is used to restrict CRM access later.

## Verification

Not yet written — no tests exist yet. Before relying on this for real bids:
`cd worker && npx wrangler deploy --dry-run` to catch import/syntax errors,
manual smoke test of the full stage machine (create via `/intake/scout`, move
through every stage including a blocked move with missing required fields,
confirm stage_history and notifications behave), `cd web && npm run build`.
