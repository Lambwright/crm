-- CRM database schema — dedicated Neon project `crm`, separate from every
-- other suite app's project (TALLY, HANDOFF, PUNCH each already have their own
-- for the same reason: Neon's free tier gives each project its own compute/
-- storage allowance, and a shared project means one app's usage can starve
-- another's).
--
-- Model, straight off the two Einbau CRM planning docs (Einbau_Phase_1_
-- Customer_Journey_Validation.docx, Einbau_NetSuite_Technical_Implementation_
-- Playbook.docx.pdf) — those docs specify NetSuite as the storage layer, but
-- the record model and stage machine they define are system-agnostic. This
-- schema *is* that model, implemented here instead of in NetSuite.
--
-- Three statuses that must never overwrite each other (Playbook §1.2):
--   - qualification_result  lives on `bids`      — SCOUT already owns this
--   - stage                 lives on `bids`      — the per-RFQ journey
--   - account_segment       lives on `companies` — the company-level relationship
--
-- Only throwaway/test rows should exist before this runs — confirm before
-- dropping anything in a real environment.

create extension if not exists pgcrypto;

drop table if exists bid_emails cascade;
drop table if exists notifications cascade;
drop table if exists bid_stage_history cascade;
drop table if exists bids cascade;
drop table if exists contacts cascade;
drop table if exists companies cascade;

-- ---------------------------------------------------------------------------
-- companies — one row per legal/trading entity (Phase 1 doc §5, Playbook §1.1)
-- ---------------------------------------------------------------------------
create table companies (
  id uuid primary key default gen_random_uuid(),

  name text not null,

  -- Cross-references into the systems that still own their own slice of truth.
  -- Procore's Directory has no dedicated "customers" endpoint (HANDOFF's kickoff
  -- doc, confirmed by INTAKE) — every company, customer or not, is a /vendors row.
  procore_vendor_id   bigint,
  netsuite_customer_id text,

  -- Account Segment — Phase 1 doc §5. Describes the overall relationship, not
  -- any one bid's outcome. Never overwritten by a bid's qualification result
  -- or stage.
  account_segment text not null default 'unreviewed'
    check (account_segment in (
      'unreviewed', 'qualified_target', 'active_prospect', 'engaged_prospect',
      'customer', 'dormant_customer', 'do_not_pursue', 'do_not_work_with'
    )),

  region  text,
  vertical text,
  tier    text,

  -- Hot-lead weighting (decided in planning: manual for the MVP, mirrored into
  -- NetSuite during the parallel-run period rather than Wrapper-only). Read by
  -- SCOUT at scoring time to shift a borderline RFQ's tier for a flagged
  -- account — see worker/README.md "Hot-lead weighting" for the exact rule.
  -- Deliberately a flat per-company override, not a region/vertical/job-type
  -- affinity table (HANDOFF's PM-affinity table is that richer shape; revisit
  -- only if a flat flag proves insufficient in practice).
  hot_lead        boolean not null default false,
  hot_lead_weight numeric not null default 0,  -- 0 = no effect; see SCOUT integration doc for scale
  hot_lead_reason text,
  hot_lead_set_by text,
  hot_lead_set_at timestamptz,

  -- Best-effort mirror into NetSuite's Customer record (parallel-run decision).
  -- Never blocks a save here if NetSuite is unreachable — see worker/README.md.
  netsuite_sync_status text,      -- null | 'synced' | 'failed'
  netsuite_synced_at   timestamptz,
  netsuite_sync_error  text,

  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index companies_name_idx on companies (lower(name));
create index companies_segment_idx on companies (account_segment);

-- ---------------------------------------------------------------------------
-- contacts — one row per person, linked to a company (Phase 1 doc §4/§Playbook §1.1)
-- ---------------------------------------------------------------------------
create table contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,

  first_name text,
  last_name  text,
  title      text,
  email      text,
  phone      text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index contacts_company_idx on contacts (company_id);
create index contacts_email_idx on contacts (lower(email));

-- ---------------------------------------------------------------------------
-- bids — one row per Procore RFQ ID (Playbook §1.1 "Bid Intake" + Opportunity,
-- collapsed into a single record here since the Wrapper owns both halves
-- instead of splitting them across a custom NetSuite record and an Opportunity)
-- ---------------------------------------------------------------------------
create table bids (
  id uuid primary key default gen_random_uuid(),

  -- Playbook §4.2: same RFQ ID resubmitted updates this row, never creates a
  -- second one. This is the idempotency key for the SCOUT intake endpoint.
  procore_rfq_id text unique not null,
  procore_bid_board_id text,

  company_id uuid references companies(id),
  contact_id uuid references contacts(id),

  project_name text not null,

  -- Qualification Result — SCOUT already owns this scoring; the Wrapper
  -- records the outcome, it doesn't re-score. Kept separate from `stage`
  -- (Playbook §1.2: these must not overwrite each other).
  qualification_result text
    check (qualification_result in ('pending_review', 'pursue', 'no_bid', 'leadership_override')),
  scout_score numeric,          -- SCOUT's 0-100 weighted total
  scout_tier  text,             -- 'A' | 'B' | 'C' | 'no_bid' | 'disqualified'
  hot_lead_applied boolean not null default false, -- true if company.hot_lead bumped this bid's tier
  no_bid_reason text,
  override_reason text,         -- leadership override, if qualification_result = 'leadership_override'

  -- Opportunity Stage — Phase 1 doc §4 / Playbook §3.3. The approved 10-stage
  -- journey (plus On Hold). RFQ Imported is the entry point for every intake
  -- regardless of qualification result; No Bid is a terminal stage reached
  -- from Imported, not a starting one, so a disqualified/no-bid RFQ is still
  -- visible in the pipeline rather than silently absent.
  stage text not null default 'rfq_imported'
    check (stage in (
      'rfq_imported', 'no_bid', 'qualified_estimating', 'bid_in_preparation',
      'bid_submitted', 'client_evaluation', 'clarification_negotiation',
      'awarded_handoff', 'closed_won', 'closed_lost', 'on_hold'
    )),

  owner_username     text,   -- assignment-team / estimating lead who owns this bid
  estimator_username text,

  bid_due_date            date,
  submitted_date          date,
  expected_decision_date  date,
  award_date              date,

  estimated_value numeric,
  submitted_value numeric,
  final_value     numeric,

  next_action      text,
  next_action_date date,

  -- Required at Closed Lost (Playbook §5.2) — never optional once a bid
  -- reaches that stage. Separate from no_bid_reason: No Bid means Einbau
  -- chose not to compete; Closed Lost means a bid was submitted and lost.
  lost_reason     text,
  lost_competitor text,
  lost_feedback   text,

  -- On Hold (Playbook §3.3 / §5.2)
  hold_reason      text,
  hold_review_date date,

  -- Awarded → Handoff. HANDOFF already owns the Awarded-column → Portfolio
  -- gate; this just records that the bridge fired, it doesn't duplicate HANDOFF's
  -- own state machine.
  handoff_triggered_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index bids_company_idx on bids (company_id);
create index bids_stage_idx on bids (stage);
create index bids_owner_idx on bids (owner_username);
create index bids_next_action_idx on bids (next_action_date) where stage not in ('closed_won', 'closed_lost', 'no_bid');

-- ---------------------------------------------------------------------------
-- bid_stage_history — full audit trail of stage moves (Playbook §2.2 "audit
-- visibility for material stage, value, owner and outcome changes")
-- ---------------------------------------------------------------------------
create table bid_stage_history (
  id uuid primary key default gen_random_uuid(),
  bid_id uuid not null references bids(id) on delete cascade,

  from_stage text,
  to_stage   text not null,
  changed_by text not null,   -- Einbau ID username, or 'system' for the reconciliation poll
  note       text,

  changed_at timestamptz not null default now()
);

create index bid_stage_history_bid_idx on bid_stage_history (bid_id);

-- ---------------------------------------------------------------------------
-- bid_emails — the tender-correspondence archive. Item 2 of the original ask:
-- "database of all tender emails" + mailto popout. MVP: manually logged
-- (compose via mailto, then log what was sent) or forwarded in from an inbox
-- once a real intake address exists (see kickoff prompt, "Explicitly deferred").
-- ---------------------------------------------------------------------------
create table bid_emails (
  id uuid primary key default gen_random_uuid(),
  bid_id     uuid not null references bids(id) on delete cascade,
  company_id uuid references companies(id),

  direction text not null check (direction in ('outbound', 'inbound')),
  subject   text,
  from_address text,
  to_addresses text,     -- comma-separated; kept simple for MVP, not normalized
  cc_addresses text,
  body      text,

  -- 'manual' = logged by hand after using the mailto popout; 'inbound_forward'
  -- = arrived via a future forwarding rule; reserved for when that's built.
  source text not null default 'manual' check (source in ('manual', 'inbound_forward')),

  sent_at    timestamptz not null default now(),
  logged_by  text,
  created_at timestamptz not null default now()
);

create index bid_emails_bid_idx on bid_emails (bid_id);
create index bid_emails_company_idx on bid_emails (company_id);

-- ---------------------------------------------------------------------------
-- notifications — follow-up / staleness ledger (Playbook §5.3 Workflow C).
-- Persisted and shown in the UI; real Teams/email delivery is stubbed for now,
-- same "notification transport deferred" decision HANDOFF already made.
-- ---------------------------------------------------------------------------
create table notifications (
  id uuid primary key default gen_random_uuid(),
  bid_id uuid references bids(id) on delete cascade,

  type    text not null check (type in ('stale_followup', 'no_owner', 'missing_next_action', 'past_decision_date')),
  message text not null,
  status  text not null default 'pending' check (status in ('pending', 'acknowledged', 'closed')),

  created_at    timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by text
);

create index notifications_bid_idx on notifications (bid_id);
create index notifications_status_idx on notifications (status) where status = 'pending';
