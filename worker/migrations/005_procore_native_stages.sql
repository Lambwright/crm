-- Migration 005: replace CRM's synthetic stage taxonomy with Procore's own
-- 9 real Bid Board statuses (plus `no_bid`, kept as a 10th CRM-only stage for
-- SCOUT declines, which Procore's own vocabulary has no equivalent for).
--
-- "Awarded - Handoff Pending" (a CRM invention, not a Procore concept) is
-- dropped as a pipeline stage but preserved as `handoff_status`, an attribute
-- of Awarded (`complete`) bids rather than a stage of its own -- Ben liked
-- tracking it, but it isn't something a bid "moves through" the way a real
-- stage is, so it doesn't belong in the stage list once that list matches
-- Procore's.
--
-- Old -> new stage mapping (used only as a fallback for bids with no
-- source_status to derive from -- i.e. everything created directly in CRM,
-- not backfilled from Procore):
--   rfq_imported            -> invitation
--   qualified_estimating    -> accepted
--   bid_in_preparation      -> estimating
--   bid_submitted           -> bid_submitted   (unchanged)
--   client_evaluation       -> in_progress
--   clarification_negotiation -> in_progress
--   awarded_handoff         -> complete   (handoff_status = 'pending')
--   closed_won              -> complete   (handoff_status = 'complete')
--   closed_lost             -> lost
--   on_hold                 -> delayed
--   no_bid                  -> no_bid     (unchanged)
--
-- For backfilled bids, source_status (Procore's own label) is the ground
-- truth and is used instead of the old->new table above.

alter table bids add column if not exists handoff_status text check (handoff_status in ('pending', 'complete'));

alter table bids drop constraint if exists bids_stage_check;

update bids set stage = case
  when source_status = 'Invitation' then 'invitation'
  when source_status = 'Active (30-60 days)' then 'accepted'
  when source_status = 'Estimating Queue' then 'estimating'
  when source_status = 'Submitted (30 days)' then 'bid_submitted'
  when source_status = 'S/I Queue' then 'to_do'
  when source_status = 'Watch List' then 'delayed'
  when source_status = 'Active (60-90+ days)' then 'in_progress'
  when source_status = 'Lost ENA / CNA' then 'lost'
  when source_status = 'Awarded' then 'complete'
  -- no source_status (created directly in CRM, e.g. via SCOUT) -- fall back
  -- to the old stage name.
  when source_status is null and stage = 'rfq_imported' then 'invitation'
  when source_status is null and stage = 'qualified_estimating' then 'accepted'
  when source_status is null and stage = 'bid_in_preparation' then 'estimating'
  when source_status is null and stage = 'client_evaluation' then 'in_progress'
  when source_status is null and stage = 'clarification_negotiation' then 'in_progress'
  when source_status is null and stage = 'awarded_handoff' then 'complete'
  when source_status is null and stage = 'closed_won' then 'complete'
  when source_status is null and stage = 'closed_lost' then 'lost'
  when source_status is null and stage = 'on_hold' then 'delayed'
  else stage -- bid_submitted, no_bid already match; anything unexpected is left alone
end;

update bids set handoff_status = 'pending' where stage = 'complete' and source_status = 'Awarded' and handoff_status is null;
update bids set handoff_status = 'complete' where stage = 'complete' and source_status is null and handoff_status is null;

alter table bids add constraint bids_stage_check check (stage in (
  'invitation', 'accepted', 'estimating', 'bid_submitted', 'to_do',
  'delayed', 'in_progress', 'lost', 'complete', 'no_bid'
));
