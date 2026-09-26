-- 008: a tunable settings singleton, editable from HELM (CRM Options tab)
-- instead of a code deploy — Ben, 2026-09: "I want to be able to tune that
-- easily as we really roll this out." Two knobs for now:
--   followup_cadence_days   - {stage: days} override merged over the code
--                              defaults (FOLLOWUP_CADENCE_DAYS in index.js)
--   assignable_usernames    - [{username, displayName}] — who's allowed to be
--                              set as a bid's owner/estimator (Ben: "only
--                              estimators or admin people"); an admin-role
--                              Einbau ID user always bypasses this list, and
--                              an EMPTY list means "not configured yet, allow
--                              anything" so this never locks anyone out
--                              before HELM's CRM Options page is used once.
create table if not exists crm_settings (
  singleton int primary key default 1 check (singleton = 1),
  followup_cadence_days jsonb not null default '{}'::jsonb,
  assignable_usernames jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into crm_settings (singleton) values (1) on conflict (singleton) do nothing;
