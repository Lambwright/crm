-- Migration 006: add `rfq` as a stage — a SCOUT-originated intake that
-- hasn't necessarily reached Procore's Bid Board yet, distinct from
-- `invitation` (specifically Procore's own native pre-bid status, per Ben:
-- "when someone sends us an invite through their Procore account"). No
-- existing bids are remapped to it — it's a new state going forward for
-- fresh SCOUT intakes only (see handleScoutIntake's initialStage).

alter table bids drop constraint if exists bids_stage_check;
alter table bids add constraint bids_stage_check check (stage in (
  'rfq', 'invitation', 'accepted', 'estimating', 'bid_submitted', 'to_do',
  'delayed', 'in_progress', 'lost', 'complete', 'no_bid'
));
