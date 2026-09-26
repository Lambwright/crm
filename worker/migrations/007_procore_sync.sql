-- 007: Procore Bid Board sync (pushed from handoff-worker's own scan) +
-- follow-up cadence needing 'sync_needs_detail' as a notification type + the
-- 'auto' bid_emails source for the future per-bid inbound address capture.
-- Additive/non-destructive, safe to re-run.

alter table bids add column if not exists source_archived boolean not null default false;

alter table notifications drop constraint if exists notifications_type_check;
alter table notifications add constraint notifications_type_check
  check (type in ('stale_followup', 'no_owner', 'missing_next_action', 'past_decision_date', 'hot_lead_expiring', 'sync_needs_detail'));

alter table bid_emails drop constraint if exists bid_emails_source_check;
alter table bid_emails add constraint bid_emails_source_check
  check (source in ('manual', 'inbound_forward', 'auto'));
