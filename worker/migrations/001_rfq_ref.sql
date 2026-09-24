-- Migration 001: rename bids.procore_rfq_id -> bids.rfq_ref, add rfq_id_counters.
-- Additive/non-destructive — safe to run against the live `crm` Neon project.
-- See schema.sql for the authoritative, documented column/table definitions;
-- this file exists only so the change is applied without a destructive
-- drop-and-recreate of the whole schema.

alter table bids rename column procore_rfq_id to rfq_ref;

create table if not exists rfq_id_counters (
  estimator_initials text not null,
  day date not null,
  seq int not null default 1,
  primary key (estimator_initials, day)
);
