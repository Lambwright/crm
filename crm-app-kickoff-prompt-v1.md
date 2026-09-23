# CRM ("the Wrapper") — Build Kickoff Prompt (v1)

This is a seed prompt for a fresh Claude Code session, written after reading
every other suite app's README/kickoff prompt (HELM, HANDOFF, TALLY, SCOUT,
INTAKE, auth-worker, procore-worker) and both of Einbau's NetSuite CRM planning
docs, then scaffolding a first working version of this app in the same
session. Treat this as a well-informed starting point, not gospel — verify
against current source before extending, since source drifts the moment
someone else touches it (same caveat every other kickoff prompt in this suite
carries).

---

## Company / environment context

- Einbau Services Ltd. — custom architectural millwork installation
  subcontractor, Whitby, Ontario.
- Procore instance: `us02.procore.com`, company ID `562949953508586`.
- Existing infrastructure already in production and reusable: Cloudflare
  Workers, Neon Postgres (one dedicated project per app), Power Automate,
  GitHub Pages, Einbau ID (`auth-worker`, shared login).
- **The suite**: SCOUT (bid prequalification, live), INTAKE (entity/contact
  creation into NetSuite+Procore, live), PUNCH (AI task management, live),
  TALLY (expense/receipt processing, live), HANDOFF (Bid Board → Portfolio
  handoff automation, mid-build), HELM (Einbau ID admin UI, live), LEDGER
  (billing/reconciliation, in active separate development). This app is a
  seventh sibling, code name **CRM** for now (Ben hasn't picked a final suite
  name — every other app is a one-word name like the ones above; rename
  freely, it's cosmetic).

## The problem this app solves

Procore is the estimating/project system of record but is CRM-narrow — no
company-level relationship tracking, no cross-bid history, no email archive.
NetSuite is a fine ERP/accounting system but a genuinely painful CRM to
configure: two planning documents already exist
([`Einbau_Phase_1_Customer_Journey_Validation.docx`](Einbau_Phase_1_Customer_Journey_Validation.docx),
[`Einbau_NetSuite_Technical_Implementation_Playbook.docx.pdf`](Einbau_NetSuite_Technical_Implementation_Playbook.docx.pdf))
scoping a multi-phase NetSuite configuration project (custom records, SuiteFlow
workflows, saved searches, a pilot, governance) to get NetSuite to do this job.

**This app is the alternative**: implement the same approved business model —
the three-status separation, the stage machine, the account segmentation —
directly on infrastructure the suite already runs (Cloudflare Worker + Neon +
React/Vite + Einbau ID), instead of paying the NetSuite configuration cost.
The two source docs are NetSuite-specific in their storage layer but not in
their business logic — that logic is what got ported here; **read both docs
in full before changing the stage list or segment taxonomy**, they represent
real, already-approved-by-the-team decisions, not this session's invention.

On top of what those docs scoped, Ben additionally wants:
1. Automated bid-status movement through the Bid Board (item 1).
2. A tender-email archive with a mailto popout for composing (item 2).
3. Aging bids to prompt follow-ups automatically (item 3, partially built — see
   "What's built" below).
4. Lost-reason recording (item 4, built).
5. A bridge from SCOUT (bid prequalification) through this app's pipeline to
   HANDOFF (award → Portfolio handoff) — this app owns the middle, it doesn't
   replace either end.
6. **Hot-lead weighting**: identify "hot" accounts and weight them more
   heavily in SCOUT's scoring — a flagged account should get a passing tier
   more often even at a lower raw score.
7. Long-term: agentic data movement — e.g. a voice memo left in a monitored
   Teams chat updating the client database. **Not started** — no Teams/Graph
   webhook precedent exists anywhere in this suite yet (unlike email, which
   does, via Power Automate's folder-watch trigger). Prototype only once the
   core record store below is proven, not before.

## Decisions made in planning (do not re-litigate without asking Ben)

- **Parallel run, not immediate cutover.** SCOUT keeps writing to NetSuite's
  Opportunity *and* starts writing to this app's `/intake/scout` endpoint.
  Compare the two for a transition period before this app becomes the sole
  source of truth for the bid pipeline. `/intake/scout` is built; **the SCOUT
  side of this integration is not** — SCOUT's own source
  (`scout-addin/app.html`) needs a second write added alongside its existing
  NetSuite call. Not done in this session.
- **Hot-lead weighting is manual, not derived**, and is recorded in **both**
  this app and NetSuite (mirrored) during the parallel-run period — an
  admin-editable flag/weight/reason on the company record, not an
  auto-computed formula from win/loss history. Read by SCOUT at scoring time.
  Same shape as HANDOFF's admin-editable PM-affinity table: explainable, no
  guessing at a formula. **The exact SCOUT-side scoring rule (how much of a
  tier bump, at what score threshold) is not yet decided — a real open
  question below**, not assumed by this build. The NetSuite mirror push exists
  in `worker/src/index.js` (`pushHotLeadToNetSuite`) but is inert until Ben
  confirms `NETSUITE_HOTLEAD_FIELD_ID` (the target custom field's script id).
- **Build order: companies/bids/stage-tracking, tender-email log, and the
  dashboard, roughly together** rather than one fully before the next — Ben
  wants to see where all three land before a demo, no fixed deadline given.
  This session got a first working version of all three; see "What's built."
- **No firm demo deadline; no tender-intake mailbox exists yet.** The email log
  in this build is manual (compose via mailto, then log what was sent) —
  automatic inbound ingestion (TALLY's Power-Automate-folder pattern) is
  explicitly deferred until a real mailbox exists.

## What's built (this session)

- **Data model** (`worker/schema.sql`): `companies`, `contacts`, `bids`,
  `bid_stage_history`, `bid_emails`, `notifications`. Fully commented against
  the Playbook sections it implements.
- **Worker** (`worker/src/index.js`): Einbau ID auth (same pattern as
  TALLY/HANDOFF), the full stage machine with Playbook §5.2's required-field
  gates, companies/contacts/bids CRUD, tender email log, `/intake/scout` for
  SCOUT's parallel-run push, `/companies/lookup` for SCOUT to read hot-lead
  status before/while scoring, a dashboard summary endpoint, and a daily
  cron sweep for stale/ownerless bids into the notifications ledger.
- **Frontend** (`web/`): Einbau ID login (byte-for-byte the TALLY pattern),
  three tabs — a kanban-style pipeline board with a stage-move modal that
  surfaces exactly the required fields for the chosen transition, a company
  directory with segment + hot-lead editing, and a v1 numbers-only dashboard.
- **Not yet done**: no tests, no actual deploy (no Neon project created, no
  Worker deployed, no GitHub repo pushed), no `worker/README.md`, SCOUT's
  intake-side integration, fuzzy company matching, NetSuite field-id
  confirmation, real email ingestion, real notification delivery.

## Explicitly deferred / not in this MVP

- **Fuzzy company/contact matching.** `findOrCreateCompany()` in the worker is
  a case-insensitive exact-name match — a placeholder, not a design decision.
  INTAKE (`scout-intake/index.html`) already has a working fuzzy Directory
  matcher with a real-world-tested duplicate-check flow (including a fixed
  race condition worth reading about in HANDOFF's kickoff prompt addendum) —
  reuse or port that logic before this runs at real bid volume, or every
  slightly-different spelling of a client's name creates a new company row.
- **Real inbound tender-email ingestion.** No intake mailbox exists yet. Once
  one does, follow TALLY's exact pattern: an Outlook rule files mail into a
  folder, a Power Automate flow POSTs each message + attachments to a new
  `/intake/email` route with a service-key header. Not built.
- **Real Teams/email notification delivery.** The `notifications` table is
  populated by the daily sweep and shown in the UI; nothing is actually sent.
  Same "transport stubbed for now" decision HANDOFF already made for its own
  escalation ledger — copy that reasoning, don't re-derive it.
- **A region/vertical/job-type hot-lead affinity table.** Started with a flat
  per-company override (simpler, explainable). HANDOFF's PM-affinity table
  (region/client/job-type → preferred PM + weight) is the richer shape to
  graduate to if a flat flag proves insufficient — don't build it speculatively.
- **The Teams voice-memo agentic ingestion path.** Real ambition, zero
  precedent in this suite yet. Needs its own design pass (Graph/Teams webhook
  vs. a Power Automate flow watching a chat, transcription, a Claude
  extraction call, then the same company-update path `/intake/scout` already
  uses) — don't start building until the core record store has real data in
  it to validate against.
- **Any deeper NetSuite decommissioning.** This app replaces NetSuite's CRM
  role only. NetSuite stays as Einbau's accounting/ERP system; nothing here
  touches that.
- **Multi-tenant packaging.** Internal Einbau tool, same as every other suite
  app.

## Data model

See `worker/schema.sql` for the authoritative, fully-commented version. Summary:

```
companies    (id, name, procore_vendor_id, netsuite_customer_id, account_segment,
              region, vertical, tier, hot_lead, hot_lead_weight, hot_lead_reason,
              hot_lead_set_by/_at, netsuite_sync_status/_synced_at/_sync_error, notes)
contacts     (id, company_id, first_name, last_name, title, email, phone)
bids         (id, procore_rfq_id, procore_bid_board_id, company_id, contact_id,
              project_name, qualification_result, scout_score, scout_tier,
              hot_lead_applied, no_bid_reason, override_reason, stage,
              owner_username, estimator_username, bid_due_date, submitted_date,
              expected_decision_date, award_date, estimated/submitted/final_value,
              next_action, next_action_date, lost_reason/_competitor/_feedback,
              hold_reason, hold_review_date, handoff_triggered_at)
bid_stage_history (id, bid_id, from_stage, to_stage, changed_by, note, changed_at)
bid_emails   (id, bid_id, company_id, direction, subject, from/to/cc, body,
              source, sent_at, logged_by)
notifications (id, bid_id, type, message, status, created_at, acknowledged_by/_at)
```

## Stack

- **Frontend**: React/Vite, GitHub Pages, matching the suite's existing pattern
  exactly — copied TALLY's `auth.js`/`api.js`/`LoginScreen.jsx`/`theme.css`
  near-verbatim per every other kickoff prompt's own advice, with accent
  swapped to violet (green=SCOUT/INTAKE, orange=TALLY, aquamarine=HANDOFF,
  steel-gray=HELM, blue reserved for LEDGER).
- **Auth**: Einbau ID, no changes needed. Gated broader than TALLY
  (`ALLOWED_ROLES: admin,user`, no named-user allowlist) since this is meant
  for wide internal use — confirm that's actually right with Ben before
  deploy; it's a default, not a confirmed requirement.
- **Backend**: a single Cloudflare Worker (`crm-worker`).
- **Database**: a dedicated Neon Postgres project (`crm`) — not shared with
  any other app's project, matching every other app's own reasoning (Neon's
  free tier gives each project its own independent compute/storage
  allowance).

## Read this before writing more code

- **`worker/src/index.js`** — read the actual current file; its header comment
  documents every route and every design decision made while building it.
  This prompt may already be stale relative to it.
- **The two source docs** — re-read them before changing the stage list or
  segment taxonomy; they encode real, already-approved business decisions.
- **`auth-worker/README.md`** — the Einbau ID API table, for the auth
  integration pattern (unchanged from every other suite app).
- **`scout-addin/app.html`** — SCOUT's existing scoring model (weighted
  criteria across 3 sections, tiers A/B/C/No-bid at 90/72/50, disqualifiers,
  manual override) — read this before touching the SCOUT-side integration or
  designing the hot-lead tier-bump rule; the exact mechanism (shift the tier
  cutoff? add points to the raw score? bypass the cutoff outright for
  hot-leads only?) is an open question below, not decided.
- **`HANDOFF`'s README and kickoff prompt** — for the Awarded→Portfolio gate
  this app feeds into, the PM-affinity table pattern this app's hot-lead
  weighting is modeled on, and the "notification transport deferred" precedent.
- **`scout-intake/index.html`** — the fuzzy company-matching logic to reuse
  before replacing `findOrCreateCompany()`'s placeholder exact-match.

## Open questions for Ben

1. **Exact hot-lead scoring mechanism in SCOUT.** Shift the passing-tier score
   threshold down for flagged accounts (e.g. Tier B cutoff drops from 72 to
   60)? Add flat bonus points to the weighted total? Or bypass the cutoff
   entirely (any hot-lead account auto-qualifies regardless of score, subject
   to disqualifiers still applying)? This determines a real code change in
   `scout-addin/app.html` that hasn't been made yet.
2. **`NETSUITE_HOTLEAD_FIELD_ID`** — which NetSuite Customer custom field
   (script id) should receive the mirrored hot-lead flag/weight? Left
   unconfigured for now; the mirror push no-ops (logged, not blocking) until
   this is set.
3. **Confirm the `NETSUITE_WORKER` service binding name** in the Cloudflare
   dashboard — `wrangler.jsonc` assumes `"netsuite"` by analogy with
   `auth-worker`'s `"auth"` binding name, not yet verified against what's
   actually registered.
4. **Who can access this app** — is `ALLOWED_ROLES: admin,user` (everyone with
   an Einbau ID login) actually right, or should this be restricted via
   HELM's `apps` allowlist to a named group (estimating + BD + leadership),
   similar to TALLY's small named-user list?
5. **Exact criteria for when SCOUT should push to `/intake/scout`** — every RFQ
   regardless of qualification result (matching the Playbook's "retain every
   intake record" recommendation), or only Pursue-qualified ones? The worker
   accepts either today (records `no_bid` stage immediately if
   `qualification_result === 'no_bid'`), but SCOUT's actual call site isn't
   built yet and needs this decided.
6. **A real name for this app** — every sibling has a one-word suite name;
   "CRM" is a placeholder pending one.
