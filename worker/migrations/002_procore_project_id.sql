-- Migration 002: capture the Procore project_id link on a bid, when Procore
-- has one (only ~19% of "Awarded" bid board records currently do — mostly
-- recent ones, since the auto-link is a newer HANDOFF behavior). Stored for
-- future analysis flexibility; "won" for win-rate purposes is defined as
-- stage = 'closed_won' regardless of whether this is populated — see
-- crm-app-kickoff-prompt-v1.md, "Procore Bid Board backfill" section.

alter table bids add column if not exists procore_project_id text;
