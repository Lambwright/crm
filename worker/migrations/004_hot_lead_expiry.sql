-- Migration 004: company-level notifications (for hot-lead expiry prompts).
-- notifications.bid_id was already nullable; this adds the company-side FK
-- and widens the type constraint. Additive/non-destructive.

alter table notifications add column if not exists company_id uuid references companies(id) on delete cascade;

alter table notifications drop constraint if exists notifications_type_check;
alter table notifications add constraint notifications_type_check
  check (type in ('stale_followup', 'no_owner', 'missing_next_action', 'past_decision_date', 'hot_lead_expiring'));

create index if not exists notifications_company_idx on notifications (company_id);
