-- 009: real decision / archive dates (Ben, 2026-10-06).
--
-- decided_at  - when a bid was actually moved to Awarded (complete) or Lost,
--               recorded by CRM itself (a manual move or the Procore sync
--               bridge). NULL for the historical backfill, which has no real
--               decision dates. Stays on the row if the bid is archived later,
--               so reporting survives Estimating's annual archive drain.
-- archived_at - when the sync first saw Procore's archived flag turn on.
--
-- The worker applies this itself (ensureSchema in src/index.js) the first time
-- it runs after deploy, including the one-time fill of decided_at from the
-- real (non-'system') stage-history rows already recorded; this file is the
-- record of it.
alter table bids add column if not exists decided_at timestamptz;
alter table bids add column if not exists archived_at timestamptz;
update bids b set decided_at = h.t
  from (select bid_id, to_stage, max(changed_at) as t from bid_stage_history
        where changed_by != 'system' group by bid_id, to_stage) h
  where h.bid_id = b.id and h.to_stage = b.stage and b.stage in ('complete', 'lost') and b.decided_at is null;
