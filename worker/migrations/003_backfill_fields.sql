-- Migration 003: fields needed for the Procore Bid Board historical backfill.
-- Additive/non-destructive.

-- The original Procore status label (e.g. "Awarded", "Lost ENA / CNA") a bid
-- was imported under — kept alongside the mapped CRM `stage` so a review
-- against Procore's own Bid Board can be done in Procore's own language,
-- not just CRM's internal stage names. Populated on backfilled/synced rows;
-- null for bids created directly in CRM (e.g. via SCOUT) with no Procore
-- status of their own yet.
alter table bids add column if not exists source_status text;

-- Real per-bid cost/hours/margin, pulled from Procore's Estimating line-items
-- API (not the company-wide default rate settings) where a linked project
-- exists. Null when no project was resolvable for that bid — see kickoff
-- prompt for the backfill's known coverage gaps.
alter table bids add column if not exists labor_hours numeric;
alter table bids add column if not exists labor_cost numeric;
alter table bids add column if not exists material_cost numeric;
alter table bids add column if not exists travel_cost numeric;
alter table bids add column if not exists margin_percent numeric;
