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

## Einbau ID role matrix — built, waiting on CRM's Live switch

Built 2026-10-05 against auth-worker/README.md "Role matrix". CRM reads
`user.appRoles.CRM` from `/auth/verify` and handles three states:

| `appRoles.CRM`            | Mode      | What CRM does |
|---------------------------|-----------|---------------|
| `admin` / `estimator` / `pm` | **live**   | The matrix is the gate. `ALLOWED_ROLES` and `user.role` are ignored. |
| `access` (or the key missing) | **legacy** | CRM isn't switched yet: today's checks exactly — `ALLOWED_ROLES` on `user.role`, `user.role === "admin"`, `assignable_usernames`. Deploying changed nobody's access. |
| `no_access` / anything else | **denied** | 401 on every route. |

A missing `appRoles` is treated as legacy rather than denied: it can only mean
an auth-worker older than the matrix, and falling back to today's checks is no
looser than what CRM already did, whereas denying would lock everyone out.

**Levels (live mode), all enforced in `worker/src/index.js`:**
- `admin` — everything, including `PATCH /settings` (follow-up cadence) and
  adding or removing a blacklist designation (account segment `do_not_pursue` /
  `do_not_work_with`) — admin only, in both directions.
- `estimator` — move bids between stages (`POST /bids/:id/stage`, which includes
  Awarded and Start Handoff), set the hot-lead designation (`hot_lead`,
  `hot_lead_weight`, `hot_lead_reason` on `PATCH /companies/:id`), and assign
  follow-ups (change `owner_username` / `estimator_username`), change an account
  segment (anything other than a blacklist designation), and change a bid's
  `handoff_status`.
- `pm` — can be assigned follow-ups; cannot do any of the above. Can still log
  emails, edit bid dates/values/next action, edit company notes/region/vertical,
  and acknowledge notifications.

**Assignment is split by actor and target.** The actor must be estimator or
admin; the target must currently have CRM access at pm, estimator or admin,
read live from auth-worker (`POST /auth/app/users { app: "CRM" }` over the
`AUTH_WORKER` binding with the caller's own token, cached 60s per isolate). Only
a real change counts: re-sending a bid's current owner isn't an assignment.

**`GET /access`** returns the caller's mode, level, a `can` map
(`move_stages`, `hot_lead`, `assign`, `admin`) and, in live mode, the eligible
assignee list. The web app builds the owner/estimator pickers, hides what a
person can't use, and decides nav order from it — all cosmetic; the worker
enforces every action. Follow-ups leads the nav for estimators and PMs in live
mode (admins keep the default order); in legacy mode it's still anyone on the
HELM assignable-users list.

**Still to remove once CRM is live and settled** (a later follow-up, not done):
`ALLOWED_ROLES` and the `user.role` checks in `requireLogin`, `isCrmAdmin` and
`isAssignableUsername`; the `crm_settings.assignable_usernames` column and the
`assignable_usernames` handling in `handleSettingsPatch`/`getCrmSettings`; and,
in HELM, the "Assignable users" section of the CRM Options tab (HELM's code).

## Win/loss dates and archived bids

Decided 2026-10-06. Procore's Bid Board API has no status-change dates, so for the
historical import a bid's due date (stored as ) stands in for its decision
date. From the Procore sync bridge onward CRM records the real moment: is set when a bid moves to Awarded or Lost (manual move or sync) and cleared if it leaves
that stage;  is set when the sync first sees the archived flag. Archived
bids stay out of win rates unless  is set — i.e. CRM watched the decision
happen while the bid was still live. Migration 009 is applied by the worker itself
() on first run after deploy. If a Procore report with real status dates is
ever produced, import it into .

## On hold: backlog / resource forecast

Decisions from Ben, 2026-10-05. **Nothing here is built, and nothing gets
built until the Einbau ID role matrix above is running.** Source material:
`Bid Board and Backlog Report Oct 1.xlsx` (a Procore report: estimate total,
labour total, project start date per awarded-not-started project).

Purpose: put a rough, close-to-the-truth picture of expected resource demand
in front of people — e.g. "three big projects, six to ten people each, same
region, same two-month window." Not precision. Human in the loop: each
project lands on a Backlog view with everything known plus a guessed crew
and end date, and a person adjusts it.

- **End date, in order of precedence:** a fixed end date if the project has
  one; otherwise a crew size entered by hand (end date follows from it);
  otherwise the calculated optimum crew and the end date that implies.
- **Calculation:** crew from a size table keyed on labour dollars; weeks =
  labour $ ÷ $100/hr ÷ 40 hrs/week ÷ crew; end date = start + weeks × 7
  calendar days. This fixes the sheet's end-date column (it added weeks × 7
  and weeks × 5, overshooting by about 70%) and its chart (it treated working
  days as calendar days).
- **Tier table fix:** the sheet's header says "Project Value (Max)" but its
  XLOOKUP takes the next *lower* tier, so a $34k labour job got a crew of 2.
  Make it behave as labelled: a job takes the smallest tier whose max covers
  it (≤$500 → 1, ≤$20k → 2, ≤$50k → 3, ≤$100k → 4, ≤$200k → 5, ≤$300k → 6,
  ≤$500k → 8, ≤$1M → 10).
- **Totals:** the sheet's "Grand Total 45" is a sum of crew sizes, not
  concurrent need. Show a wide set of metrics first (peak concurrent
  headcount, average, total person-weeks, headcount by week/period) and prune
  to the ones that prove useful.
- **Open questions for when this resumes:** whether Procore Resource Planning
  can take an unnamed role with a headcount and dates (nobody has confirmed;
  needs a read-only probe through HANDOFF, whose RP startup task is stubbed
  for this reason); whether to use real labour hours from the estimate lines
  (already stored on `bids.labor_hours`) instead of dollars ÷ $100; and where
  "region" comes from (company region is mostly empty; project-name prefixes
  like `ON -` / `BC -` are the obvious source).

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
