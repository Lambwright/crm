// crm-worker
//
// The company/contact database, the bid pipeline + stage machine, the tender
// email log, hot-lead weighting, and stale-bid follow-up notifications for the
// Einbau "Wrapper" CRM. Built to replace NetSuite's CRM role (not its ERP/
// accounting role) per the two planning docs in ../Einbau_Phase_1_Customer_
// Journey_Validation.docx and ../Einbau_NetSuite_Technical_Implementation_
// Playbook.docx.pdf — see ../crm-app-kickoff-prompt-v1.md for the full context
// those docs don't carry (this suite's existing infra, SCOUT/HANDOFF's shape,
// the decisions made in planning).
//
// Routes:
//   POST   /rfq-ids/mint                (Einbau ID) mints/reuses today's next per-estimator rfq_ref (see mintRfqRef below)
//   POST   /intake/scout                (X-CRM-Service-Key) SCOUT pushes a scored RFQ; upserts company + bid
//   GET    /companies/lookup?name=      (X-CRM-Service-Key or Einbau ID) SCOUT reads hot-lead weight before/while scoring
//   GET    /companies?q=&segment=       (Einbau ID) list/search
//   POST   /companies                   (Einbau ID) manual create
//   GET    /companies/:id               (Einbau ID) detail + contacts + bid history
//   PATCH  /companies/:id               (Einbau ID) segment / hot-lead / notes edits; best-effort NetSuite mirror
//   POST   /companies/:id/contacts      (Einbau ID) add a contact
//   PATCH  /contacts/:id                (Einbau ID) edit a contact
//   GET    /bids?stage=&owner=&company_id=  (Einbau ID) pipeline list
//   GET    /bids/:id                    (Einbau ID) detail incl. stage history + emails
//   PATCH  /bids/:id                    (Einbau ID) general field edits (owner, estimator, values, dates, next action)
//   POST   /bids/:id/stage              (Einbau ID) { to_stage, ...required fields for that transition }
//   GET    /bids/:id/emails             (Einbau ID) tender email log for this bid
//   POST   /bids/:id/emails             (Einbau ID) log a sent/received tender email
//   GET    /notifications?status=       (Einbau ID) the follow-up/staleness ledger
//   POST   /notifications/:id/ack       (Einbau ID) acknowledge a notification
//   GET    /followups?mine=1            (Einbau ID) open bids due (or overdue) for a follow-up touch
//   GET    /access                      (Einbau ID) the caller's CRM level/permissions + who they can assign follow-ups to
//   GET    /settings                    (Einbau ID) follow-up cadence + assignable-users list
//   PATCH  /settings                    (Einbau ID, admin) edit them — see HELM's "CRM Options" tab
//   GET    /dashboard/summary           (Einbau ID) pipeline-by-stage, aging, win-rate aggregates
//   POST   /internal/procore-sync       (X-Crm-Sync-Key) handoff-worker pushes Bid Board status batches here
//   POST   /internal/admin/migrate      (X-Crm-Admin-Key) one-off manual migration runner — see bottom of file
//   POST   /internal/admin/backfill-followup-dates  (X-Crm-Admin-Key) one-off: real created_at + cadence -> next_action_date for open bids missing one
//   scheduled (cron 0 13 * * *)         flag stale/ownerless/actionless open bids into notifications
//
// Secrets: DATABASE_URL, CRM_SERVICE_KEY, NETSUITE_SERVICE_KEY, CRM_SYNC_KEY, CRM_ADMIN_KEY
//
// Design notes:
//  - Qualification Result, Opportunity Stage, and Account Segment are kept as
//    three separate fields (two on `bids`, one on `companies`) and nothing in
//    this file ever writes one from another — see the planning docs' "why
//    this matters" (a company can be a Customer while one bid is Closed Won,
//    another Closed Lost, and a third still open).
//  - Company/contact matching is a simple case-insensitive exact-name match
//    for the MVP, not INTAKE's fuzzy Directory matcher. Revisit before this
//    creates duplicate company rows at any real volume — see kickoff prompt
//    "Explicitly deferred".
//  - NetSuite mirroring (hot-lead flag/weight only, per the parallel-run
//    decision) is fire-and-forget: a NetSuite failure is logged on the company
//    row (netsuite_sync_status/netsuite_sync_error) and never blocks the save.

import { neon } from "@neondatabase/serverless";

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*", // tighten to the GitHub Pages origin once live
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-CRM-Service-Key",
    "Access-Control-Expose-Headers": "X-Refreshed-Token",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function sqlFor(env) {
  return neon(env.DATABASE_URL);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s) {
  return typeof s === "string" && UUID_RE.test(s);
}

async function parseBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Auth — same shape as every other suite Worker (TALLY/HANDOFF/PUNCH)
// ---------------------------------------------------------------------------

function isServiceCaller(request, env) {
  const key = request.headers.get("X-CRM-Service-Key");
  return Boolean(key) && Boolean(env.CRM_SERVICE_KEY) && key === env.CRM_SERVICE_KEY;
}

async function requireLogin(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return { ok: false, reason: "No session token was sent with the request." };
  try {
    // Service binding, not a public fetch — a Worker calling another Worker's
    // *.workers.dev URL directly is blocked with Cloudflare error 1042.
    const res = await env.AUTH_WORKER.fetch("https://auth.ben-a90.workers.dev/auth/verify", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "(no body)");
      return { ok: false, reason: `auth-worker rejected the verify call (HTTP ${res.status}): ${bodyText.slice(0, 200)}` };
    }
    const data = await res.json();
    if (!data.valid) return { ok: false, reason: "Session is invalid or expired — please log in again." };
    if (!data.user) return { ok: false, reason: "auth-worker returned no user for this session." };

    // Per-app access list from HELM (auth-worker/README.md, "The user object,
    // and the apps field") — auth-worker now always returns `apps` as an
    // array (never undefined) and fails closed: no apps granted means no
    // access, full stop, not "unrestricted." Admin role does NOT bypass this
    // (matches every other suite app's post-2026-09-28 gate).
    if (!Array.isArray(data.user.apps) || !data.user.apps.includes("CRM")) {
      return { ok: false, reason: `"${data.user.username}" doesn't have CRM access (HELM apps list).` };
    }

    // Role-matrix switch-over (auth-worker/README.md "Role matrix"): three
    // states for appRoles.CRM, decided by resolveCrmAccess below.
    //   live    -> a real level (admin/estimator/pm); the matrix is the gate
    //   legacy  -> "access" (CRM's Live switch in HELM is still off): keep
    //              today's checks exactly (ALLOWED_ROLES on user.role,
    //              user.role === "admin", assignable_usernames) so deploying
    //              this before Ben flips the switch changes nobody's access
    //   denied  -> "no_access" or any value we don't recognise
    const crm = resolveCrmAccess(data.user);
    if (crm.mode === "denied") {
      return { ok: false, reason: `"${data.user.username}" has no CRM access in the role matrix.` };
    }
    if (crm.mode === "legacy") {
      const allowedRoles = String(env.ALLOWED_ROLES || "admin,user").split(",").map((r) => r.trim());
      if (!allowedRoles.includes(data.user.role)) {
        return { ok: false, reason: `Logged in as "${data.user.username}" (role "${data.user.role}"), which isn't allowed in CRM.` };
      }
    }
    // _crm / _token are internal: handlers read the resolved level and the
    // caller's own token (to look people up through auth-worker) from here.
    return { ok: true, user: { ...data.user, _crm: crm, _token: token }, refreshedToken: data.refreshedToken || null };
  } catch (e) {
    return { ok: false, reason: `Couldn't reach auth-worker: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// CRM permissions from the Einbau ID role matrix (2026-10). Levels, per Ben:
//   admin     - everything, including settings
//   estimator - move bids between stages, hot-lead a company, assign follow-ups
//   pm        - can be assigned follow-ups, can't assign them (or do the above)
// Everything privileged is checked here on the server; hiding it in the UI is
// cosmetic only.
// ---------------------------------------------------------------------------

const CRM_LEVELS = ["admin", "estimator", "pm"];

function resolveCrmAccess(user) {
  const roles = user && user.appRoles && typeof user.appRoles === "object" ? user.appRoles : null;
  const level = roles ? roles.CRM : undefined;
  if (typeof level === "string" && CRM_LEVELS.includes(level)) return { mode: "live", level };
  // "access" is the matrix's neutral "granted, app not switched yet". A
  // missing appRoles / missing CRM key is treated the same way rather than
  // as a denial: it can only mean an auth-worker that predates the matrix,
  // and falling back to today's checks is no looser than what CRM already
  // does — whereas denying would lock everyone out.
  if (level === "access" || level === undefined) return { mode: "legacy", level: null };
  return { mode: "denied", level: null }; // "no_access" or anything unrecognised
}

function crmOf(user) {
  return (user && user._crm) || { mode: "legacy", level: null };
}

// In legacy mode every one of these keeps today's behaviour: stage moves and
// hot-lead edits were never restricted by role, and the admin check was the
// legacy user.role.
function canMoveStages(user) {
  const c = crmOf(user);
  return c.mode === "live" ? c.level === "admin" || c.level === "estimator" : true;
}
function canSetHotLead(user) {
  const c = crmOf(user);
  return c.mode === "live" ? c.level === "admin" || c.level === "estimator" : true;
}
function canAssignFollowups(user) {
  const c = crmOf(user);
  return c.mode === "live" ? c.level === "admin" || c.level === "estimator" : true;
}
// Ben, 2026-10-05 (live mode only — legacy keeps today's no-restriction behaviour):
// blacklist designation = admin only; account segment and handoff_status =
// estimator and admin.
const BLACKLIST_SEGMENTS = ["do_not_pursue", "do_not_work_with"];
function canManageBlacklist(user) {
  const c = crmOf(user);
  return c.mode === "live" ? c.level === "admin" : true;
}
function canChangeSegment(user) {
  const c = crmOf(user);
  return c.mode === "live" ? c.level === "admin" || c.level === "estimator" : true;
}
function canSetHandoffStatus(user) {
  const c = crmOf(user);
  return c.mode === "live" ? c.level === "admin" || c.level === "estimator" : true;
}
function isCrmAdmin(user) {
  const c = crmOf(user);
  return c.mode === "live" ? c.level === "admin" : user.role === "admin";
}

function forbidden(detail) {
  return json({ error: "forbidden", detail }, 403);
}

// Everyone who can open CRM, with their level — POST /auth/app/users over the
// AUTH_WORKER binding using the caller's own token. Short in-isolate cache:
// the answer is the same for every caller with CRM access, and pickers hit it
// on every page load.
let crmPeopleCache = { at: 0, users: null };
async function getCrmPeople(env, user) {
  if (crmPeopleCache.users && Date.now() - crmPeopleCache.at < 60_000) return crmPeopleCache.users;
  const res = await env.AUTH_WORKER.fetch("https://auth.ben-a90.workers.dev/auth/app/users", {
    method: "POST",
    headers: { Authorization: `Bearer ${user._token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ app: "CRM" }),
  });
  if (!res.ok) throw new Error(`auth-worker /auth/app/users failed (HTTP ${res.status})`);
  const data = await res.json();
  const users = Array.isArray(data.users) ? data.users : [];
  crmPeopleCache = { at: Date.now(), users };
  return users;
}

// Who can be set as a bid's owner/estimator. Live mode: anyone whose CRM level
// is pm, estimator or admin (read from auth-worker, not a list kept here).
async function eligibleAssignees(env, user) {
  return (await getCrmPeople(env, user)).filter((p) => CRM_LEVELS.includes(p.level));
}

// Changing a bid's owner/estimator. `changes` is [[field, newValue, oldValue]];
// only a real change counts — re-sending the current value is not an
// assignment. Returns null if fine, else a 4xx Response.
async function checkAssignmentChange(env, settings, user, changes) {
  const real = changes.filter(([, next, prev]) => (next || null) !== (prev || null));
  if (!real.length) return null;
  if (crmOf(user).mode === "live") {
    if (!canAssignFollowups(user)) return forbidden("Only estimators and admins can assign follow-ups.");
    const eligible = new Set((await eligibleAssignees(env, user)).map((p) => p.username));
    for (const [field, next] of real) {
      if (next && !eligible.has(next)) {
        return json({ error: "not_assignable", detail: `"${next}" can't be assigned follow-ups — they need CRM access at PM level or above.` }, 422);
      }
    }
    return null;
  }
  for (const [field, next] of real) {
    if (!isAssignableUsername(settings, user, next)) {
      return json({ error: "not_assignable", detail: `"${next}" isn't on the assignable-users list (HELM → CRM Options).` }, 422);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stage machine — Procore's own 9 Bid Board statuses (2026-09 decision,
// migration 005), plus `no_bid` as a 10th CRM-only stage for SCOUT declines.
// Kept as data, not scattered if/else, so the required-field list per
// transition is auditable in one place. Most of Procore's own statuses
// (Watch List, the two Active aging buckets, S/I Queue) turned out to be
// attention/aging flags rather than real data-collection points once Ben
// walked through what they actually mean day-to-day, so only the two
// transitions with a real backing requirement (Lost, Awarded) are gated —
// don't add requirements to the others without confirming they're real.
// Order matches Procore's own Bid Board column order (confirmed against a
// live screenshot, 2026-09), with `rfq` prepended (SCOUT-side, pre-Procore)
// and `no_bid` appended (CRM-only, no Procore equivalent). `to_do` (S/I
// Queue) wasn't visible in that screenshot (scrolled off-screen, along with
// `invitation`) — its position here, right before `complete`, is a guess,
// not confirmed. Flag if it's actually somewhere else on the real board.
const STAGES = [
  "rfq", "invitation", "estimating", "bid_submitted", "accepted",
  "in_progress", "to_do", "complete", "delayed", "lost", "no_bid",
];

// Procore's own display labels for each raw stage key (Einbau's instance,
// confirmed live via /estimating/settings — see kickoff prompt). `rfq` and
// `no_bid` have no Procore equivalent; those two labels are CRM's own.
const PROCORE_STAGE_LABELS = {
  rfq: "RFQ",
  invitation: "Invitation",
  accepted: "Active (30-60 days)",
  estimating: "Estimating Queue",
  bid_submitted: "Submitted (30 days)",
  to_do: "S/I Queue",
  delayed: "Watch List",
  in_progress: "Active (60-90+ days)",
  lost: "Lost ENA / CNA",
  complete: "Awarded",
  no_bid: "No Bid",
};

// field -> human label, used to build a clear "missing" error message.
const STAGE_REQUIREMENTS = {
  no_bid: [["no_bid_reason", "No-Bid Reason"]],
  bid_submitted: [
    ["submitted_date", "Submitted Date"],
    ["submitted_value", "Submitted Value"],
    ["expected_decision_date", "Expected Decision Date"],
    ["next_action_date", "Follow-Up Date"],
  ],
  complete: [
    ["final_value", "Final Value"],
    ["award_date", "Award Date"],
  ],
  lost: [["lost_reason", "Lost Reason"]],
};

// Validate against the merged view of {existing bid row, incoming payload} —
// lets a client satisfy a gate in the same call that requests the move,
// mirroring HANDOFF's Purgatory-gate pattern (fill it now or be told what's missing).
function validateStageTransition(bid, toStage, payload) {
  if (!STAGES.includes(toStage)) return { ok: false, missing: [], badStage: true };
  const reqs = STAGE_REQUIREMENTS[toStage] || [];
  const merged = { ...bid, ...payload };
  const missing = reqs.filter(([field]) => merged[field] === undefined || merged[field] === null || merged[field] === "");
  return { ok: missing.length === 0, missing: missing.map(([, label]) => label) };
}

// ---------------------------------------------------------------------------
// Follow-up cadence (2026-09, Ben) — how often an open bid needs a human
// touch before it's considered overdue. These are just the fallback
// defaults now — HELM's "CRM Options" tab can override any of them at
// runtime via crm_settings.followup_cadence_days (see getCrmSettings below)
// without a code deploy. Only used to compute `next_action_date` when
// nobody's set one explicitly (or the one that's there has already passed);
// never overwrites a real future date someone deliberately chose. No entry
// = closed stage, no cadence.
// ---------------------------------------------------------------------------
const DEFAULT_CADENCE_DAYS = {
  rfq: 3,
  invitation: 3,
  estimating: 5,
  bid_submitted: 7,
  to_do: 7,
  accepted: 14,
  in_progress: 14,
  delayed: 14,
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// Only pushes the date forward when there isn't already a sensible future
// one sitting there — so a manual pick always wins until it itself goes
// stale. `force` (used right after logging an outbound follow-up) always
// resets the clock, since contact just happened. `cadenceDays` is the
// merged (settings-over-defaults) map from getCrmSettings, not the constant
// directly, so this stays runtime-tunable.
function autoFollowUpDate(cadenceDays, stage, existingDateStr, { force = false } = {}) {
  const cadence = cadenceDays[stage];
  if (!cadence) return existingDateStr ?? null;
  const today = todayIso();
  if (!force && existingDateStr && existingDateStr >= today) return existingDateStr;
  const next = new Date();
  next.setUTCDate(next.getUTCDate() + cadence);
  return next.toISOString().slice(0, 10);
}

// One row, read-modify-write from HELM's CRM Options tab (GET/PATCH
// /settings below) — see migration 008. `cadence` is the code defaults with
// any per-stage override layered on top; `assignableUsernames` is
// [{username, displayName}] and empty means "not configured yet, allow
// anything" (see isAssignableUsername).
async function getCrmSettings(sql) {
  const [row] = await sql`select * from crm_settings where singleton = 1`;
  return {
    cadence: { ...DEFAULT_CADENCE_DAYS, ...(row?.followup_cadence_days || {}) },
    assignableUsernames: Array.isArray(row?.assignable_usernames) ? row.assignable_usernames : [],
    updated_at: row?.updated_at || null,
    updated_by: row?.updated_by || null,
  };
}

// Ben, 2026-09: "only estimators or admin people who can assign follow-ups."
// Einbau ID itself only has admin/user roles (no "estimator"), so the
// estimator/PM set is this configurable list instead; an admin-role user
// always bypasses it. Clearing an assignment (username null/empty) is
// always allowed.
function isAssignableUsername(settings, actingUser, username) {
  if (!username) return true;
  if (actingUser.role === "admin") return true;
  if (!settings.assignableUsernames.length) return true;
  return settings.assignableUsernames.some((u) => u.username === username);
}

// ---------------------------------------------------------------------------
// NetSuite mirror — best-effort only. Parallel-run decision: hot-lead
// flag/weight is recorded here AND pushed to NetSuite's Customer record so
// either system reflects it during the transition period. Never blocks the
// caller's save if NetSuite (or the field-id config) isn't ready.
// ---------------------------------------------------------------------------

async function pushHotLeadToNetSuite(env, company) {
  if (!company.netsuite_customer_id) return { skipped: "no netsuite_customer_id on this company yet" };
  if (!env.NETSUITE_HOTLEAD_FIELD_ID) return { skipped: "NETSUITE_HOTLEAD_FIELD_ID not configured — see wrangler.jsonc TODO" };
  if (!env.NETSUITE_WORKER || !env.NETSUITE_SERVICE_KEY) return { skipped: "NETSUITE_WORKER binding / NETSUITE_SERVICE_KEY not configured" };
  try {
    const res = await env.NETSUITE_WORKER.fetch("https://netsuite.ben-a90.workers.dev/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-NetSuite-Service-Key": env.NETSUITE_SERVICE_KEY },
      body: JSON.stringify({
        method: "PATCH",
        path: `/customer/${company.netsuite_customer_id}`,
        data: { [env.NETSUITE_HOTLEAD_FIELD_ID]: company.hot_lead },
      }),
    });
    if (!res.ok) return { error: `netsuite-worker HTTP ${res.status}` };
    const data = await res.json().catch(() => ({}));
    if (data.error) return { error: data.error };
    return { synced: true };
  } catch (e) {
    return { error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Company matching — simple exact-name match for the MVP. TODO: replace with
// (or delegate to) INTAKE's fuzzy Directory matcher (scout-intake/index.html)
// before this runs at real volume — see kickoff prompt "Explicitly deferred".
// ---------------------------------------------------------------------------

async function findOrCreateCompany(sql, { name, procore_vendor_id }) {
  if (!name || !name.trim()) throw new Error("company name is required");
  const existing = await sql`select * from companies where lower(name) = lower(${name.trim()}) limit 1`;
  if (existing.length) return existing[0];
  const [created] = await sql`
    insert into companies (name, procore_vendor_id)
    values (${name.trim()}, ${procore_vendor_id || null})
    returning *`;
  return created;
}

// ---------------------------------------------------------------------------
// /rfq-ids/mint — mints (or, within the same day, returns the next
// sequential) rfq_ref for the logged-in estimator. SCOUT calls this once per
// browser tab (caching the result in that tab's sessionStorage — see
// scout-addin/app.html), not once per RFQ resubmission, so "mint" here always
// means "give me a new one"; reuse-within-a-tab is entirely a SCOUT-side
// concern. Format: <2-letter initials><YY><MM><DD><2-digit daily sequence>,
// e.g. BW26092301. The per-estimator-per-day counter means concurrent tabs
// from the SAME estimator never collide (Postgres's own row locking on the
// upsert below makes that safe), and different estimators never collide
// either (they each get their own initials prefix).
function initialsFor(user) {
  if (user.firstName && user.lastName) return (user.firstName[0] + user.lastName[0]).toUpperCase();
  return String(user.username || "XX").slice(0, 2).toUpperCase();
}

async function handleMintRfqRef(sql, user) {
  const initials = initialsFor(user);
  const [{ seq }] = await sql`
    insert into rfq_id_counters (estimator_initials, day, seq)
    values (${initials}, current_date, 1)
    on conflict (estimator_initials, day) do update set seq = rfq_id_counters.seq + 1
    returning seq`;
  const now = new Date();
  const yy = String(now.getUTCFullYear()).slice(-2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const rfq_ref = `${initials}${yy}${mm}${dd}${String(seq).padStart(2, "0")}`;
  return json({ rfq_ref });
}

// ---------------------------------------------------------------------------
// /intake/scout — SCOUT pushes a scored RFQ here (in parallel with its
// existing NetSuite Opportunity write, per the parallel-run decision).
// Upserts the company and the bid by rfq_ref (Playbook §4.2: same RFQ
// resubmitted updates the row, never creates a second one) — rfq_ref is
// minted early by /rfq-ids/mint above, not derived from anything Procore- or
// NetSuite-specific; see that route's comment and the kickoff prompt.
// ---------------------------------------------------------------------------

async function handleScoutIntake(request, sql) {
  const body = await parseBody(request);
  const { rfq_ref, project_name, company_name, procore_vendor_id, contact, qualification_result, scout_score, scout_tier, hot_lead_applied, no_bid_reason, bid_due_date, procore_bid_board_id } = body;
  if (!rfq_ref) return json({ error: "rfq_ref is required" }, 400);
  if (!project_name) return json({ error: "project_name is required" }, 400);
  if (!company_name) return json({ error: "company_name is required" }, 400);

  const settings = await getCrmSettings(sql);
  const company = await findOrCreateCompany(sql, { name: company_name, procore_vendor_id });

  let contactRow = null;
  if (contact && contact.email) {
    const existingContact = await sql`
      select * from contacts where company_id = ${company.id} and lower(email) = lower(${contact.email}) limit 1`;
    contactRow = existingContact[0] || (await sql`
      insert into contacts (company_id, first_name, last_name, title, email, phone)
      values (${company.id}, ${contact.fname || null}, ${contact.lname || null}, ${contact.title || null}, ${contact.email}, ${contact.phone || null})
      returning *`)[0];
  }

  // A fresh intake starts at `rfq`, unless SCOUT already pushed it to the
  // Procore Bid Board in the same submit (push_to_bid checked, so it hands
  // back a real procore_bid_board_id) — that's Procore's own native pre-bid
  // status, `invitation`, not CRM's pre-Procore placeholder.
  const initialStage = qualification_result === "no_bid" ? "no_bid" : (procore_bid_board_id ? "invitation" : "rfq");

  const existingBid = await sql`select * from bids where rfq_ref = ${rfq_ref} limit 1`;
  let bid;
  if (existingBid.length) {
    [bid] = await sql`
      update bids set
        project_name = ${project_name},
        company_id = ${company.id},
        contact_id = ${contactRow ? contactRow.id : existingBid[0].contact_id},
        qualification_result = ${qualification_result || existingBid[0].qualification_result},
        scout_score = ${scout_score ?? existingBid[0].scout_score},
        scout_tier = ${scout_tier ?? existingBid[0].scout_tier},
        hot_lead_applied = ${Boolean(hot_lead_applied)},
        no_bid_reason = ${no_bid_reason ?? existingBid[0].no_bid_reason},
        bid_due_date = ${bid_due_date ?? existingBid[0].bid_due_date},
        procore_bid_board_id = ${procore_bid_board_id ?? existingBid[0].procore_bid_board_id},
        updated_at = now()
      where id = ${existingBid[0].id}
      returning *`;
  } else {
    [bid] = await sql`
      insert into bids (
        rfq_ref, project_name, company_id, contact_id, qualification_result,
        scout_score, scout_tier, hot_lead_applied, no_bid_reason, bid_due_date, stage,
        procore_bid_board_id, next_action_date
      ) values (
        ${rfq_ref}, ${project_name}, ${company.id}, ${contactRow ? contactRow.id : null}, ${qualification_result || "pending_review"},
        ${scout_score ?? null}, ${scout_tier ?? null}, ${Boolean(hot_lead_applied)}, ${no_bid_reason ?? null}, ${bid_due_date ?? null}, ${initialStage},
        ${procore_bid_board_id ?? null}, ${autoFollowUpDate(settings.cadence, initialStage, null)}
      ) returning *`;
    await sql`insert into bid_stage_history (bid_id, from_stage, to_stage, changed_by, note)
      values (${bid.id}, null, ${initialStage}, 'system', 'Created from SCOUT intake')`;
  }

  return json({ company, contact: contactRow, bid }, existingBid.length ? 200 : 201);
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

async function handleCompanyLookup(url, sql) {
  const name = (url.searchParams.get("name") || "").trim();
  if (!name) return json({ error: "name query param is required" }, 400);
  const rows = await sql`select id, name, account_segment, hot_lead, hot_lead_weight, hot_lead_reason from companies where lower(name) = lower(${name}) limit 1`;
  if (!rows.length) return json({ found: false });
  return json({ found: true, company: rows[0] });
}

async function handleCompaniesList(url, sql) {
  const q = (url.searchParams.get("q") || "").trim();
  const segment = url.searchParams.get("segment");
  // Single query with (param is null or ...) conditions rather than 4
  // hand-duplicated branches, now that it also needs the bids join/aggregate
  // below — bound params throughout, no raw text splicing.
  const rows = await sql`
    select c.*,
      count(b.id)::int as bid_count,
      count(*) filter (where b.stage = 'complete')::int as won_count,
      count(*) filter (where b.stage = 'lost')::int as lost_count,
      coalesce(sum(b.estimated_value),0)::float as total_value
    from companies c
    left join bids b on b.company_id = c.id
    where (${q || null}::text is null or lower(c.name) like ${q ? "%" + q.toLowerCase() + "%" : null})
      and (${segment || null}::text is null or c.account_segment = ${segment || null})
    group by c.id
    order by c.name
    limit 200`;
  return json({ companies: rows });
}

async function handleCompanyCreate(request, sql) {
  const body = await parseBody(request);
  if (!body.name || !body.name.trim()) return json({ error: "name is required" }, 400);
  const [company] = await sql`
    insert into companies (name, account_segment, region, vertical, tier, notes)
    values (${body.name.trim()}, ${body.account_segment || "unreviewed"}, ${body.region || null}, ${body.vertical || null}, ${body.tier || null}, ${body.notes || null})
    returning *`;
  return json({ company }, 201);
}

async function handleCompanyDetail(id, sql) {
  const rows = await sql`select * from companies where id = ${id}`;
  if (!rows.length) return json({ error: "not_found" }, 404);
  const contacts = await sql`select * from contacts where company_id = ${id} order by created_at`;
  const bids = await sql`select id, rfq_ref, project_name, stage, qualification_result, estimated_value, submitted_value, final_value, bid_due_date, created_at from bids where company_id = ${id} order by created_at desc`;
  return json({ company: rows[0], contacts, bids });
}

const COMPANY_PATCHABLE = ["account_segment", "region", "vertical", "tier", "notes", "hot_lead", "hot_lead_weight", "hot_lead_reason", "netsuite_customer_id"];

async function handleCompanyPatch(id, request, sql, env, user) {
  const body = await parseBody(request);
  if (["hot_lead", "hot_lead_weight", "hot_lead_reason"].some((f) => body[f] !== undefined) && !canSetHotLead(user)) {
    return forbidden("Only estimators and admins can add or change the hot-lead designation.");
  }
  const existing = await sql`select * from companies where id = ${id}`;
  if (!existing.length) return json({ error: "not_found" }, 404);

  const fields = Object.keys(body).filter((k) => COMPANY_PATCHABLE.includes(k));
  if (!fields.length) return json({ error: "no_valid_fields", detail: `Patchable fields: ${COMPANY_PATCHABLE.join(", ")}` }, 400);

  // Only a real change counts. Adding OR removing a blacklist designation is
  // admin-only (an estimator un-blacklisting would defeat the point); any
  // other segment change is estimator/admin.
  if (body.account_segment !== undefined && body.account_segment !== existing[0].account_segment) {
    if (BLACKLIST_SEGMENTS.includes(body.account_segment) || BLACKLIST_SEGMENTS.includes(existing[0].account_segment)) {
      if (!canManageBlacklist(user)) return forbidden("Only admins can add or remove a Do Not Pursue / Do Not Work With designation.");
    } else if (!canChangeSegment(user)) {
      return forbidden("Only estimators and admins can change an account's segment.");
    }
  }

  const hotLeadTouched = fields.includes("hot_lead") || fields.includes("hot_lead_weight");
  const setClauses = { ...existing[0], ...body };
  if (hotLeadTouched) {
    setClauses.hot_lead_set_by = user.username;
    setClauses.hot_lead_set_at = new Date().toISOString();
  }

  const [company] = await sql`
    update companies set
      account_segment = ${setClauses.account_segment},
      region = ${setClauses.region},
      vertical = ${setClauses.vertical},
      tier = ${setClauses.tier},
      notes = ${setClauses.notes},
      hot_lead = ${setClauses.hot_lead},
      hot_lead_weight = ${setClauses.hot_lead_weight},
      hot_lead_reason = ${setClauses.hot_lead_reason},
      hot_lead_set_by = ${setClauses.hot_lead_set_by},
      hot_lead_set_at = ${setClauses.hot_lead_set_at},
      netsuite_customer_id = ${setClauses.netsuite_customer_id},
      updated_at = now()
    where id = ${id}
    returning *`;

  if (hotLeadTouched) {
    const syncResult = await pushHotLeadToNetSuite(env, company);
    const [synced] = await sql`
      update companies set
        netsuite_sync_status = ${syncResult.synced ? "synced" : syncResult.skipped ? null : "failed"},
        netsuite_synced_at = ${syncResult.synced ? new Date().toISOString() : company.netsuite_synced_at},
        netsuite_sync_error = ${syncResult.error || null}
      where id = ${id}
      returning *`;
    return json({ company: synced, netsuite_sync: syncResult });
  }

  return json({ company });
}

async function handleContactCreate(companyId, request, sql) {
  const body = await parseBody(request);
  const companyRows = await sql`select id from companies where id = ${companyId}`;
  if (!companyRows.length) return json({ error: "company_not_found" }, 404);
  const [contact] = await sql`
    insert into contacts (company_id, first_name, last_name, title, email, phone)
    values (${companyId}, ${body.first_name || null}, ${body.last_name || null}, ${body.title || null}, ${body.email || null}, ${body.phone || null})
    returning *`;
  return json({ contact }, 201);
}

async function handleContactPatch(id, request, sql) {
  const body = await parseBody(request);
  const existing = await sql`select * from contacts where id = ${id}`;
  if (!existing.length) return json({ error: "not_found" }, 404);
  const merged = { ...existing[0], ...body };
  const [contact] = await sql`
    update contacts set
      first_name = ${merged.first_name}, last_name = ${merged.last_name},
      title = ${merged.title}, email = ${merged.email}, phone = ${merged.phone},
      updated_at = now()
    where id = ${id}
    returning *`;
  return json({ contact });
}

// ---------------------------------------------------------------------------
// Bids
// ---------------------------------------------------------------------------

async function handleBidsList(url, sql) {
  const stage = url.searchParams.get("stage");
  const owner = url.searchParams.get("owner");
  const companyId = url.searchParams.get("company_id");

  // @neondatabase/serverless's sql`` tag binds every ${} as a parameter value,
  // not as composable raw SQL — it doesn't support joining sql`` fragments
  // together (unlike postgres.js). Rather than reach for string-built SQL to
  // work around that, filter in JS: pipeline size for a subcontractor's bid
  // board is realistically dozens to low hundreds of rows, well within what's
  // reasonable to filter after one indexed fetch. Revisit if that stops being true.
  // has_activity: any real CRM-side touch beyond the bid just existing — a
  // tender email logged, a stage move beyond the initial creation entry, or a
  // next-action note set. Drives the Pipeline board's "bring touched bids to
  // the top" + highlight behavior (Ben, 2026-09).
  const rows = await sql`
    select b.*, c.name as company_name, c.hot_lead as company_hot_lead,
      (exists(select 1 from bid_emails e where e.bid_id = b.id)
        or (select count(*) from bid_stage_history h where h.bid_id = b.id) > 1
        or b.next_action is not null) as has_activity
    from bids b left join companies c on c.id = b.company_id
    order by b.updated_at desc limit 1000`;

  const filtered = rows.filter((b) =>
    (!stage || b.stage === stage) &&
    (!owner || b.owner_username === owner) &&
    (!companyId || b.company_id === companyId)
  );
  return json({ bids: filtered });
}

async function handleBidDetail(id, sql) {
  const rows = await sql`
    select b.*, c.name as company_name, ct.email as contact_email, ct.first_name as contact_first_name, ct.last_name as contact_last_name
    from bids b left join companies c on c.id = b.company_id left join contacts ct on ct.id = b.contact_id
    where b.id = ${id}`;
  if (!rows.length) return json({ error: "not_found" }, 404);
  const history = await sql`select * from bid_stage_history where bid_id = ${id} order by changed_at desc`;
  const emails = await sql`select * from bid_emails where bid_id = ${id} order by sent_at desc`;
  return json({ bid: rows[0], stage_history: history, emails });
}

const BID_PATCHABLE = [
  "owner_username", "estimator_username", "bid_due_date", "submitted_date",
  "expected_decision_date", "award_date", "estimated_value", "submitted_value",
  "final_value", "next_action", "next_action_date", "contact_id", "handoff_status",
];

async function handleBidPatch(id, request, sql, env, user) {
  const body = await parseBody(request);
  const existing = await sql`select * from bids where id = ${id}`;
  if (!existing.length) return json({ error: "not_found" }, 404);
  const fields = Object.keys(body).filter((k) => BID_PATCHABLE.includes(k));
  if (!fields.length) return json({ error: "no_valid_fields", detail: `Patchable fields: ${BID_PATCHABLE.join(", ")}` }, 400);

  if (body.handoff_status !== undefined && (body.handoff_status || null) !== (existing[0].handoff_status || null) && !canSetHandoffStatus(user)) {
    return forbidden("Only estimators and admins can change a bid's handoff status.");
  }

  if (body.owner_username !== undefined || body.estimator_username !== undefined) {
    const settings = await getCrmSettings(sql);
    const denied = await checkAssignmentChange(
      env, settings, user,
      ["owner_username", "estimator_username"]
        .filter((f) => body[f] !== undefined)
        .map((f) => [f, body[f], existing[0][f]])
    );
    if (denied) return denied;
  }

  const merged = { ...existing[0], ...body };
  const [bid] = await sql`
    update bids set
      owner_username = ${merged.owner_username}, estimator_username = ${merged.estimator_username},
      bid_due_date = ${merged.bid_due_date}, submitted_date = ${merged.submitted_date},
      expected_decision_date = ${merged.expected_decision_date}, award_date = ${merged.award_date},
      estimated_value = ${merged.estimated_value}, submitted_value = ${merged.submitted_value},
      final_value = ${merged.final_value}, next_action = ${merged.next_action},
      next_action_date = ${merged.next_action_date}, contact_id = ${merged.contact_id},
      handoff_status = ${merged.handoff_status},
      updated_at = now()
    where id = ${id}
    returning *`;
  return json({ bid });
}

async function handleBidStageChange(id, request, sql, env, user) {
  if (!canMoveStages(user)) return forbidden("Only estimators and admins can move bids between stages.");
  const body = await parseBody(request);
  const { to_stage } = body;
  if (!to_stage) return json({ error: "to_stage is required" }, 400);

  const existing = await sql`select * from bids where id = ${id}`;
  if (!existing.length) return json({ error: "not_found" }, 404);
  const bid = existing[0];

  const validation = validateStageTransition(bid, to_stage, body);
  if (validation.badStage) return json({ error: "unknown_stage", detail: `"${to_stage}" isn't a recognized stage.` }, 400);
  if (!validation.ok) return json({ error: "missing_required_fields", missing: validation.missing }, 422);

  const settings = await getCrmSettings(sql);
  const assignDenied = await checkAssignmentChange(
    env, settings, user,
    ["owner_username", "estimator_username"]
      .filter((f) => body[f] !== undefined)
      .map((f) => [f, body[f], bid[f]])
  );
  if (assignDenied) return assignDenied;

  // Only auto-refresh the cadence date when the caller didn't explicitly set
  // one in this same call — a human picking a specific follow-up date always
  // wins over the generic default.
  const merged = { ...bid, ...body, stage: to_stage };
  if (body.next_action_date === undefined) {
    merged.next_action_date = autoFollowUpDate(settings.cadence, to_stage, bid.next_action_date);
  }
  const [updated] = await sql`
    update bids set
      stage = ${to_stage},
      no_bid_reason = ${merged.no_bid_reason}, override_reason = ${merged.override_reason},
      owner_username = ${merged.owner_username}, estimator_username = ${merged.estimator_username},
      bid_due_date = ${merged.bid_due_date}, submitted_date = ${merged.submitted_date},
      expected_decision_date = ${merged.expected_decision_date}, award_date = ${merged.award_date},
      estimated_value = ${merged.estimated_value}, submitted_value = ${merged.submitted_value},
      final_value = ${merged.final_value}, next_action = ${merged.next_action}, next_action_date = ${merged.next_action_date},
      lost_reason = ${merged.lost_reason}, lost_competitor = ${merged.lost_competitor}, lost_feedback = ${merged.lost_feedback},
      hold_reason = ${merged.hold_reason}, hold_review_date = ${merged.hold_review_date},
      handoff_triggered_at = ${to_stage === "complete" ? (bid.handoff_triggered_at || new Date().toISOString()) : bid.handoff_triggered_at},
      handoff_status = ${to_stage === "complete" ? (bid.handoff_status || "pending") : bid.handoff_status},
      updated_at = now()
    where id = ${id}
    returning *`;

  await sql`insert into bid_stage_history (bid_id, from_stage, to_stage, changed_by, note)
    values (${id}, ${bid.stage}, ${to_stage}, ${user.username}, ${body.note || null})`;

  // Awarded/Lost close out any pending follow-up notifications (Playbook §5.2).
  if (to_stage === "complete" || to_stage === "lost") {
    await sql`update notifications set status = 'closed' where bid_id = ${id} and status = 'pending'`;
  }

  return json({ bid: updated });
}

// ---------------------------------------------------------------------------
// Tender emails
// ---------------------------------------------------------------------------

async function handleEmailsList(bidId, sql) {
  const rows = await sql`select * from bid_emails where bid_id = ${bidId} order by sent_at desc`;
  return json({ emails: rows });
}

async function handleEmailCreate(bidId, request, sql, user) {
  const body = await parseBody(request);
  const bidRows = await sql`select * from bids where id = ${bidId}`;
  if (!bidRows.length) return json({ error: "bid_not_found" }, 404);
  if (!body.direction || !["outbound", "inbound"].includes(body.direction)) {
    return json({ error: "direction must be 'outbound' or 'inbound'" }, 400);
  }
  const [email] = await sql`
    insert into bid_emails (bid_id, company_id, direction, subject, from_address, to_addresses, cc_addresses, body, sent_at, logged_by, source)
    values (${bidId}, ${bidRows[0].company_id}, ${body.direction}, ${body.subject || null}, ${body.from_address || null}, ${body.to_addresses || null}, ${body.cc_addresses || null}, ${body.body || null}, ${body.sent_at || new Date().toISOString()}, ${user.username}, ${body.source || "manual"})
    returning *`;

  // A follow-up just happened — reset the cadence clock rather than waiting
  // for it to lapse again on its own. Inbound (a client wrote back) counts too.
  const settings = await getCrmSettings(sql);
  await sql`update bids set next_action_date = ${autoFollowUpDate(settings.cadence, bidRows[0].stage, null, { force: true })}, updated_at = now() where id = ${bidId}`;

  return json({ email }, 201);
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

async function handleNotificationsList(url, sql) {
  const status = url.searchParams.get("status") || "pending";
  const rows = await sql`
    select n.*, b.project_name, b.rfq_ref, b.owner_username, c.name as company_name
    from notifications n
    left join bids b on b.id = n.bid_id
    left join companies c on c.id = coalesce(n.company_id, b.company_id)
    where n.status = ${status}
    order by n.created_at desc limit 200`;
  return json({ notifications: rows });
}

async function handleNotificationAck(id, sql, user) {
  const [notification] = await sql`
    update notifications set status = 'acknowledged', acknowledged_at = now(), acknowledged_by = ${user.username}
    where id = ${id}
    returning *`;
  if (!notification) return json({ error: "not_found" }, 404);
  return json({ notification });
}

// ---------------------------------------------------------------------------
// Follow-ups — open bids due (or overdue) for a human touch, per
// FOLLOWUP_CADENCE_DAYS above. Deliberately just a filtered/sorted view over
// `bids`, not a separate table: `next_action_date` is already the single
// source of truth the stale-followup notification also reads.
// ---------------------------------------------------------------------------

async function handleFollowupsList(url, sql, user) {
  const mine = url.searchParams.get("mine") === "1";
  const rows = await sql`
    select b.*, c.name as company_name, c.hot_lead as company_hot_lead, ct.email as contact_email,
      ct.first_name as contact_first_name, ct.last_name as contact_last_name
    from bids b left join companies c on c.id = b.company_id left join contacts ct on ct.id = b.contact_id
    where b.stage not in ('complete', 'lost', 'no_bid')
      and (b.next_action_date is null or b.next_action_date <= current_date)
      and (${mine} = false or b.owner_username = ${user.username} or b.estimator_username = ${user.username})
    order by (b.next_action_date is null) desc, b.next_action_date asc
    limit 500`;
  return json({ bids: rows });
}

// ---------------------------------------------------------------------------
// Procore sync — pushed FROM handoff-worker's own Bid Board scan (see its
// bids.js), not polled by CRM itself. Keeping the whole suite's Procore
// traffic behind that one already-proven crawler (its own client_credentials
// app, its own rate-limit pacing) avoids standing up a second independent
// scanner that could trip the same "too many concurrent Procore calls"
// lockout from 2026-09 — see kickoff prompt "Procore rate limiting".
// ---------------------------------------------------------------------------

function isSyncCaller(request, env) {
  const key = request.headers.get("X-Crm-Sync-Key");
  return Boolean(key) && Boolean(env.CRM_SYNC_KEY) && key === env.CRM_SYNC_KEY;
}

async function handleProcoreSync(request, sql) {
  const body = await parseBody(request);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return json({ received: 0, attached: 0, updated: 0 });

  const settings = await getCrmSettings(sql);
  const known = await sql`select * from bids where procore_bid_board_id is not null`;
  const byBoardId = new Map(known.map((b) => [b.procore_bid_board_id, b]));

  // Fallback attach target for a bid that reached the Procore board without
  // its id ever making it back to CRM (pre-fix SCOUT pushes, mainly) — exact
  // case-insensitive company+project name match, same MVP rule as
  // findOrCreateCompany. Archived records are excluded (a name collision with
  // a long-dead archived bid is more likely to be wrong than useful).
  const unattached = await sql`
    select b.*, c.name as company_name from bids b left join companies c on c.id = b.company_id
    where b.procore_bid_board_id is null and b.stage = 'rfq'`;

  let attached = 0, updated = 0;
  for (const row of rows) {
    const boardId = String(row.id);
    let bid = byBoardId.get(boardId);

    if (!bid && !row.archived && row.name && row.customer_name) {
      const idx = unattached.findIndex(
        (u) =>
          (u.project_name || "").trim().toLowerCase() === row.name.trim().toLowerCase() &&
          (u.company_name || "").trim().toLowerCase() === row.customer_name.trim().toLowerCase()
      );
      if (idx !== -1) {
        [bid] = await sql`update bids set procore_bid_board_id = ${boardId}, updated_at = now() where id = ${unattached[idx].id} returning *`;
        unattached.splice(idx, 1);
        attached++;
      }
    }
    if (!bid) continue;

    const newStage = String(row.status || "").toLowerCase();
    const stageKnown = STAGES.includes(newStage);
    const stageChanged = stageKnown && newStage !== bid.stage;
    const archivedChanged = Boolean(row.archived) !== bid.source_archived;
    if (!stageChanged && row.status === bid.source_status && !archivedChanged) continue;

    const [after] = await sql`
      update bids set
        stage = ${stageKnown ? newStage : bid.stage},
        source_status = ${row.status || null},
        source_archived = ${Boolean(row.archived)},
        next_action_date = ${stageChanged ? autoFollowUpDate(settings.cadence, newStage, bid.next_action_date) : bid.next_action_date},
        handoff_triggered_at = ${stageChanged && newStage === "complete" ? bid.handoff_triggered_at || new Date().toISOString() : bid.handoff_triggered_at},
        handoff_status = ${stageChanged && newStage === "complete" ? bid.handoff_status || "pending" : bid.handoff_status},
        updated_at = now()
      where id = ${bid.id}
      returning *`;
    updated++;
    if (!stageChanged) continue;

    await sql`insert into bid_stage_history (bid_id, from_stage, to_stage, changed_by, note)
      values (${bid.id}, ${bid.stage}, ${newStage}, 'procore_sync', 'Detected via Procore Bid Board sync')`;

    if (newStage === "complete" || newStage === "lost") {
      await sql`update notifications set status = 'closed' where bid_id = ${bid.id} and status = 'pending' and type != 'sync_needs_detail'`;
      // A manual move through /bids/:id/stage would be BLOCKED without these
      // fields (validateStageTransition); the sync can't block Procore's own
      // board, so it flags the gap instead.
      const validation = validateStageTransition(bid, newStage, {});
      if (!validation.ok) {
        await sql`insert into notifications (bid_id, type, message)
          values (${bid.id}, 'sync_needs_detail', ${`Procore marked "${after.project_name}" as ${PROCORE_STAGE_LABELS[newStage] || newStage} — still need: ${validation.missing.join(", ")}.`})`;
      }
    }
  }
  return json({ received: rows.length, attached, updated });
}

// ---------------------------------------------------------------------------
// Settings — read by any logged-in user (the CRM web app needs the
// assignable-users list for its own owner/estimator picker, and everyone's
// follow-up dates depend on the cadence); written only by an admin, from
// HELM's "CRM Options" tab (helm-app, not this repo — it just calls this
// Worker directly with the logged-in user's own Einbau ID token).
// ---------------------------------------------------------------------------

// What the signed-in user can do in CRM, plus (live mode) who they can assign
// follow-ups to. The web app builds its pickers and hides what a person can't
// use from this — cosmetic only; every action above is enforced server-side.
// Legacy mode (CRM not switched yet) reports everything allowed and no people
// list, so the UI falls back to the HELM assignable-users list exactly as before.
async function handleAccess(env, user) {
  const c = crmOf(user);
  const can = {
    move_stages: canMoveStages(user),
    hot_lead: canSetHotLead(user),
    assign: canAssignFollowups(user),
    admin: isCrmAdmin(user),
    segment: canChangeSegment(user),
    blacklist: canManageBlacklist(user),
    handoff_status: canSetHandoffStatus(user),
  };
  if (c.mode !== "live") return json({ mode: c.mode, level: c.level, can, people: null });
  try {
    const people = (await eligibleAssignees(env, user)).map((p) => ({ username: p.username, displayName: p.displayName, level: p.level }));
    return json({ mode: c.mode, level: c.level, can, people });
  } catch (e) {
    return json({ mode: c.mode, level: c.level, can, people: [], people_error: e.message });
  }
}

async function handleSettingsGet(sql) {
  return json(await getCrmSettings(sql));
}

async function handleSettingsPatch(request, sql, user) {
  if (!isCrmAdmin(user)) return forbidden("Admin access required.");
  const body = await parseBody(request);
  const current = await getCrmSettings(sql);
  const cadence = body.followup_cadence_days !== undefined ? body.followup_cadence_days : current.cadence;
  const assignable = body.assignable_usernames !== undefined ? body.assignable_usernames : current.assignableUsernames;
  await sql`
    update crm_settings set
      followup_cadence_days = ${JSON.stringify(cadence)}::jsonb,
      assignable_usernames = ${JSON.stringify(assignable)}::jsonb,
      updated_at = now(), updated_by = ${user.username}
    where singleton = 1`;
  return json(await getCrmSettings(sql));
}

// ---------------------------------------------------------------------------
// Admin — a manual, one-off migration runner (same "temporary /admin/* probe
// route" pattern HANDOFF used for its own Procore probe). Not wired into any
// UI; Ben/Claude calls it directly with X-Crm-Admin-Key after adding a new
// migrations/NNN_*.sql file, so a migration can land without ever needing the
// raw Neon connection string outside this Worker's own secret.
// ---------------------------------------------------------------------------

function isAdminCaller(request, env) {
  const key = request.headers.get("X-Crm-Admin-Key");
  return Boolean(key) && Boolean(env.CRM_ADMIN_KEY) && key === env.CRM_ADMIN_KEY;
}

// One-off: give every currently-open bid a real next_action_date instead of
// null (Ben, 2026-09: "real date created... informing the stage change
// logic, not placeholder dates"). Anchored on the bid's actual created_at —
// not today — so a bid that's sat untouched since early 2025 shows up
// genuinely, deeply overdue rather than looking freshly due. `offset`/`limit`
// let a huge backlog be run in a few calls if one invocation can't finish in
// time; safe to re-run (only ever touches rows still null).
async function handleAdminBackfillFollowupDates(sql, { offset = 0, limit = 2000 } = {}) {
  const settings = await getCrmSettings(sql);
  const rows = await sql`
    select id, stage, created_at from bids
    where stage not in ('complete', 'lost', 'no_bid') and next_action_date is null
    order by id
    offset ${offset} limit ${limit}`;
  let updated = 0;
  for (const b of rows) {
    const cadence = settings.cadence[b.stage];
    if (!cadence) continue;
    const anchor = new Date(b.created_at);
    anchor.setUTCDate(anchor.getUTCDate() + cadence);
    await sql`update bids set next_action_date = ${anchor.toISOString().slice(0, 10)} where id = ${b.id}`;
    updated++;
  }
  return json({ scanned: rows.length, updated, offset, nextOffset: offset + rows.length });
}

async function handleAdminMigrate(sql) {
  const statements = [
    `alter table bids add column if not exists source_archived boolean not null default false`,
    `alter table notifications drop constraint if exists notifications_type_check`,
    `alter table notifications add constraint notifications_type_check
       check (type in ('stale_followup', 'no_owner', 'missing_next_action', 'past_decision_date', 'hot_lead_expiring', 'sync_needs_detail'))`,
    `alter table bid_emails drop constraint if exists bid_emails_source_check`,
    `alter table bid_emails add constraint bid_emails_source_check
       check (source in ('manual', 'inbound_forward', 'auto'))`,
    `create table if not exists crm_settings (
       singleton int primary key default 1 check (singleton = 1),
       followup_cadence_days jsonb not null default '{}'::jsonb,
       assignable_usernames jsonb not null default '[]'::jsonb,
       updated_at timestamptz not null default now(),
       updated_by text
     )`,
    `insert into crm_settings (singleton) values (1) on conflict (singleton) do nothing`,
  ];
  const ran = [];
  for (const stmt of statements) {
    await sql.query(stmt);
    ran.push(stmt.split("\n")[0].trim());
  }
  return json({ ran });
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

// 'all' | 'year' | 'quarter' | 'month' -> a real cutoff Date, computed
// server-side so the client just sends a keyword, not a date it has to get
// right. Filters on `created_at`, which for backfilled bids is the bid's
// real historical Procore creation date, not the date it was imported.
function rangeCutoffDate(range) {
  const now = new Date();
  if (range === "week") {
    // Calendar week starting Monday, matching the other ranges' "start of
    // the current calendar period" meaning rather than a rolling 7 days.
    const day = now.getDay(); // 0 = Sunday
    const diffToMonday = day === 0 ? 6 : day - 1;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday);
    return monday;
  }
  if (range === "month") return new Date(now.getFullYear(), now.getMonth(), 1);
  if (range === "quarter") return new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  if (range === "year") return new Date(now.getFullYear(), 0, 1);
  return new Date(0); // 'all' or anything unrecognized
}

// Last Week is the only range with an upper bound — the previous full
// Monday-to-Sunday calendar week (Ben, 2026-10-05). Everything else is
// "from the start of the current period until now", so its end is just a
// far-future date that never excludes anything.
function rangeBounds(range) {
  if (range === "last_week") {
    const thisMonday = rangeCutoffDate("week");
    const lastMonday = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - 7);
    return { start: lastMonday, end: thisMonday };
  }
  // Einbau's fiscal year runs Oct 1 - Sep 30 and is named for the year it
  // ends in (Ben, 2026-10-06: the year that began 2026-10-01 is FY2027).
  // Calendar quarters already line up with fiscal quarters (Q1 = Oct-Dec), so
  // only the year needs its own range.
  if (range === "fy" || range === "last_fy") {
    const now = new Date();
    const fyStartYear = now.getMonth() >= 9 ? now.getFullYear() : now.getFullYear() - 1;
    if (range === "fy") return { start: new Date(fyStartYear, 9, 1), end: new Date("9999-12-31T00:00:00Z") };
    return { start: new Date(fyStartYear - 1, 9, 1), end: new Date(fyStartYear, 9, 1) };
  }
  return { start: rangeCutoffDate(range), end: new Date("9999-12-31T00:00:00Z") };
}

// Whether archived Awarded/Lost bids count in the win-rate figures and the
// customer table. Procore's own board UI hides archived by default, so
// excluding them is what makes CRM's counts match what people see there
// (241 Awarded / ~734 Lost, confirmed 2026-09-29) — but archived is also where
// closed history goes once Estimating drains it each fiscal year (FY2025's
// results are ~78% archived), so for anything that reaches back past the
// current year, excluding it quietly throws the history away. Left at the
// original behaviour pending Ben's call; flipping this one constant (or
// passing includeArchived) switches every figure that uses it.
const INCLUDE_ARCHIVED_IN_WIN_RATES = false;

async function handleDashboardSummary(sql, range, { includeArchived = INCLUDE_ARCHIVED_IN_WIN_RATES } = {}) {
  const bounds = rangeBounds(range);
  const cutoffIso = bounds.start.toISOString();
  const endIso = bounds.end.toISOString();

  const byStage = await sql`select stage, count(*)::int as count, coalesce(sum(estimated_value),0)::float as pipeline_value from bids where created_at >= ${cutoffIso} and created_at < ${endIso} group by stage`;

  const winRateRows = await sql`
    select
      count(*) filter (where stage = 'complete')::int as won,
      count(*) filter (where stage = 'lost')::int as lost,
      coalesce(sum(estimated_value) filter (where stage = 'complete'),0)::float as won_value,
      coalesce(sum(estimated_value) filter (where stage = 'lost'),0)::float as lost_value
    from bids where created_at >= ${cutoffIso} and created_at < ${endIso}`;
  const aging = await sql`
    select count(*)::int as overdue_count
    from bids
    where stage not in ('complete', 'lost', 'no_bid') and created_at >= ${cutoffIso} and created_at < ${endIso}
      and next_action_date is not null and next_action_date < current_date`;
  const hotLeads = await sql`select count(*)::int as hot_lead_count from companies where hot_lead = true`;
  const totals = await sql`select count(*)::int as total_bids, coalesce(avg(estimated_value),0)::float as avg_bid_value, coalesce(sum(estimated_value),0)::float as total_value, count(estimated_value)::int as valued_count from bids where created_at >= ${cutoffIso} and created_at < ${endIso}`;

  // Win rates, average won value and the customer table all run on STATUS
  // CHANGES, not creation dates (Ben, 2026-10-06): a bid counts as won or lost
  // in the period in which it was actually decided. A bid's decision date is
  // its latest transition into its current stage written by a person or the
  // Procore sync bridge (bid_stage_history, changed_by != 'system'). The bulk
  // historical backfill wrote every transition with changed_at = the day it
  // was imported (not a real event), and Procore's export carries no decision
  // date at all — the only date it has is the bid's due date, which the
  // backfill stored as created_at. So for backfilled bids with no real
  // transition, created_at (the bid due date) stands in as the decision date.
  // Still-open bids (Submitted..Delayed) have no decision yet; they are the
  // "pipeline" part of the pipeline win rate, and count when they were created
  // in the period — the same bids the Open pipeline tile counts.
  // Everything in the customer table is activity IN the period: bids created,
  // bids won, bids lost (by decision date). Created counts every bid, like the
  // Total bids tracked tile; won/lost/open follow the archived rule.
  const MIDLATE = ["bid_submitted", "accepted", "in_progress", "to_do", "delayed"];
  const popRows = await sql`
    select b.id, b.company_id, b.stage, b.final_value, b.estimated_value, b.created_at, b.source_archived,
      case when b.stage in ('complete', 'lost') then coalesce(
        (select max(h.changed_at) from bid_stage_history h
          where h.bid_id = b.id and h.to_stage = b.stage and h.changed_by != 'system'),
        b.created_at) end as decided_at
    from bids b`;
  const startMs = bounds.start.getTime();
  const endMs = bounds.end.getTime();
  const inRange = (d) => { const t = new Date(d).getTime(); return t >= startMs && t < endMs; };
  const num = (v) => (v == null ? null : Number(v));
  const blank = () => ({ created_count: 0, created_value: 0, complete_count: 0, lost_count: 0, midlate_count: 0, complete_value: 0, lost_value: 0, midlate_value: 0, complete_valued_count: 0, lost_valued_count: 0 });
  const pcRow = blank();
  const perCompany = new Map();
  for (const r of popRows) {
    const aggs = [pcRow];
    if (r.company_id) aggs.push(perCompany.get(r.company_id) || perCompany.set(r.company_id, blank()).get(r.company_id));
    const add = (kind, value, valued) => {
      for (const agg of aggs) {
        agg[kind + "_count"] += 1;
        agg[kind + "_value"] += value || 0;
        if (valued && value != null) agg[kind + "_valued_count"] += 1;
      }
    };
    if (inRange(r.created_at)) add("created", num(r.estimated_value), false);
    if (r.source_archived && !includeArchived) continue;
    if (r.stage === "complete" && inRange(r.decided_at)) add("complete", num(r.final_value) ?? num(r.estimated_value), true);
    else if (r.stage === "lost" && inRange(r.decided_at)) add("lost", num(r.estimated_value), true);
    else if (MIDLATE.includes(r.stage) && inRange(r.created_at)) add("midlate", num(r.estimated_value), false);
  }

  // Pipeline win rate (Ben, 2026-09-29): Awarded / (Awarded + Lost + every
  // bid that's actually past qualification and still open) — RFQ/Invitation/
  // Estimating are excluded because nothing's been bid yet at that point, and
  // archived is excluded (unless includeArchived) because Procore's own board
  // UI doesn't count it either.
  // $ basis (Ben, 2026-10-05): Awarded uses the confirmed final value where one was
  // entered, else the estimate — most historical wins never had a final_value keyed
  // in, so final_value alone would count nearly all of them as zero. Lost and
  // still-active use the estimate (what was bid).
  const pipelineTotal = pcRow.complete_count + pcRow.lost_count + pcRow.midlate_count;
  const pipelineWinRate = pipelineTotal > 0 ? pcRow.complete_count / pipelineTotal : null;

  // Decided win rate: of bids that have actually been decided (Awarded or
  // Lost), what fraction were wins — in-flight bids don't dilute it.
  const decidedTotal = pcRow.complete_count + pcRow.lost_count;
  const decidedWinRate = decidedTotal > 0 ? pcRow.complete_count / decidedTotal : null;

  // Same two rates by dollar value instead of by number of bids.
  const pipelineValueTotal = pcRow.complete_value + pcRow.lost_value + pcRow.midlate_value;
  const pipelineWinRateValue = pipelineValueTotal > 0 ? pcRow.complete_value / pipelineValueTotal : null;
  const decidedValueTotal = pcRow.complete_value + pcRow.lost_value;
  const decidedWinRateValue = decidedValueTotal > 0 ? pcRow.complete_value / decidedValueTotal : null;

  const wonInRange = [{ count: pcRow.complete_count, value: pcRow.complete_value }];
  const lostInRange = [{ count: pcRow.lost_count, value: pcRow.lost_value }];

  // "Follow-ups completed" = outbound tender emails logged in range — that's
  // literally what the Follow-ups tab's "Follow up ->" action produces
  // (handleEmailCreate), so it's a direct count of real follow-up touches,
  // not a derived/estimated figure. Counts every outbound email logged
  // against a bid, not just ones opened from the Follow-ups tab specifically
  // — the tab and the Pipeline's own compose-and-log box write to the same
  // table, and distinguishing "was this technically overdue" isn't tracked.
  const followupsCompleted = await sql`
    select count(*)::int as count from bid_emails where direction = 'outbound' and sent_at >= ${cutoffIso} and sent_at < ${endIso}`;

  // Per-customer breakdown for the period (Ben, 2026-10-06), on the same
  // status-change basis as the headline figures so the two reconcile exactly:
  // bids submitted (= won + lost + still open past qualification, the pipeline
  // win rate's population), won and lost, each as a count and a dollar value,
  // plus the open part separately so the web app can rate a customer on either
  // the pipeline or the decided basis. Every customer with activity in the
  // period (capped); the client sorts and trims.
  const names = await sql`select id, name from companies`;
  const nameById = new Map(names.map((n) => [n.id, n.name]));
  const byCompany = [...perCompany.entries()]
    .map(([id, a]) => ({
      id,
      name: nameById.get(id) || "(unknown)",
      created_count: a.created_count,
      created_value: a.created_value,
      submitted_count: a.complete_count + a.lost_count + a.midlate_count,
      submitted_value: a.complete_value + a.lost_value + a.midlate_value,
      won_count: a.complete_count,
      won_value: a.complete_value,
      lost_count: a.lost_count,
      lost_value: a.lost_value,
      open_count: a.midlate_count,
      open_value: a.midlate_value,
    }))
    .filter((r) => r.created_count + r.won_count + r.lost_count > 0)
    .sort((x, y) => y.created_count - x.created_count || y.won_count + y.lost_count - (x.won_count + x.lost_count))
    .slice(0, 500);

  // Region rollup — region lives on companies, not bids, hence the join.
  const byRegion = await sql`
    select coalesce(c.region, 'Unspecified') as region,
      count(b.id)::int as bid_count,
      coalesce(sum(b.estimated_value),0)::float as total_value,
      count(*) filter (where b.stage = 'complete')::int as won_count,
      count(*) filter (where b.stage = 'lost')::int as lost_count
    from bids b left join companies c on c.id = b.company_id
    where b.created_at >= ${cutoffIso} and b.created_at < ${endIso}
    group by coalesce(c.region, 'Unspecified')
    order by total_value desc`;

  const won = winRateRows[0]?.won || 0;
  const lost = winRateRows[0]?.lost || 0;
  const winRate = won + lost > 0 ? won / (won + lost) : null;
  const wonValue = winRateRows[0]?.won_value || 0;
  const lostValue = winRateRows[0]?.lost_value || 0;
  const winRateByValue = wonValue + lostValue > 0 ? wonValue / (wonValue + lostValue) : null;

  return json({
    by_stage: byStage,
    win_rate: winRate,
    win_rate_by_value: winRateByValue,
    won,
    lost,
    won_value: wonValue,
    lost_value: lostValue,
    total_bids: totals[0]?.total_bids || 0,
    avg_bid_value: totals[0]?.avg_bid_value || 0,
    total_value: totals[0]?.total_value || 0,
    valued_count: totals[0]?.valued_count || 0,
    overdue_followups: aging[0]?.overdue_count || 0,
    followups_completed: followupsCompleted[0]?.count || 0,
    won_in_range: wonInRange[0] || { count: 0, value: 0 },
    lost_in_range: lostInRange[0] || { count: 0, value: 0 },
    pipeline_win_rate: pipelineWinRate,
    pipeline_win_rate_components: { complete: pcRow.complete_count, lost: pcRow.lost_count, midlate: pcRow.midlate_count, total: pipelineTotal },
    decided_win_rate: decidedWinRate,
    decided_win_rate_components: { complete: pcRow.complete_count, lost: pcRow.lost_count, total: decidedTotal },
    // Average value of a won (and, for comparison, a lost) bid — only over bids
    // that carry a value, so unvalued ones don't drag it toward zero.
    avg_won_value: pcRow.complete_valued_count > 0 ? pcRow.complete_value / pcRow.complete_valued_count : null,
    avg_won_value_count: pcRow.complete_valued_count,
    avg_lost_value: pcRow.lost_valued_count > 0 ? pcRow.lost_value / pcRow.lost_valued_count : null,
    avg_lost_value_count: pcRow.lost_valued_count,
    include_archived: includeArchived,
    period: { key: range || "all", start: cutoffIso, end: bounds.end.getUTCFullYear() >= 9999 ? null : endIso },
    pipeline_win_rate_value: pipelineWinRateValue,
    pipeline_win_rate_value_components: { complete: pcRow.complete_value, lost: pcRow.lost_value, midlate: pcRow.midlate_value, total: pipelineValueTotal },
    decided_win_rate_value: decidedWinRateValue,
    decided_win_rate_value_components: { complete: pcRow.complete_value, lost: pcRow.lost_value, total: decidedValueTotal },
    hot_leads: hotLeads[0]?.hot_lead_count || 0,
    by_company: byCompany,
    by_region: byRegion,
  });
}

// ---------------------------------------------------------------------------
// Scheduled — daily stale/ownerless/actionless bid sweep (Playbook §5.3)
// ---------------------------------------------------------------------------

// Closed stages excluded below, as literal SQL rather than a bound array
// parameter — @neondatabase/serverless's sql`` tag binds every ${} as a plain
// value, and array-typed parameter binding for `= ANY($1)` isn't documented
// as supported. These three are a fixed constant set, not user input, so
// writing them directly into the query text is safe.
async function runStalenessSweep(env) {
  const sql = sqlFor(env);

  const overdue = await sql`
    select id, project_name, next_action_date from bids
    where stage not in ('complete', 'lost', 'no_bid')
      and next_action_date is not null and next_action_date < current_date
      and id not in (select bid_id from notifications where type = 'stale_followup' and status = 'pending')`;
  for (const bid of overdue) {
    await sql`insert into notifications (bid_id, type, message)
      values (${bid.id}, 'stale_followup', ${`Follow-up on "${bid.project_name}" was due ${bid.next_action_date} and hasn't been actioned.`})`;
  }

  const noOwner = await sql`
    select id, project_name from bids
    where stage not in ('complete', 'lost', 'no_bid') and owner_username is null
      and id not in (select bid_id from notifications where type = 'no_owner' and status = 'pending')`;
  for (const bid of noOwner) {
    await sql`insert into notifications (bid_id, type, message)
      values (${bid.id}, 'no_owner', ${`"${bid.project_name}" is open with no assigned owner.`})`;
  }

  // Hot-lead expiry (Ben, 2026-09): a hot-lead flag prompts for renewal at 30
  // days old, then auto-clears at 37 days if nobody renewed it — renewing
  // (PATCH hot_lead:true again) bumps hot_lead_set_at and this cycle restarts.
  // A week of grace between prompt and auto-clear, not configurable yet.
  const expiringSoon = await sql`
    select id, name from companies
    where hot_lead = true and hot_lead_set_at < now() - interval '30 days'
      and id not in (select company_id from notifications where type = 'hot_lead_expiring' and status = 'pending')`;
  for (const company of expiringSoon) {
    await sql`insert into notifications (company_id, type, message)
      values (${company.id}, 'hot_lead_expiring', ${`"${company.name}"'s hot-lead flag is 30+ days old — renew it or let it expire.`})`;
  }

  const autoExpired = await sql`
    update companies set hot_lead = false, hot_lead_reason = coalesce(hot_lead_reason, '') || ' (auto-expired after 37 days unrenewed)'
    where hot_lead = true and hot_lead_set_at < now() - interval '37 days'
    returning id`;

  return { flagged_overdue: overdue.length, flagged_no_owner: noOwner.length, flagged_hot_lead_expiring: expiringSoon.length, auto_expired_hot_leads: autoExpired.length };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

    const url = new URL(request.url);
    const sql = sqlFor(env);
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      // Service-key-only routes (server-to-server, no Einbau ID session in the loop)
      if (url.pathname === "/intake/scout" && request.method === "POST") {
        if (!isServiceCaller(request, env)) return json({ error: "unauthorized" }, 401);
        return await handleScoutIntake(request, sql);
      }
      if (url.pathname === "/companies/lookup" && request.method === "GET") {
        if (!isServiceCaller(request, env)) {
          const auth = await requireLogin(request, env);
          if (!auth.ok) return json({ error: "unauthorized", reason: auth.reason }, 401);
        }
        return await handleCompanyLookup(url, sql);
      }
      if (url.pathname === "/internal/procore-sync" && request.method === "POST") {
        if (!isSyncCaller(request, env)) return json({ error: "unauthorized" }, 401);
        return await handleProcoreSync(request, sql);
      }
      if (url.pathname === "/internal/admin/migrate" && request.method === "POST") {
        if (!isAdminCaller(request, env)) return json({ error: "unauthorized" }, 401);
        return await handleAdminMigrate(sql);
      }
      // One-off: insert real Awarded Procore Bid Board records the original
      // backfill missed (found via /internal/admin/check-board-ids, 2026-09 —
      // Ben spotted a hot-listed company showing zero wins that should have
      // had some). Same shape/conventions as the original backfill: rfq_ref
      // "PROCORE-<board id>", stage 'complete', source_status 'COMPLETE',
      // created_at/award_date from the board record's own due_date (the only
      // date signal Procore's Bid Board API exposes, confirmed against
      // several already-correct backfilled rows before relying on it here).
      if (url.pathname === "/internal/admin/insert-missing-wins" && request.method === "POST") {
        if (!isAdminCaller(request, env)) return json({ error: "unauthorized" }, 401);
        const body = await parseBody(request);
        const rows = Array.isArray(body.rows) ? body.rows : [];
        const inserted = [];
        const skipped = [];
        for (const r of rows) {
          const boardId = String(r.id);
          const existing = await sql`select id from bids where procore_bid_board_id = ${boardId}`;
          if (existing.length) { skipped.push({ id: boardId, reason: "already exists" }); continue; }
          const rfqRef = `PROCORE-${boardId}`;
          const dup = await sql`select id from bids where rfq_ref = ${rfqRef}`;
          if (dup.length) { skipped.push({ id: boardId, reason: "rfq_ref collision" }); continue; }

          let companyId = null;
          if (r.customer_name) {
            const company = await findOrCreateCompany(sql, { name: r.customer_name });
            companyId = company.id;
          }
          const dateOnly = r.due_date ? r.due_date.slice(0, 10) : null;
          const value = r.total && r.total > 0 ? r.total : null;

          const [bid] = await sql`
            insert into bids (
              rfq_ref, project_name, company_id, stage, source_status, source_archived,
              procore_bid_board_id, procore_project_id, final_value, award_date, created_at
            ) values (
              ${rfqRef}, ${r.name}, ${companyId}, 'complete', 'COMPLETE', false,
              ${boardId}, ${r.project_id ? String(r.project_id) : null}, ${value}, ${dateOnly},
              ${r.due_date}
            ) returning id`;
          await sql`insert into bid_stage_history (bid_id, from_stage, to_stage, changed_by, note)
            values (${bid.id}, null, 'complete', 'system', 'Backfilled from Procore Bid Board export (missed in original import, added 2026-09-28)')`;
          inserted.push({ id: boardId, bid_id: bid.id, company_id: companyId });
        }
        return json({ inserted_count: inserted.length, inserted, skipped });
      }
      if (url.pathname === "/internal/admin/check-board-ids" && request.method === "POST") {
        if (!isAdminCaller(request, env)) return json({ error: "unauthorized" }, 401);
        const body = await parseBody(request);
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        const known = await sql`select procore_bid_board_id, stage, project_name from bids where procore_bid_board_id is not null`;
        const byId = new Map(known.map((b) => [b.procore_bid_board_id, b]));
        const missing = [];
        const wrongStage = [];
        let correct = 0;
        for (const id of ids) {
          const hit = byId.get(id);
          if (!hit) missing.push(id);
          else if (hit.stage !== "complete") wrongStage.push({ id, stage: hit.stage, project_name: hit.project_name });
          else correct++;
        }
        return json({ total: ids.length, correct, missing_count: missing.length, missing, wrong_stage_count: wrongStage.length, wrong_stage: wrongStage });
      }
      // One-off: migration 005 renamed the STAGE enum (closed_won/closed_lost
      // -> complete/lost) but never touched the historical bid_stage_history
      // rows already written under the old names — found 2026-09-29 when
      // "won this range" (which reads to_stage) matched almost nothing for
      // 'all' time despite 390 cohort wins existing. Bids' own `stage`
      // column was never affected (it's a live check-constraint column, the
      // rename touched it directly); this is purely the audit-log text.
      if (url.pathname === "/internal/admin/fix-stage-history-labels" && request.method === "POST") {
        if (!isAdminCaller(request, env)) return json({ error: "unauthorized" }, 401);
        const won = await sql`update bid_stage_history set to_stage = 'complete' where to_stage = 'closed_won' returning id`;
        const lost = await sql`update bid_stage_history set to_stage = 'lost' where to_stage = 'closed_lost' returning id`;
        const wonFrom = await sql`update bid_stage_history set from_stage = 'complete' where from_stage = 'closed_won' returning id`;
        const lostFrom = await sql`update bid_stage_history set from_stage = 'lost' where from_stage = 'closed_lost' returning id`;
        return json({ to_stage_won_fixed: won.length, to_stage_lost_fixed: lost.length, from_stage_won_fixed: wonFrom.length, from_stage_lost_fixed: lostFrom.length });
      }
      // One-off: bulk-delete bids Ben confirmed as orphaned (2026-09-29) — no
      // longer present on Procore's Bid Board at all (active or archived, per
      // a full scan) and never tied to a real Procore project
      // (procore_project_id null). Per Ben: "just bids not tied to a project"
      // is the operative rule — a bid IS allowed to gain a project_id after
      // being awarded (that's the normal handoff flow), so this never
      // touches a bid that has one. Returns what it deleted so nothing is
      // silently lost without a record of exactly what and why.
      // One-off: bids Procore has archived (drained into its annual archive
      // folder) that never got a real outcome recorded here — the "Needs
      // Cleanup" bucket. Ben, 2026-09-29: delete these rather than keep
      // tracking them as a to-do list; same safety checks as the orphan
      // delete above (refuses anything with a project or a logged email).
      if (url.pathname === "/internal/admin/delete-archived-unresolved" && request.method === "POST") {
        if (!isAdminCaller(request, env)) return json({ error: "unauthorized" }, 401);
        const candidates = await sql`
          select id, rfq_ref, project_name, stage, procore_project_id,
            (select count(*) from bid_emails e where e.bid_id = bids.id)::int as email_count
          from bids where source_archived = true and stage not in ('complete', 'lost', 'no_bid')`;
        const deleted = [];
        const blocked = [];
        for (const r of candidates) {
          if (r.procore_project_id || r.email_count > 0) { blocked.push(r); continue; }
          await sql`delete from bids where id = ${r.id}`;
          deleted.push({ id: r.id, rfq_ref: r.rfq_ref, project_name: r.project_name, stage: r.stage });
        }
        return json({ deleted_count: deleted.length, deleted, blocked_count: blocked.length, blocked });
      }
      if (url.pathname === "/internal/admin/delete-orphaned-bids" && request.method === "POST") {
        if (!isAdminCaller(request, env)) return json({ error: "unauthorized" }, 401);
        const body = await parseBody(request);
        // Not `= any($1)` — @neondatabase/serverless's sql`` tag doesn't bind
        // raw arrays for that (see handleBidsList's comment on the same
        // limitation); validated one-at-a-time instead, same as everywhere
        // else in this file that needs a bounded id list.
        const ids = (Array.isArray(body.ids) ? body.ids : []).filter(isUuid);
        // force_email: Ben confirmed by name (Chagall "Procore Hosting",
        // 2026-09-29) that a logged email shouldn't block deleting an
        // otherwise-orphaned bid in this specific case — still never
        // bypasses the procore_project_id check, that one stays a hard stop.
        const forceEmail = Boolean(body.force_email);
        const deleted = [];
        const blocked = [];
        for (const id of ids) {
          const [r] = await sql`select id, rfq_ref, project_name, stage, procore_project_id,
              (select count(*) from bid_emails e where e.bid_id = bids.id)::int as email_count
            from bids where id = ${id}`;
          if (!r) continue;
          if (r.procore_project_id || (r.email_count > 0 && !forceEmail)) { blocked.push(r); continue; }
          await sql`delete from bids where id = ${id}`;
          deleted.push({ id: r.id, rfq_ref: r.rfq_ref, project_name: r.project_name, stage: r.stage });
        }
        return json({ deleted_count: deleted.length, deleted, blocked_count: blocked.length, blocked });
      }
      if (url.pathname === "/internal/admin/sync-progress" && request.method === "GET") {
        if (!isAdminCaller(request, env)) return json({ error: "unauthorized" }, 401);
        // source_status gets overwritten to Procore's raw uppercase value
        // (e.g. "IN_PROGRESS") the first time the sync bridge touches a bid;
        // anything still holding the old human-label format (e.g. "Active
        // (60-90+ days)") from the original backfill hasn't been reached by
        // a full pass yet — a rough progress proxy given there's no
        // dedicated tracking table on CRM's side for this.
        const total = await sql`select count(*)::int as count from bids where procore_bid_board_id is not null`;
        const touched = await sql`select count(*)::int as count from bids where procore_bid_board_id is not null and source_status = upper(source_status)`;
        const recentSync = await sql`select count(*)::int as count from bid_stage_history where changed_by = 'procore_sync' and changed_at > now() - interval '24 hours'`;
        const lastSync = await sql`select max(changed_at) as at from bid_stage_history where changed_by = 'procore_sync'`;
        return json({ total: total[0].count, touched_by_sync: touched[0].count, stage_changes_last_24h: recentSync[0].count, last_sync_stage_change: lastSync[0].at });
      }
      if (url.pathname === "/internal/admin/all-board-ids" && request.method === "GET") {
        if (!isAdminCaller(request, env)) return json({ error: "unauthorized" }, 401);
        const rows = await sql`select id, rfq_ref, project_name, stage, procore_bid_board_id, procore_project_id, source_archived, created_at, final_value, company_id from bids where procore_bid_board_id is not null`;
        return json({ bids: rows });
      }
      if (url.pathname === "/internal/admin/dashboard-check" && request.method === "GET") {
        if (!isAdminCaller(request, env)) return json({ error: "unauthorized" }, 401);
        return await handleDashboardSummary(sql, url.searchParams.get("range") || "all", { includeArchived: url.searchParams.get("archived") === "include" });
      }
      if (url.pathname === "/internal/admin/email-check" && request.method === "GET") {
        if (!isAdminCaller(request, env)) return json({ error: "unauthorized" }, 401);
        const multi = await sql`
          select bid_id, count(*)::int as email_count from bid_emails group by bid_id having count(*) > 1 order by count(*) desc limit 10`;
        const out = [];
        for (const m of multi) {
          const emails = await sql`select id, direction, subject, sent_at, source, created_at from bid_emails where bid_id = ${m.bid_id} order by sent_at desc`;
          const [bid] = await sql`select project_name from bids where id = ${m.bid_id}`;
          out.push({ bid_id: m.bid_id, project_name: bid?.project_name, email_count: m.email_count, emails });
        }
        return json({ results: out });
      }
      if (url.pathname === "/internal/admin/company-check" && request.method === "GET") {
        if (!isAdminCaller(request, env)) return json({ error: "unauthorized" }, 401);
        const name = url.searchParams.get("name");
        const companies = name
          ? await sql`select * from companies where lower(name) like ${"%" + name.toLowerCase() + "%"}`
          : await sql`select * from companies where hot_lead = true order by hot_lead_set_at desc nulls last limit 5`;
        const out = [];
        for (const c of companies) {
          const bids = await sql`select id, rfq_ref, project_name, stage, source_status, procore_bid_board_id, procore_project_id, created_at, final_value from bids where company_id = ${c.id} order by created_at desc`;
          out.push({ company: c, bids });
        }
        return json({ results: out });
      }
      if (url.pathname === "/internal/admin/backfill-stats" && request.method === "GET") {
        if (!isAdminCaller(request, env)) return json({ error: "unauthorized" }, 401);
        const all = await sql`select min(created_at) as min_created, max(created_at) as max_created, count(*)::int as total from bids`;
        const backfilled = await sql`select min(created_at) as min_created, max(created_at) as max_created, count(*)::int as total from bids where rfq_ref like 'PROCORE-%'`;
        const nonBackfilled = await sql`select min(created_at) as min_created, max(created_at) as max_created, count(*)::int as total from bids where rfq_ref not like 'PROCORE-%'`;
        return json({ all: all[0], backfilled: backfilled[0], non_backfilled: nonBackfilled[0] });
      }
      if (url.pathname === "/internal/admin/backfill-followup-dates" && request.method === "POST") {
        if (!isAdminCaller(request, env)) return json({ error: "unauthorized" }, 401);
        const body = await parseBody(request);
        return await handleAdminBackfillFollowupDates(sql, { offset: body.offset || 0, limit: body.limit || 2000 });
      }

      // Everything else needs a real Einbau ID session
      const auth = await requireLogin(request, env);
      if (!auth.ok) return json({ error: "unauthorized", reason: auth.reason }, 401);

      const refresh = auth.refreshedToken ? { "X-Refreshed-Token": auth.refreshedToken } : {};
      const withRefresh = (res) => {
        for (const [k, v] of Object.entries(refresh)) res.headers.set(k, v);
        return res;
      };

      if (url.pathname === "/rfq-ids/mint" && request.method === "POST") return withRefresh(await handleMintRfqRef(sql, auth.user));

      if (parts[0] === "companies") {
        if (parts.length === 1 && request.method === "GET") return withRefresh(await handleCompaniesList(url, sql));
        if (parts.length === 1 && request.method === "POST") return withRefresh(await handleCompanyCreate(request, sql));
        if (isUuid(parts[1]) && !parts[2] && request.method === "GET") return withRefresh(await handleCompanyDetail(parts[1], sql));
        if (isUuid(parts[1]) && !parts[2] && request.method === "PATCH") return withRefresh(await handleCompanyPatch(parts[1], request, sql, env, auth.user));
        if (isUuid(parts[1]) && parts[2] === "contacts" && request.method === "POST") return withRefresh(await handleContactCreate(parts[1], request, sql));
      }

      if (parts[0] === "contacts" && isUuid(parts[1]) && !parts[2] && request.method === "PATCH") {
        return withRefresh(await handleContactPatch(parts[1], request, sql));
      }

      if (parts[0] === "bids") {
        if (parts.length === 1 && request.method === "GET") return withRefresh(await handleBidsList(url, sql));
        if (isUuid(parts[1]) && !parts[2] && request.method === "GET") return withRefresh(await handleBidDetail(parts[1], sql));
        if (isUuid(parts[1]) && !parts[2] && request.method === "PATCH") return withRefresh(await handleBidPatch(parts[1], request, sql, env, auth.user));
        if (isUuid(parts[1]) && parts[2] === "stage" && request.method === "POST") return withRefresh(await handleBidStageChange(parts[1], request, sql, env, auth.user));
        if (isUuid(parts[1]) && parts[2] === "emails" && request.method === "GET") return withRefresh(await handleEmailsList(parts[1], sql));
        if (isUuid(parts[1]) && parts[2] === "emails" && request.method === "POST") return withRefresh(await handleEmailCreate(parts[1], request, sql, auth.user));
      }

      if (parts[0] === "notifications") {
        if (parts.length === 1 && request.method === "GET") return withRefresh(await handleNotificationsList(url, sql));
        if (isUuid(parts[1]) && parts[2] === "ack" && request.method === "POST") return withRefresh(await handleNotificationAck(parts[1], sql, auth.user));
      }

      if (url.pathname === "/followups" && request.method === "GET") return withRefresh(await handleFollowupsList(url, sql, auth.user));

      if (url.pathname === "/access" && request.method === "GET") return withRefresh(await handleAccess(env, auth.user));
      if (url.pathname === "/settings" && request.method === "GET") return withRefresh(await handleSettingsGet(sql));
      if (url.pathname === "/settings" && request.method === "PATCH") return withRefresh(await handleSettingsPatch(request, sql, auth.user));

      if (url.pathname === "/dashboard/summary" && request.method === "GET") return withRefresh(await handleDashboardSummary(sql, url.searchParams.get("range")));

      return withRefresh(json({ error: "not_found" }, 404));
    } catch (e) {
      return json({ error: "internal_error", detail: e.message }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runStalenessSweep(env));
  },
};
