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
  if (!token) {
    noteRefusal(request, "no_token", null, "no Authorization header");
    return { ok: false, reason: "No session token was sent with the request." };
  }
  try {
    // Service binding, not a public fetch — a Worker calling another Worker's
    // *.workers.dev URL directly is blocked with Cloudflare error 1042.
    const res = await env.AUTH_WORKER.fetch("https://auth.ben-a90.workers.dev/auth/verify", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Einbau-App": "CRM", ...clientHeaders(request) },
      body: "{}",
    });
    if (!res.ok) {
      noteRefusal(request, res.status === 401 ? "bad_session" : "other", null, `auth-worker verify HTTP ${res.status}`);
      const bodyText = await res.text().catch(() => "(no body)");
      return { ok: false, reason: `auth-worker rejected the verify call (HTTP ${res.status}): ${bodyText.slice(0, 200)}` };
    }
    const data = await res.json();
    if (!data.valid) {
      noteRefusal(request, "bad_session", null, "session invalid, expired or revoked");
      return { ok: false, reason: "Session is invalid or expired — please log in again." };
    }
    if (!data.user) return { ok: false, reason: "auth-worker returned no user for this session." };

    // Per-app access list from HELM (auth-worker/README.md, "The user object,
    // and the apps field") — auth-worker now always returns `apps` as an
    // array (never undefined) and fails closed: no apps granted means no
    // access, full stop, not "unrestricted." Admin role does NOT bypass this
    // (matches every other suite app's post-2026-09-28 gate).
    if (!Array.isArray(data.user.apps) || !data.user.apps.includes("CRM")) {
      noteRefusal(request, "forbidden", data.user.username, "CRM not in the user's apps list");
      return { ok: false, reason: `"${data.user.username}" doesn't have CRM access (HELM apps list).` };
    }

    // Access comes only from Einbau ID's role matrix (appRoles.CRM): a level CRM defines means in;
    // anything else (no_access, a missing entry, an unknown value) means out. Every app is Live, so
    // there is no fallback to the old per-person lists or user.role.
    const crm = resolveCrmAccess(data.user);
    if (crm.mode === "denied") {
      noteRefusal(request, "forbidden", data.user.username, "no CRM level in the role matrix");
      return { ok: false, reason: `"${data.user.username}" has no CRM access in the role matrix (HELM).` };
    }
    noteUser(request, data.user.username);
    // _crm / _token are internal: handlers read the resolved level and the
    // caller's own token (to look people up through auth-worker) from here.
    return { ok: true, user: { ...data.user, _crm: crm, _token: token }, refreshedToken: data.refreshedToken || null };
  } catch (e) {
    noteRefusal(request, "other", null, "couldn't reach auth-worker");
    return { ok: false, reason: `Couldn't reach auth-worker: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Refused-request reporting for HELM's Security tab (auth-worker/README.md,
// "Apps reporting refused requests"). requireLogin notes why a login failed;
// the fetch wrapper at the bottom turns any 401/403 into one event, sent
// fire-and-forget so it never delays or fails the response. Nothing secret
// goes in: no tokens, keys, bodies or query strings.
// The visitor's details for auth-worker's own failed-verify rows: a service-binding call carries no
// CF-Connecting-IP, so forward them (auth-worker trusts these only on binding calls). Only on /auth/verify.
function clientHeaders(request) {
  const cf = request.cf || {};
  const h = {};
  const put = (name, v) => { if (v) h[name] = String(v).slice(0, 200); };
  put("X-Einbau-Client-IP", request.headers.get("CF-Connecting-IP"));
  put("X-Einbau-Client-Country", cf.country);
  put("X-Einbau-Client-City", cf.city);
  put("X-Einbau-Client-Org", cf.asOrganization);
  put("X-Einbau-Client-UA", request.headers.get("User-Agent"));
  return h;
}

const refusalNotes = new WeakMap();
function noteRefusal(request, outcome, username, detail) {
  refusalNotes.set(request, { ...(refusalNotes.get(request) || {}), outcome, username: username || null, detail });
}
function noteUser(request, username) {
  refusalNotes.set(request, { ...(refusalNotes.get(request) || {}), user: username });
}

// One event per ip + outcome + route per minute per isolate; repeats inside the minute are counted
// and ride along on the next event for that key.
const reportSeen = new Map();
function reportRefusal(request, env, ctx, status) {
  try {
    if (!env.AUTH_SERVICE_KEY || !env.AUTH_WORKER) return;
    const note = refusalNotes.get(request) || {};
    // 401 with no note came from a key-only route (wrong or missing X-Crm-* key); 403 is a level/permission refusal.
    const outcome = note.outcome || (status === 429 ? "rate_limited" : status === 403 ? "forbidden" : "bad_service_key");
    const detail = note.detail || (status === 403 ? "refused by CRM permission check" : status === 429 ? "rate limited" : "service key missing or wrong");
    const route = new URL(request.url).pathname;
    const ip = request.headers.get("CF-Connecting-IP") || null;
    const now = Date.now();
    const key = `${ip}|${outcome}|${route}`;
    const seen = reportSeen.get(key);
    if (seen && now - seen.at < 60_000) { seen.suppressed++; return; }
    const count = 1 + (seen ? seen.suppressed : 0);
    reportSeen.set(key, { at: now, suppressed: 0 });
    if (reportSeen.size > 500) for (const [k, v] of reportSeen) if (now - v.at >= 60_000) reportSeen.delete(k);
    const cf = request.cf || {};
    const event = {
      outcome, route, method: request.method,
      username: note.username || note.user || null,
      ip, country: cf.country || null, city: cf.city || null, org: cf.asOrganization || null,
      ua: (request.headers.get("User-Agent") || "").slice(0, 200) || null,
      count, detail,
    };
    ctx.waitUntil((async () => {
      try {
        const rr = await env.AUTH_WORKER.fetch("https://auth.ben-a90.workers.dev/auth/security/report", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Auth-Service-Key": env.AUTH_SERVICE_KEY },
          body: JSON.stringify({ events: [event] }),
        });
        if (!rr.ok) console.log("security report HTTP", rr.status);
      } catch (e) { console.log("security report failed:", e.message); }
    })());
  } catch (e) { console.log("security report failed:", e.message); }
}

// ---------------------------------------------------------------------------
// CRM permissions from the Einbau ID role matrix (2026-10). Levels, per Ben:
//   admin     - everything, including settings
//   estimator - move bids between stages, hot-lead a company, assign follow-ups
//   pm        - can be assigned follow-ups, can't assign them (or do the above)
// Everything privileged is checked here on the server; hiding it in the UI is
// cosmetic only.
// ---------------------------------------------------------------------------

// Levels: admin / estimator / pm, from HELM's role matrix. "Follow-up manager" (Ben, 2026-10-21) is
// NOT a level: it's an extra permission ticked on the person's HELM record (user.appExtras.CRM),
// so an estimator or PM keeps their own level everywhere else and gains the follow-up
// dashboard, bulk assignment and ownership of the assignment rules.
const CRM_LEVELS = ["admin", "estimator", "pm"];
const isEstLevel = (level) => level === "admin" || level === "estimator";
const EXTRA_FOLLOWUP_MANAGER = "followup_manager";
const extrasOf = (user) => (Array.isArray(user && user._extras) ? user._extras : []);
const isFollowupManager = (user) => extrasOf(user).includes(EXTRA_FOLLOWUP_MANAGER);

function resolveCrmAccess(user) {
  const roles = user && user.appRoles && typeof user.appRoles === "object" ? user.appRoles : null;
  const level = roles ? roles.CRM : undefined;
  if (typeof level === "string" && CRM_LEVELS.includes(level)) return { mode: "live", level };
  return { mode: "denied", level: null };
}

function crmOf(user) {
  return (user && user._crm) || { mode: "denied", level: null };
}

function canMoveStages(user) {
  const c = crmOf(user);
  return isEstLevel(c.level);
}
function canSetHotLead(user) {
  const c = crmOf(user);
  return isEstLevel(c.level);
}
function canAssignFollowups(user) {
  const c = crmOf(user);
  return isEstLevel(c.level) || isFollowupManager(user);
}
// Ben, 2026-10-05:
// blacklist designation = admin only; account segment and handoff_status =
// estimator and admin.
const BLACKLIST_SEGMENTS = ["do_not_pursue", "do_not_work_with"];
function canManageBlacklist(user) {
  const c = crmOf(user);
  return c.level === "admin";
}
function canChangeSegment(user) {
  const c = crmOf(user);
  return isEstLevel(c.level);
}
function canSetHandoffStatus(user) {
  const c = crmOf(user);
  return isEstLevel(c.level);
}
function isCrmAdmin(user) {
  const c = crmOf(user);
  return c.level === "admin";
}

// Extra capabilities granted per person inside CRM (admin edits them under the
// Access tab), on top of the Einbau ID level. admin implicitly has all.
//   followup_manager - sees every follow-up, bulk-assigns, runs auto-assign rules
//   campaign_manager - the Campaigns tab (import, dashboard, copilot)
const CRM_CAPS = ["followup_manager", "campaign_manager"];
let grantsCache = { at: 0, grants: {} };
async function loadGrants(sql) {
  if (Date.now() - grantsCache.at < 15_000) return grantsCache.grants;
  const [row] = await sql`select grants from crm_settings where singleton = 1`;
  grantsCache = { at: Date.now(), grants: (row && row.grants) || {} };
  return grantsCache.grants;
}
async function attachCaps(sql, user) {
  const c = crmOf(user);
  // Extras come from the Einbau ID token (HELM sets them per person per app).
  const raw = user && user.appExtras && typeof user.appExtras === "object" ? user.appExtras.CRM : null;
  user._extras = Array.isArray(raw) ? raw.map(String) : [];
  if (c.level === "admin") user._caps = [...CRM_CAPS];
  else {
    user._caps = ((await loadGrants(sql))[user.username] || []).filter((x) => CRM_CAPS.includes(x));
    if (isFollowupManager(user) && !user._caps.includes("followup_manager")) user._caps.push("followup_manager");
  }
}
function hasCap(user, cap) {
  return Array.isArray(user._caps) && user._caps.includes(cap);
}
// "own" scope = a PM: dashboard plus the follow-ups on bids assigned to them,
// nothing else (Ben, 2026-10-07). Everyone else sees every bid.
function canSeeAllBids(user) {
  const c = crmOf(user);
  return isEstLevel(c.level);
}
function ownsBid(user, bid) {
  return Boolean(bid) && (bid.owner_username === user.username || bid.estimator_username === user.username);
}
function bidAccessDenied(user, bid) {
  return canSeeAllBids(user) || ownsBid(user, bid) ? null : forbidden("This bid isn't assigned to you.");
}
function scopeDenied(user) {
  return canSeeAllBids(user) ? null : forbidden("Your role can only see the dashboard and the follow-ups assigned to you.");
}

// The follow-up dashboard exists only for admins, estimators and follow-up managers. The rules
// are read-only for admins and estimators unless they confirm in the UI (a prompt, not a block);
// only a follow-up manager edits them without it.
function canSeeFollowupDashboard(user) {
  const c = crmOf(user);
  return isEstLevel(c.level) || isFollowupManager(user);
}
// Only someone ticked as a follow-up manager edits the rules without the confirmation prompt
// (admins don't, on purpose: the rules belong to the follow-up managers).
function canEditRulesDirectly(user) {
  const c = crmOf(user);
  return isFollowupManager(user);
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
  if (!canAssignFollowups(user)) return forbidden("Only estimators, admins and follow-up managers can assign follow-ups.");
  const eligible = new Set((await eligibleAssignees(env, user)).map((p) => p.username));
  for (const [field, next] of real) {
    if (next && !eligible.has(next)) {
      return json({ error: "not_assignable", detail: `"${next}" can't be assigned follow-ups; they need CRM access at PM level or above.` }, 422);
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
// any per-stage override layered on top. Who can be assigned follow-ups comes
// from the role matrix (PM level or above), not from a list stored here.
async function getCrmSettings(sql) {
  const [row] = await sql`select * from crm_settings where singleton = 1`;
  return {
    cadence: { ...DEFAULT_CADENCE_DAYS, ...(row?.followup_cadence_days || {}) },
    updated_at: row?.updated_at || null,
    updated_by: row?.updated_by || null,
  };
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
  // The same name ignoring case, spacing, punctuation and accents ("Structure
  // Corp." / "Structure Corp", "Hermès" / "Hermes"), or a spelling that was
  // merged into a company earlier. Only when it points at exactly one company.
  const key = nsNorm(name);
  if (key) {
    const [alias] = await sql`select company_id from company_aliases where alias_norm = ${key}`;
    if (alias) { const [c] = await sql`select * from companies where id = ${alias.company_id}`; if (c) return c; }
    const all = await sql`select * from companies`;
    const same = all.filter((c) => nsNorm(c.name) === key);
    if (same.length === 1) return same[0];
  }
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
  // Optional, sent by newer SCOUT builds: why/who for an override, and which
  // disqualifiers fired (a list of short strings). Absent = leave what's stored.
  const overrideReason = body.override_reason ?? null;
  const overrideApprover = body.override_approver ?? null;
  const disqualifiers = Array.isArray(body.disqualifiers) ? JSON.stringify(body.disqualifiers.map((d) => String(d)).slice(0, 50)) : null;
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
        override_reason = ${overrideReason ?? existingBid[0].override_reason},
        override_approver = ${overrideApprover ?? existingBid[0].override_approver},
        disqualifiers = coalesce(${disqualifiers}::jsonb, disqualifiers),
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
        procore_bid_board_id, next_action_date, override_reason, override_approver, disqualifiers
      ) values (
        ${rfq_ref}, ${project_name}, ${company.id}, ${contactRow ? contactRow.id : null}, ${qualification_result || "pending_review"},
        ${scout_score ?? null}, ${scout_tier ?? null}, ${Boolean(hot_lead_applied)}, ${no_bid_reason ?? null}, ${bid_due_date ?? null}, ${initialStage},
        ${procore_bid_board_id ?? null}, ${autoFollowUpDate(settings.cadence, initialStage, null)},
        ${overrideReason}, ${overrideApprover}, coalesce(${disqualifiers}::jsonb, '[]'::jsonb)
      ) returning *`;
    await sql`insert into bid_stage_history (bid_id, from_stage, to_stage, changed_by, note)
      values (${bid.id}, null, ${initialStage}, 'system', 'Created from SCOUT intake')`;
  }

  // A priority client's RFQ that an estimator declines is escalated: it lands in the admin
  // review queue so an admin can follow up with the customer personally.
  if (company.hot_lead && !company.blacklisted && (body.scout_outcome === "declined" || qualification_result === "no_bid") && rfq_ref) {
    const rec0 = body.scout_record && typeof body.scout_record === "object" ? body.scout_record : {};
    const who = (rec0.estimator && String(rec0.estimator).trim()) || rec0.submitted_by || body.submitted_by || null;
    await sql`
      insert into review_queue (kind, company_id, rfq_ref, project_name, reason, actor)
      values ('priority_declined', ${company.id}, ${rfq_ref}, ${project_name}, ${no_bid_reason || null}, ${who || null})
      on conflict (kind, rfq_ref) where rfq_ref is not null do nothing`;
  }

  // SCOUT's complete record for this push, kept as its own permanent row.
  // `scout_record` is the same object SCOUT already sends to Excel/NetSuite;
  // the few fields around it say how the push ended. Absent = an older SCOUT.
  const rec = body.scout_record && typeof body.scout_record === "object" ? body.scout_record : null;
  if (rec) {
    const str = (v) => (v == null || v === "" ? null : String(v));
    const js = (v) => (v == null ? null : JSON.stringify(v));
    const submittedAt = rec.submitted_at && !Number.isNaN(new Date(rec.submitted_at).getTime()) ? new Date(rec.submitted_at).toISOString() : null;
    await sql`
      insert into scout_runs (company_id, bid_id, rfq_ref, source, outcome, submitted_at, client, project_name, tier, total_score, section_scores, scoring, scoring_labels,
        disqualifiers, override_reason, override_approver, estimator, notes, risks, copilot_summary, push_to_bid, ns_opportunity_id, procore_bid_id, thresholds, payload)
      values (${company.id}, ${bid.id}, ${rfq_ref}, 'push', ${str(body.scout_outcome)}, ${submittedAt}, ${str(rec.client)}, ${str(rec.projname)}, ${str(rec.tier)},
        ${rec.total_score == null || Number.isNaN(Number(rec.total_score)) ? null : Number(rec.total_score)}, ${js(rec.section_scores)}::jsonb, ${js(rec.scoring)}::jsonb, ${js(rec.scoring_labels)}::jsonb,
        ${JSON.stringify(Array.isArray(rec.disqualifiers) ? rec.disqualifiers.slice(0, 50) : [])}::jsonb, ${str(body.override_reason ?? rec.override)}, ${str(body.override_approver ?? rec.approver)},
        ${str(rec.estimator)}, ${str(rec.notes)}, ${str(rec.risks)}, ${str(rec.copilot_summary)}, ${typeof rec.push_to_bid === "boolean" ? rec.push_to_bid : null},
        ${str(body.ns_opportunity_id)}, ${str(body.procore_bid_id ?? procore_bid_board_id)}, ${js(body.scout_thresholds)}::jsonb, ${JSON.stringify(rec)}::jsonb)`;
  }

  return json({ company, contact: contactRow, bid }, existingBid.length ? 200 : 201);
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Regions (Ben, 2026-10-07): Procore's project regions (Einbau branches) are the
// one region vocabulary — read live by HANDOFF and copied here, never typed in
// by hand. CRM has no Procore access of its own, so the copy comes from
// HANDOFF's GET /regions over a service binding (HANDOFF_WORKER) with the
// shared HANDOFF_SERVICE_KEY. Refreshed lazily when empty or older than a day and by
// the daily cron; if HANDOFF can't be reached the last good copy keeps serving.
// ---------------------------------------------------------------------------
const REGION_TTL_MS = 24 * 60 * 60 * 1000; // regions almost never change; once a day is plenty

// A failed or empty answer (HANDOFF down, or Procore refusing with a 429 —
// HANDOFF reports that as "no regions") must not turn every page view into
// another Procore call, so back off for 15 minutes after any non-success.
// See PROCORE-RATE-LIMITS.md: 600 requests an hour per client id, shared by all.
let regionRetryAfter = 0;
async function refreshRegions(env, sql) {
  if (!env.HANDOFF_WORKER || !env.HANDOFF_SERVICE_KEY) return { skipped: "HANDOFF_WORKER binding / HANDOFF_SERVICE_KEY secret not set" };
  if (Date.now() < regionRetryAfter) return { skipped: "backing off after a failed refresh" };
  const out = await refreshRegionsNow(env, sql);
  if (out.skipped) regionRetryAfter = Date.now() + 15 * 60 * 1000;
  return out;
}

async function refreshRegionsNow(env, sql) {
  const res = await env.HANDOFF_WORKER.fetch("https://handoff-worker.ben-a90.workers.dev/regions", {
    headers: { "X-Handoff-Service-Key": env.HANDOFF_SERVICE_KEY },
  });
  if (!res.ok) return { skipped: `HANDOFF /regions returned HTTP ${res.status}` };
  const data = await res.json();
  const list = Array.isArray(data.regions) ? data.regions.filter((r) => r && r.id && r.name) : [];
  // An empty answer is HANDOFF's "Procore didn't respond" shape — keep what we have.
  if (!list.length) return { skipped: "HANDOFF returned no regions" };
  for (const r of list) {
    await sql`insert into regions (id, name, active, updated_at) values (${String(r.id)}, ${r.name}, true, now())
      on conflict (id) do update set name = excluded.name, active = true, updated_at = now()`;
  }
  // Regions Procore no longer lists go inactive (kept, so history still resolves).
  const keep = new Set(list.map((r) => String(r.id)));
  for (const r of await sql`select id from regions where active`) {
    if (!keep.has(r.id)) await sql`update regions set active = false where id = ${r.id}`;
  }
  return { refreshed: list.length };
}

async function handleRegionsList(env, sql) {
  let rows = await sql`select id, name, active, updated_at from regions order by name`;
  const newest = rows.reduce((m, r) => Math.max(m, new Date(r.updated_at).getTime()), 0);
  let note = null;
  if (!rows.length || Date.now() - newest > REGION_TTL_MS) {
    try {
      const out = await refreshRegions(env, sql);
      if (out.skipped) note = out.skipped;
      else rows = await sql`select id, name, active, updated_at from regions order by name`;
    } catch (e) { note = e.message; }
  }
  const regions = rows.filter((r) => r.active).map((r) => ({ id: r.id, name: r.name }));
  const names = new Set(regions.map((r) => r.name));
  // Companies still carrying a region that isn't on the list, for clean-up.
  const strays = await sql`select region, count(*)::int as count from companies where region is not null and region != '' group by region order by count desc`;
  return json({
    regions,
    refreshed_at: newest ? new Date(newest).toISOString() : null,
    note,
    unmatched: strays.filter((r) => !names.has(r.region)),
  });
}

// A region may only be set to a name on the list (or cleared). Unchanged
// legacy text is left alone so unrelated edits to a company don't trip on it.
async function regionRejection(sql, next, current) {
  if (next == null || next === "" || next === current) return null;
  const rows = await sql`select name from regions where active`;
  if (!rows.length) return null; // list not connected yet — don't block saves
  if (rows.some((r) => r.name === next)) return null;
  return json({ error: "unknown_region", detail: `"${next}" isn't one of Procore's project regions. Pick one from the list.` }, 422);
}

// Finds a company for SCOUT. Order: the NetSuite customer id (SCOUT knows it for the
// selected client, and the customer import links every company to it), then the
// exact name, then the same name ignoring case/punctuation/accents/spacing, then a
// spelling that was merged away. `matched_by` says which one hit.
async function handleCompanyLookup(url, sql) {
  const name = (url.searchParams.get("name") || "").trim();
  const nsId = (url.searchParams.get("ns_id") || "").trim();
  if (!name && !nsId) return json({ error: "name or ns_id query param is required" }, 400);
  let company = null, matchedBy = null;
  if (nsId) {
    const r = await sql`select id, name, account_segment, hot_lead, hot_lead_weight, hot_lead_reason, netsuite_customer_id, priority_permanent, blacklisted, blacklist_reason from companies where netsuite_customer_id = ${nsId} limit 2`;
    if (r.length === 1) { company = r[0]; matchedBy = "netsuite_id"; }
  }
  if (!company && name) {
    const r = await sql`select id, name, account_segment, hot_lead, hot_lead_weight, hot_lead_reason, netsuite_customer_id, priority_permanent, blacklisted, blacklist_reason from companies where lower(name) = lower(${name}) limit 1`;
    if (r.length) { company = r[0]; matchedBy = "name"; }
  }
  if (!company && name) {
    const key = nsNorm(name);
    if (key) {
      const [alias] = await sql`select company_id from company_aliases where alias_norm = ${key}`;
      if (alias) {
        const [c] = await sql`select id, name, account_segment, hot_lead, hot_lead_weight, hot_lead_reason, netsuite_customer_id, priority_permanent, blacklisted, blacklist_reason from companies where id = ${alias.company_id}`;
        if (c) { company = c; matchedBy = "alias"; }
      }
      if (!company) {
        const all = await sql`select id, name, account_segment, hot_lead, hot_lead_weight, hot_lead_reason, netsuite_customer_id, priority_permanent, blacklisted, blacklist_reason from companies`;
        const same = all.filter((c) => nsNorm(c.name) === key);
        if (same.length === 1) { company = same[0]; matchedBy = "normalized_name"; }
      }
    }
  }
  if (!company) return json({ found: false });
  // "priority" is the Priority Client flag (stored as hot_lead). Estimators proceed with the
  // estimate whatever the RFQ scores; a decline is escalated to admins. "blacklisted" is the
  // admin-only blacklist checkbox.
  return json({
    found: true,
    matched_by: matchedBy,
    company: { ...company, priority: Boolean(company.hot_lead), priority_reason: company.hot_lead_reason || null },
    priority: Boolean(company.hot_lead) && !company.blacklisted,
    priority_permanent: Boolean(company.priority_permanent) && !company.blacklisted,
    blacklisted: Boolean(company.blacklisted),
    blacklist_reason: company.blacklist_reason || null,
    win_stats: await companyWinStats(sql, company.id),
  });
}

// All-time decided win rate for one company against the whole book, for SCOUT
// to show next to the client (display only — it doesn't touch SCOUT's score).
// Same population as the dashboard's decided rate: Awarded and Lost bids,
// archived ones only where CRM recorded the decision itself. `band` uses the
// dashboard's rule (within 5 points of overall = "at") and stays null until a
// company has MIN_DECIDED_FOR_BAND decided bids.
const MIN_DECIDED_FOR_BAND = 3;
const AT_AVERAGE_BAND = 0.05;
async function companyWinStats(sql, companyId) {
  // Dollar figures use estimated_value and skip bids without one (Ben, 2026-10-23: a decided bid with
  // no value is a stray test); valued_* say how many bids each average rests on.
  const [mine] = await sql`
    select count(*) filter (where stage = 'complete')::int as won, count(*) filter (where stage = 'lost')::int as lost,
      coalesce(sum(estimated_value) filter (where stage = 'complete' and estimated_value > 0), 0)::float as value_won,
      coalesce(sum(estimated_value) filter (where stage = 'lost' and estimated_value > 0), 0)::float as value_lost,
      count(*) filter (where stage = 'complete' and estimated_value > 0)::int as valued_won,
      count(*) filter (where stage = 'lost' and estimated_value > 0)::int as valued_lost
    from bids where company_id = ${companyId} and stage in ('complete', 'lost') and (source_archived = false or decided_at is not null)`;
  const [all] = await sql`
    select count(*) filter (where stage = 'complete')::int as won, count(*) filter (where stage = 'lost')::int as lost,
      coalesce(sum(estimated_value) filter (where stage = 'complete' and estimated_value > 0), 0)::float as value_won,
      coalesce(sum(estimated_value) filter (where stage = 'lost' and estimated_value > 0), 0)::float as value_lost,
      count(*) filter (where stage = 'complete' and estimated_value > 0)::int as valued_won,
      count(*) filter (where stage = 'lost' and estimated_value > 0)::int as valued_lost
    from bids where stage in ('complete', 'lost') and (source_archived = false or decided_at is not null)`;
  // Undecided: submitted and still open, the same mid/late stages the dashboard's pipeline win rate counts.
  const [myOpen] = await sql`
    select count(*)::int as n, coalesce(sum(estimated_value) filter (where estimated_value > 0), 0)::float as value,
      count(*) filter (where estimated_value > 0)::int as valued
    from bids where company_id = ${companyId} and stage in ('bid_submitted', 'accepted', 'in_progress', 'to_do', 'delayed') and source_archived = false`;
  const [allOpen] = await sql`
    select count(*)::int as n, coalesce(sum(estimated_value) filter (where estimated_value > 0), 0)::float as value,
      count(*) filter (where estimated_value > 0)::int as valued
    from bids where stage in ('bid_submitted', 'accepted', 'in_progress', 'to_do', 'delayed') and source_archived = false`;
  const avg = (sum, n) => (n > 0 ? sum / n : null);
  const pipelineRate = (w, l, o) => (w + l + o > 0 ? w / (w + l + o) : null);
  const decided = mine.won + mine.lost;
  const overall = all.won + all.lost > 0 ? all.won / (all.won + all.lost) : null;
  const rate = decided > 0 ? mine.won / decided : null;
  let band = null;
  if (rate != null && overall != null && decided >= MIN_DECIDED_FOR_BAND) {
    const diff = rate - overall;
    band = diff > AT_AVERAGE_BAND ? "over" : diff < -AT_AVERAGE_BAND ? "under" : "at";
  }
  return {
    won: mine.won, lost: mine.lost, decided_count: decided, win_rate: rate, overall_win_rate: overall, band, min_decided_for_band: MIN_DECIDED_FOR_BAND,
    value_won: mine.value_won, value_lost: mine.value_lost,
    valued_won: mine.valued_won, valued_lost: mine.valued_lost,
    avg_won_value: avg(mine.value_won, mine.valued_won), avg_lost_value: avg(mine.value_lost, mine.valued_lost),
    overall_avg_won_value: avg(all.value_won, all.valued_won), overall_avg_lost_value: avg(all.value_lost, all.valued_lost),
    open_count: myOpen.n, open_value: myOpen.value, valued_open: myOpen.valued, avg_open_value: avg(myOpen.value, myOpen.valued),
    overall_avg_open_value: avg(allOpen.value, allOpen.valued),
    // Pipeline basis (won + lost + open mid/late), as the dashboard's pipeline win rate; the per-client
    // rate is left to the caller (won / (won + lost + open)), overall_* are the all-client rates.
    pipeline: {
      won: mine.won, lost: mine.lost, open_count: myOpen.n,
      won_value: mine.value_won, lost_value: mine.value_lost, open_value: myOpen.value,
      overall_rate: pipelineRate(all.won, all.lost, allOpen.n),
      overall_rate_value: pipelineRate(all.value_won, all.value_lost, allOpen.value),
    },
  };
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
  const badRegion = await regionRejection(sql, body.region, null);
  if (badRegion) return badRegion;
  const [company] = await sql`
    insert into companies (name, account_segment, region, vertical, tier, notes)
    values (${body.name.trim()}, ${body.account_segment || "unreviewed"}, ${body.region || null}, ${body.vertical || null}, ${body.tier || null}, ${body.notes || null})
    returning *`;
  return json({ company }, 201);
}

// ---------------------------------------------------------------------------
// NetSuite -> CRM company sync (Ben, 2026-10-16). CRM companies used to come
// only from bids and never carried a NetSuite id, so any customer that had
// never bid through SCOUT/Procore was simply missing. This reads every active
// NetSuite customer (stage CUSTOMER) through netsuite-worker, plus the Procore
// company ids NetSuite keeps in customrecord_r_it_entity_pc_ids, and plans:
//   link   - an existing CRM company gets its netsuite_customer_id. Matched by
//            Procore company id first, then by the same name ignoring case,
//            spacing and punctuation.
//   create - no match at all: a new company, account segment "customer".
//   review - no exact match but a close name (suffix/parenthetical differences);
//            never auto-linked, an admin decides.
//   ambiguous - two CRM companies fit, or one is already linked elsewhere.
// A run is first stored as a PREVIEW; nothing changes until an admin applies it.
// Existing companies' segment, region, hot-lead flag etc. are never touched.
// ---------------------------------------------------------------------------
// Internal / test records in NetSuite that are not real customers: Einbau Internal, a dummy
// Go-Fast customer, IC-Einbau (intercompany), two Stratus-EB dry-run customers, XXTEST, and the
// ZZTEST Claude E2E company.
const NS_SKIP_IDS = [2907, 12515, 21, 2544, 2547, 16292, 16896];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// SuiteQL through netsuite-worker. NetSuite's hasMore flag is wrong after the
// first 1000 rows, so page by hand until a page comes back short; and it sometimes
// answers "Invalid login attempt" (HTTP 200) before doing anything, so that is
// safe to retry with a growing pause.
async function nsSuiteQL(env, q) {
  if (!env.NETSUITE_WORKER || !env.NETSUITE_SERVICE_KEY) throw new Error("NETSUITE_WORKER binding / NETSUITE_SERVICE_KEY not configured");
  const rows = [];
  for (let offset = 0; offset < 20000; offset += 1000) {
    let page = null;
    for (let attempt = 0; attempt < 5 && !page; attempt++) {
      const res = await env.NETSUITE_WORKER.fetch("https://netsuite.ben-a90.workers.dev/", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-NetSuite-Service-Key": env.NETSUITE_SERVICE_KEY },
        body: JSON.stringify({ method: "POST", path: `/query/v1/suiteql?limit=1000&offset=${offset}`, data: { q } }),
      });
      const text = await res.text();
      if (/Invalid login attempt/i.test(text)) { await sleep(1500 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`netsuite-worker HTTP ${res.status}: ${text.slice(0, 200)}`);
      let j;
      try { j = JSON.parse(text); } catch { throw new Error("netsuite-worker returned something that isn't JSON"); }
      if (!Array.isArray(j.items)) throw new Error(`Unexpected NetSuite answer: ${text.slice(0, 200)}`);
      page = j.items;
    }
    if (!page) throw new Error("NetSuite kept answering 'Invalid login attempt'");
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

const nsNorm = (v) => String(v || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const NS_LOOSE_DROP = new Set(["inc", "incorporated", "ltd", "limited", "corp", "corporation", "co", "company", "llc", "lp", "the"]);
const nsLoose = (v) => nsNorm(String(v || "").replace(/\([^)]*\)/g, " ")).split(" ").filter((w) => w && !NS_LOOSE_DROP.has(w)).join(" ");

// `rows` is the customer list from an uploaded NetSuite CSV, already read by
// the browser: [{ ns_id, companyname, name, entityid, procore_ids: [] }]. Without
// rows it reads NetSuite directly (needs the NETSUITE_SERVICE_KEY secret; not
// used while the CSV route is the way Ben imports).
async function buildNsPlan(env, sql, rows) {
  let customers;
  const pcByCustomer = new Map();
  if (Array.isArray(rows)) {
    const byId = new Map();
    for (const r of rows) {
      const id = String(r.ns_id ?? "").trim();
      if (!id || NS_SKIP_IDS.includes(Number(id))) continue;
      if (!byId.has(id)) byId.set(id, { id, companyname: String(r.companyname || "").trim() || null, name: String(r.name || r.companyname || r.entityid || "").trim(), entityid: r.entityid || null });
      for (const pid of Array.isArray(r.procore_ids) ? r.procore_ids : []) {
        const v = String(pid || "").trim();
        if (!v) continue;
        if (!pcByCustomer.has(id)) pcByCustomer.set(id, new Set());
        pcByCustomer.get(id).add(v);
      }
    }
    customers = [...byId.values()];
  } else {
    customers = await nsSuiteQL(env, `SELECT id, companyname, COALESCE(companyname, entityid) AS name, entityid, TO_CHAR(datecreated,'YYYY-MM-DD') AS created FROM customer WHERE stage = 'CUSTOMER' AND isinactive = 'F' AND id NOT IN (${NS_SKIP_IDS.join(",")}) ORDER BY id`);
    const pcRows = await nsSuiteQL(env, `SELECT custrecord_r_it_entity_record AS customer_id, custrecord_r_it_entity_pc_id AS procore_id FROM customrecord_r_it_entity_pc_ids`);
    for (const r of pcRows) {
      if (r.customer_id == null || r.procore_id == null || String(r.procore_id).trim() === "") continue;
      const k = String(r.customer_id);
      if (!pcByCustomer.has(k)) pcByCustomer.set(k, new Set());
      pcByCustomer.get(k).add(String(r.procore_id).trim());
    }
  }

  // The NetSuite "Procore ID" is only trusted as a Procore COMPANY id when it
  // isn't also a Procore project or bid id that CRM already knows: an earlier
  // export (2026-10-16) held per-project ids, and writing one of those into a
  // company would corrupt it. If any id in the file is a known project/bid id,
  // the plan still matches by name but writes no Procore id, and says so.
  const knownProjects = new Set();
  for (const r of await sql`select procore_project_id as pid from bids where procore_project_id is not null union select procore_bid_board_id from bids where procore_bid_board_id is not null`) knownProjects.add(String(r.pid));
  const allPc = new Set([...pcByCustomer.values()].flatMap((set) => [...set]));
  const suspectProjectIds = [...allPc].filter((x) => knownProjects.has(x)).length;
  const companies = await sql`select id, name, procore_vendor_id, netsuite_customer_id from companies`;
  const push = (m, k, v) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  const byNs = new Map(), byPc = new Map(), byNorm = new Map(), byLoose = new Map();
  for (const c of companies) {
    if (c.netsuite_customer_id) byNs.set(String(c.netsuite_customer_id), c);
    if (c.procore_vendor_id != null) push(byPc, String(c.procore_vendor_id), c);
    push(byNorm, nsNorm(c.name), c);
    push(byLoose, nsLoose(c.name), c);
  }

  const claimed = new Set();
  const ops = [];
  let alreadyLinked = 0;
  for (const c of customers) {
    const id = String(c.id);
    const name = String(c.name || "").trim();
    if (!name) continue;
    if (byNs.has(id)) { alreadyLinked++; continue; }
    const pcs = [...(pcByCustomer.get(id) || [])];
    const base = { ns_id: id, ns_name: name, procore_id: suspectProjectIds === 0 && pcs.length === 1 ? pcs[0] : null };
    const free = (list) => [...new Map((list || []).filter((x) => !x.netsuite_customer_id).map((x) => [x.id, x])).values()];

    let matched = null, reason = null;
    const pcCand = suspectProjectIds === 0 ? free(pcs.flatMap((pid) => byPc.get(pid) || [])) : [];
    if (pcCand.length === 1) { matched = pcCand[0]; reason = "Procore company id"; }
    else if (pcCand.length > 1) {
      ops.push({ ...base, op: "ambiguous", detail: `Procore id fits ${pcCand.length} CRM companies: ${pcCand.map((x) => x.name).join("; ")}` });
      continue;
    }
    if (!matched) {
      const all = byNorm.get(nsNorm(name)) || [];
      const nameCand = free(all);
      if (nameCand.length === 1) { matched = nameCand[0]; reason = "same name"; }
      else if (nameCand.length > 1) {
        ops.push({ ...base, op: "ambiguous", detail: `Same name appears ${nameCand.length} times in CRM: ${nameCand.map((x) => x.name).join("; ")}` });
        continue;
      } else if (all.length) {
        ops.push({ ...base, op: "ambiguous", detail: `CRM company "${all[0].name}" is already linked to NetSuite customer ${all[0].netsuite_customer_id}` });
        continue;
      }
    }
    if (matched) {
      if (claimed.has(matched.id)) { ops.push({ ...base, op: "ambiguous", detail: `"${matched.name}" also matches another NetSuite customer` }); continue; }
      claimed.add(matched.id);
      ops.push({ ...base, op: "link", company_id: matched.id, company_name: matched.name, detail: reason });
      continue;
    }
    const loose = free(byLoose.get(nsLoose(name)));
    if (loose.length) {
      ops.push({ ...base, op: "review", company_id: loose[0].id, company_name: loose[0].name, detail: loose.length > 1 ? `${loose.length} similar CRM companies` : "similar name" });
      continue;
    }
    const individual = !String(c.companyname || "").trim();
    const notes = individual ? "NetSuite individual record (no company name)" : null;
    ops.push({ ...base, op: "create", notes, detail: individual ? "individual" : null });
  }

  const count = (op) => ops.filter((o) => o.op === op).length;
  const summary = {
    netsuite_customers: customers.length,
    already_linked: alreadyLinked,
    link_by_procore_id: ops.filter((o) => o.op === "link" && o.detail === "Procore company id").length,
    procore_ids_that_look_like_projects: suspectProjectIds,
    link_by_name: ops.filter((o) => o.op === "link" && o.detail === "same name").length,
    create: count("create"),
    create_individuals: ops.filter((o) => o.op === "create" && o.detail === "individual").length,
    review: count("review"),
    ambiguous: count("ambiguous"),
    crm_companies: companies.length,
    with_procore_id: pcByCustomer.size,
  };
  return { ops, summary };
}

async function insertNsOps(sql, runId, ops) {
  for (let i = 0; i < ops.length; i += 100) {
    const chunk = ops.slice(i, i + 100);
    const params = [];
    const tuples = chunk.map((o) => {
      const base = params.length;
      params.push(runId, o.op, o.ns_id, o.ns_name, o.company_id || null, o.company_name || null, o.procore_id || null, o.notes || null, o.detail || null);
      return `(${Array.from({ length: 9 }, (_, k) => "$" + (base + k + 1)).join(", ")})`;
    });
    await sql.query(`insert into ns_sync_ops (run_id, op, ns_id, ns_name, company_id, company_name, procore_id, notes, detail) values ${tuples.join(", ")}`, params);
  }
}

async function nsSyncPreview(env, sql, { createdBy, auto = false, rows } = {}) {
  const { ops, summary } = await buildNsPlan(env, sql, rows);
  const [run] = await sql`insert into ns_sync_runs (created_by, auto, summary) values (${createdBy || null}, ${auto}, ${JSON.stringify(summary)}::jsonb) returning id, created_at`;
  await insertNsOps(sql, run.id, ops);
  return { run_id: run.id, summary };
}

// Applies up to `limit` pending link/create ops, each re-checked against the
// live row so a stale preview can't overwrite anything. Idempotent: call until
// remaining is 0.
async function nsSyncApply(sql, runId, limit = 100) {
  const pending = await sql`select * from ns_sync_ops where run_id = ${runId} and status = 'pending' and op in ('link', 'create') order by op, ns_id limit ${limit}`;
  for (const o of pending) await nsApplyOne(sql, o);
  const [{ n }] = await sql`select count(*)::int as n from ns_sync_ops where run_id = ${runId} and status = 'pending' and op in ('link', 'create')`;
  return { applied_now: pending.length, remaining: n };
}

async function nsApplyOne(sql, o) {
  const done = (status, detail) => sql`update ns_sync_ops set status = ${status}, detail = coalesce(${detail}, detail) where id = ${o.id}`;
  if (o.op === "link") {
    const r = await sql`
      update companies set netsuite_customer_id = ${o.ns_id}, procore_vendor_id = coalesce(procore_vendor_id, nullif(${o.procore_id || ""}, '')::bigint), updated_at = now()
      where id = ${o.company_id} and netsuite_customer_id is null returning id`;
    return done(r.length ? "applied" : "skipped", r.length ? null : "company was already linked or removed");
  }
  if (o.op === "create") {
    const exists = await sql`select id from companies where lower(trim(name)) = lower(trim(${o.ns_name})) or netsuite_customer_id = ${o.ns_id} limit 1`;
    if (exists.length) return done("skipped", "a company with this name or NetSuite id already exists");
    await sql`
      insert into companies (name, netsuite_customer_id, procore_vendor_id, account_segment, notes)
      values (${o.ns_name}, ${o.ns_id}, nullif(${o.procore_id || ""}, '')::bigint, 'customer', ${o.notes || null})`;
    return done("applied");
  }
}

async function kvGet(sql, key) {
  const [r] = await sql`select value from crm_kv where key = ${key}`;
  return r ? r.value : null;
}
async function kvSet(sql, key, value) {
  await sql`insert into crm_kv (key, value, updated_at) values (${key}, ${JSON.stringify(value)}::jsonb, now()) on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

// Nightly run, only once an admin has switched it on after the first backfill:
// plans afresh and applies the safe link/create ops; near-name matches and
// ambiguous ones stay on the review list.
async function nsSyncNightly(env, sql) {
  if (!(await kvGet(sql, "ns_sync_auto"))) return;
  const out = await nsSyncPreview(env, sql, { createdBy: "nightly", auto: true });
  for (let i = 0; i < 6; i++) {
    const r = await nsSyncApply(sql, out.run_id, 100);
    if (!r.remaining) break;
  }
}

async function handleNsSyncGet(sql) {
  const [run] = await sql`select * from ns_sync_runs order by created_at desc limit 1`;
  const auto = Boolean(await kvGet(sql, "ns_sync_auto"));
  if (!run) return json({ run: null, auto });
  const counts = await sql`select op, status, count(*)::int as n from ns_sync_ops where run_id = ${run.id} group by op, status`;
  const list = (op, status) => sql`select id, ns_id, ns_name, company_id, company_name, procore_id, detail, status from ns_sync_ops where run_id = ${run.id} and op = ${op} and status = ${status} order by ns_name limit 400`;
  return json({
    run: { id: run.id, created_at: run.created_at, created_by: run.created_by, auto: run.auto, summary: run.summary },
    auto,
    counts,
    create: await list("create", "pending"),
    review: await list("review", "pending"),
    ambiguous: await list("ambiguous", "pending"),
    link: await list("link", "pending"),
  });
}

async function handleNsSyncRoute(request, url, sql, env, user) {
  if (!isCrmAdmin(user)) return forbidden("Admin access required.");
  const path = url.pathname;
  if (path === "/admin/netsuite-sync" && request.method === "GET") return handleNsSyncGet(sql);
  if (path === "/admin/netsuite-sync/preview" && request.method === "POST") {
    const b = await parseBody(request);
    if (Array.isArray(b.rows) && b.rows.length > 20000) return json({ error: "too_many_rows" }, 413);
    try { return json(await nsSyncPreview(env, sql, { createdBy: user.username, rows: Array.isArray(b.rows) ? b.rows : undefined })); }
    catch (e) { return json({ error: "netsuite_unreachable", detail: e.message }, 502); }
  }
  const body = await parseBody(request);
  if (path === "/admin/netsuite-sync/apply" && request.method === "POST") {
    if (!body.run_id) return json({ error: "run_id is required" }, 400);
    return json(await nsSyncApply(sql, body.run_id, 100));
  }
  if (path === "/admin/netsuite-sync/review" && request.method === "POST") {
    const [o] = await sql`select * from ns_sync_ops where id = ${body.op_id} and op = 'review' and status = 'pending'`;
    if (!o) return json({ error: "not_found" }, 404);
    if (body.decision === "skip") { await sql`update ns_sync_ops set status = 'skipped', detail = 'left alone by an admin' where id = ${o.id}`; return json({ ok: true }); }
    if (body.decision === "link") await nsApplyOne(sql, { ...o, op: "link" });
    else if (body.decision === "create") await nsApplyOne(sql, { ...o, op: "create", ns_name: o.ns_name });
    else return json({ error: "decision must be link, create or skip" }, 400);
    return json({ ok: true });
  }
  if (path === "/admin/netsuite-sync/auto" && request.method === "POST") {
    await kvSet(sql, "ns_sync_auto", Boolean(body.enabled));
    return json({ auto: Boolean(body.enabled) });
  }
  return json({ error: "not_found" }, 404);
}

// ---------------------------------------------------------------------------
// Merge two companies (Ben, 2026-10-16): the duplicate's bids, contacts, emails,
// notifications and payment score move to the company that is kept, blank
// fields are filled from the duplicate, the duplicate's name is remembered as an
// alias, and the duplicate is deleted. A blacklist designation on either one
// survives. Refuses when the two are linked to different NetSuite customers.
// ---------------------------------------------------------------------------
async function mergeCounts(sql, mergeId) {
  const [b] = await sql`select count(*)::int as n from bids where company_id = ${mergeId}`;
  const [c] = await sql`select count(*)::int as n from contacts where company_id = ${mergeId}`;
  const [e] = await sql`select count(*)::int as n from bid_emails where company_id = ${mergeId}`;
  return { bids: b.n, contacts: c.n, emails: e.n };
}

async function companyMergePlan(sql, keepId, mergeId) {
  if (!keepId || !mergeId) return { error: json({ error: "keep_id and merge_id are required" }, 400) };
  if (keepId === mergeId) return { error: json({ error: "same_company", detail: "Pick two different companies." }, 400) };
  const [keep] = await sql`select * from companies where id = ${keepId}`;
  const [dupe] = await sql`select * from companies where id = ${mergeId}`;
  if (!keep || !dupe) return { error: json({ error: "not_found" }, 404) };
  if (keep.netsuite_customer_id && dupe.netsuite_customer_id && String(keep.netsuite_customer_id) !== String(dupe.netsuite_customer_id)) {
    return { error: json({ error: "different_netsuite_customers", detail: `These are linked to different NetSuite customers (${keep.netsuite_customer_id} and ${dupe.netsuite_customer_id}), so they are separate companies.` }, 409) };
  }
  return { keep, dupe, counts: await mergeCounts(sql, mergeId) };
}

async function handleCompanyMerge(request, url, sql, user) {
  if (!isCrmAdmin(user)) return forbidden("Admin access required.");
  if (url.pathname === "/admin/companies/merge-preview" && request.method === "GET") {
    const plan = await companyMergePlan(sql, url.searchParams.get("keep"), url.searchParams.get("merge"));
    if (plan.error) return plan.error;
    return json({ keep: { id: plan.keep.id, name: plan.keep.name }, merge: { id: plan.dupe.id, name: plan.dupe.name }, moves: plan.counts });
  }
  if (url.pathname === "/admin/companies/merge" && request.method === "POST") {
    const body = await parseBody(request);
    const plan = await companyMergePlan(sql, body.keep_id, body.merge_id);
    if (plan.error) return plan.error;
    const { keep, dupe, counts } = plan;

    await sql`update bids set company_id = ${keep.id} where company_id = ${dupe.id}`;
    await sql`update contacts set company_id = ${keep.id} where company_id = ${dupe.id}`;
    await sql`update bid_emails set company_id = ${keep.id} where company_id = ${dupe.id}`;
    await sql`update notifications set company_id = ${keep.id} where company_id = ${dupe.id}`;
    // One payment score per company: the survivor's own wins; otherwise take the duplicate's.
    const keepHasScore = (await sql`select 1 from company_payment_scores where company_id = ${keep.id}`).length > 0;
    if (!keepHasScore) await sql`update company_payment_scores set company_id = ${keep.id} where company_id = ${dupe.id}`;

    const blacklisted = [keep.account_segment, dupe.account_segment].find((x) => BLACKLIST_SEGMENTS.includes(x));
    const segment = blacklisted || (keep.account_segment === "unreviewed" ? dupe.account_segment : keep.account_segment);
    const takeHot = !keep.hot_lead && dupe.hot_lead;
    // A blacklist on either company survives the merge (with its reason), and so does "permanent".
    const bl = keep.blacklisted ? keep : dupe.blacklisted ? dupe : null;
    const notes = keep.notes && dupe.notes && keep.notes !== dupe.notes ? `${keep.notes}\n\n(Merged from "${dupe.name}")\n${dupe.notes}` : keep.notes || dupe.notes || null;
    await sql`
      update companies set
        netsuite_customer_id = ${keep.netsuite_customer_id || dupe.netsuite_customer_id || null},
        procore_vendor_id = ${keep.procore_vendor_id ?? dupe.procore_vendor_id ?? null},
        region = ${keep.region || dupe.region || null},
        vertical = ${keep.vertical || dupe.vertical || null},
        tier = ${keep.tier || dupe.tier || null},
        account_segment = ${segment},
        notes = ${notes},
        hot_lead = ${bl ? false : takeHot ? true : keep.hot_lead},
        hot_lead_weight = ${takeHot ? dupe.hot_lead_weight : keep.hot_lead_weight},
        hot_lead_reason = ${takeHot ? dupe.hot_lead_reason : keep.hot_lead_reason},
        hot_lead_set_by = ${takeHot ? dupe.hot_lead_set_by : keep.hot_lead_set_by},
        hot_lead_set_at = ${takeHot ? dupe.hot_lead_set_at : keep.hot_lead_set_at},
        blacklisted = ${Boolean(bl)},
        blacklist_reason = ${bl ? bl.blacklist_reason : null},
        blacklisted_by = ${bl ? bl.blacklisted_by : null},
        blacklisted_at = ${bl ? bl.blacklisted_at : null},
        priority_permanent = ${bl ? false : Boolean(keep.priority_permanent || dupe.priority_permanent)},
        updated_at = now()
      where id = ${keep.id}`;
    const aliasKey = nsNorm(dupe.name);
    if (aliasKey && aliasKey !== nsNorm(keep.name)) {
      await sql`insert into company_aliases (alias_norm, company_id, alias_name) values (${aliasKey}, ${keep.id}, ${dupe.name}) on conflict (alias_norm) do update set company_id = excluded.company_id, alias_name = excluded.alias_name`;
    }
    await sql`insert into company_merges (kept_id, kept_name, merged_id, merged_name, merged_snapshot, moved, merged_by)
      values (${keep.id}, ${keep.name}, ${dupe.id}, ${dupe.name}, ${JSON.stringify(dupe)}::jsonb, ${JSON.stringify(counts)}::jsonb, ${user.username})`;
    await sql`delete from companies where id = ${dupe.id}`;
    return json({ ok: true, kept: { id: keep.id, name: keep.name }, moved: counts });
  }
  return json({ error: "not_found" }, 404);
}

// ---------------------------------------------------------------------------
// Contacts + address import from a NetSuite export (Ben, 2026-10-16). Rows are
// one per contact, carrying the company's NetSuite internal id and address. Each
// company is found by netsuite_customer_id (the customer import must have run),
// its blank address fields and vertical are filled (never overwritten), and its
// contacts are added unless that company already has the same email (or, with
// no email, the same first+last name). Re-running is safe.
// ---------------------------------------------------------------------------
const CONTACT_ADDR_FIELDS = [
  ["address_line1", "address1"], ["address_line2", "address2"], ["city", "city"], ["province", "province"],
  ["postal_code", "postal_code"], ["country", "country"], ["website", "website"],
];
const cleanStr = (v) => { const t = String(v ?? "").trim(); return t === "" || t === "0" ? null : t.slice(0, 500); };

function planContactRows(rows, companiesByNs, existingByCompany) {
  const summary = { rows: rows.length, companies_matched: 0, companies_unmatched: 0, address_updates: 0, contacts_to_add: 0, contacts_already_there: 0, rows_skipped_no_contact: 0 };
  const unmatched = new Map();
  const companyUpdates = new Map(); // company id -> fields
  const newContacts = [];
  const matchedIds = new Set();
  const seenNew = new Set();
  for (const r of rows) {
    const nsId = String(r.ns_id ?? "").trim();
    const company = companiesByNs.get(nsId);
    if (!company) { if (nsId && !unmatched.has(nsId)) unmatched.set(nsId, r.company_name || nsId); continue; }
    matchedIds.add(company.id);

    if (!companyUpdates.has(company.id)) {
      const upd = {};
      for (const [col, key] of CONTACT_ADDR_FIELDS) { const v = cleanStr(r[key]); if (v && !company[col]) upd[col] = v; }
      const cat = cleanStr(r.category);
      if (cat && !company.vertical) upd.vertical = cat;
      companyUpdates.set(company.id, upd);
    }

    let email = cleanStr(r.email);
    const first = cleanStr(r.contact_first), last = cleanStr(r.contact_last);
    let fn = first, ln = last;
    if (!fn && !ln && cleanStr(r.contact_name)) { const parts = cleanStr(r.contact_name).split(/\s+/); fn = parts.shift(); ln = parts.join(" ") || null; }
    if (!email && cleanStr(r.company_email) && !(fn || ln)) { email = cleanStr(r.company_email); fn = "Main contact"; }
    email = email ? email.toLowerCase() : null;
    if (!email && !fn && !ln) { summary.rows_skipped_no_contact++; continue; }

    const have = existingByCompany.get(company.id) || { emails: new Set(), names: new Set() };
    const nameKey = `${(fn || "").toLowerCase()}|${(ln || "").toLowerCase()}`;
    const dedupe = `${company.id}|${email || nameKey}`;
    if ((email && have.emails.has(email)) || (!email && have.names.has(nameKey)) || seenNew.has(dedupe)) { summary.contacts_already_there++; continue; }
    seenNew.add(dedupe);
    newContacts.push({ company_id: company.id, first_name: fn, last_name: ln, title: cleanStr(r.role), email, phone: cleanStr(r.phone) });
  }
  summary.companies_matched = matchedIds.size;
  summary.companies_unmatched = unmatched.size;
  summary.address_updates = [...companyUpdates.values()].filter((u) => Object.keys(u).length).length;
  summary.contacts_to_add = newContacts.length;
  return { summary, companyUpdates, newContacts, unmatched: [...unmatched.entries()].map(([ns_id, name]) => ({ ns_id, name })) };
}

async function loadContactContext(sql) {
  const companies = await sql`select id, netsuite_customer_id, address_line1, address_line2, city, province, postal_code, country, website, vertical from companies where netsuite_customer_id is not null`;
  const companiesByNs = new Map(companies.map((c) => [String(c.netsuite_customer_id), c]));
  const contacts = await sql`select company_id, lower(email) as email, lower(coalesce(first_name,'')) as fn, lower(coalesce(last_name,'')) as ln from contacts`;
  const existingByCompany = new Map();
  for (const c of contacts) {
    if (!existingByCompany.has(c.company_id)) existingByCompany.set(c.company_id, { emails: new Set(), names: new Set() });
    const e = existingByCompany.get(c.company_id);
    if (c.email) e.emails.add(c.email);
    e.names.add(`${c.fn}|${c.ln}`);
  }
  return { companiesByNs, existingByCompany };
}

async function handleContactsImport(request, url, sql, user) {
  if (!isCrmAdmin(user)) return forbidden("Admin access required.");
  const body = await parseBody(request);
  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows) return json({ error: "rows[] is required" }, 400);
  if (rows.length > 5000) return json({ error: "too_many_rows", detail: "Send at most 5000 rows per request." }, 413);
  const { companiesByNs, existingByCompany } = await loadContactContext(sql);
  const plan = planContactRows(rows, companiesByNs, existingByCompany);
  if (url.pathname === "/admin/contacts-import/preview") {
    return json({ summary: plan.summary, unmatched: plan.unmatched.slice(0, 200) });
  }
  // apply
  for (const [companyId, upd] of plan.companyUpdates) {
    const cols = Object.keys(upd);
    if (!cols.length) continue;
    const sets = cols.map((c, i) => `${c} = coalesce(nullif(${c}, ''), $${i + 2})`).join(", ");
    await sql.query(`update companies set ${sets}, updated_at = now() where id = $1`, [companyId, ...cols.map((c) => upd[c])]);
  }
  for (let i = 0; i < plan.newContacts.length; i += 100) {
    const chunk = plan.newContacts.slice(i, i + 100);
    const params = [];
    const tuples = chunk.map((c) => {
      const base = params.length;
      params.push(c.company_id, c.first_name, c.last_name, c.title, c.email, c.phone);
      return `(${[1, 2, 3, 4, 5, 6].map((k) => "$" + (base + k)).join(", ")})`;
    });
    await sql.query(`insert into contacts (company_id, first_name, last_name, title, email, phone) values ${tuples.join(", ")}`, params);
  }
  return json({ summary: plan.summary, applied: true });
}

// ---------------------------------------------------------------------------
// SCOUT stats (Ben, 2026-10-16). The prequalification program started 2026-06-08
// with a scoring spreadsheet; SCOUT's app took over in late July. Both are
// "prequalified" and are not split in the numbers. Everything is computed from
// scout_runs (every push, plus imported history) and bids. A "unique bid" is the
// latest run per company+project (same name ignoring case/punctuation/accents),
// so re-runs and test repeats count once.
// ---------------------------------------------------------------------------
const PREQUAL_START = "2026-06-08";
const normTier = (t) => {
  const v = String(t || "").trim().toLowerCase();
  if (v === "a" || v === "tier a") return "A";
  if (v === "b" || v === "tier b") return "B";
  if (v === "c" || v === "tier c") return "C";
  if (v === "no bid" || v === "no_bid" || v === "disqualified" || v === "nobid") return "No bid";
  return null;
};
const runKey = (r) => `${r.company_id || nsNorm(r.client)}|${nsNorm(r.project_name)}`;
const weekStart = (d) => {
  const t = new Date(d);
  const day = (t.getUTCDay() + 6) % 7; // Monday = 0
  t.setUTCDate(t.getUTCDate() - day);
  return t.toISOString().slice(0, 10);
};

async function handleScoutStats(url, sql) {
  const range = url.searchParams.get("range") || "all";
  const bounds = rangeBounds(range, { from: url.searchParams.get("from"), to: url.searchParams.get("to") });
  const startMs = bounds.start.getTime(), endMs = bounds.end.getTime();

  const runs = await sql`select id, company_id, bid_id, source, outcome, ((payload->>'priority_client') = 'true') as priority_client, submitted_at, received_at, client, project_name, tier, total_score, disqualifiers, override_reason, override_approver, push_to_bid
    from scout_runs where not excluded`;
  const bids = await sql`select id, project_name, stage, created_at, final_value, estimated_value, procore_project_id, source_archived, (decided_at is not null) as decision_recorded from bids`;
  const bidById = new Map(bids.map((b) => [b.id, b]));
  const bidsByProject = new Map();
  for (const b of bids.sort((x, y) => new Date(x.created_at) - new Date(y.created_at))) bidsByProject.set(nsNorm(b.project_name), b);

  // Latest run per unique bid.
  const latest = new Map();
  for (const r of runs) {
    const at = new Date(r.submitted_at || r.received_at).getTime();
    const k = runKey(r);
    if (!k.replace("|", "")) continue;
    const cur = latest.get(k);
    if (!cur || at >= cur.at) latest.set(k, { ...r, at });
  }
  const all = [...latest.values()];
  const scoutBidIds = new Set();
  for (const u of all) {
    const b = (u.bid_id && bidById.get(u.bid_id)) || bidsByProject.get(nsNorm(u.project_name)) || null;
    u.bid = b;
    if (b) scoutBidIds.add(b.id);
  }

  // ---- Section A: activity in the period (by when SCOUT ran) -------------------
  const inPeriod = all.filter((u) => u.at >= startMs && u.at < endMs);
  const tiers = { A: 0, B: 0, C: 0, "No bid": 0, untiered: 0 };
  let priorityProceeds = 0;
  let overrides = 0, declinedScore = 0, declinedDisq = 0, declinedPerson = 0, declinedOther = 0, submitted = 0;
  const byTier = {}; // outcomes by tier for submitted bids that have a bid record
  const monthly = new Map();
  const weekly = new Map();
  let won = 0, lost = 0, open = 0, becameProject = 0, wonValue = 0, wonEstimate = 0, noRecord = 0;
  const wonProjects = [];
  for (const u of inPeriod) {
    const tier = normTier(u.tier) || "untiered";
    tiers[tier] = (tiers[tier] || 0) + 1;
    const disq = Array.isArray(u.disqualifiers) ? u.disqualifiers.length : 0;
    const declined = String(u.outcome || "").toLowerCase() === "declined";
    const unknownOutcome = String(u.outcome || "").toLowerCase() === "unknown"; // scored on the sheet, no decision recorded
    const isPriorityProceed = !declined && !unknownOutcome && tier === "No bid" && u.priority_client === true;
    const isOverride = !declined && !unknownOutcome && tier === "No bid" && !isPriorityProceed;
    if (isPriorityProceed) priorityProceeds++;
    const month = new Date(u.at).toISOString().slice(0, 7);
    const m = monthly.get(month) || { month, bids: 0, overrides: 0, declined_score: 0, declined_disqualifier: 0, declined_person: 0 };
    m.bids++;
    const wk = weekStart(u.at);
    const w = weekly.get(wk) || { week: wk, A: 0, B: 0, C: 0, "No bid": 0, untiered: 0 };
    w[tier] = (w[tier] || 0) + 1;
    weekly.set(wk, w);
    if (isOverride) { overrides++; m.overrides++; }
    if (declined) {
      if (disq > 0) { declinedDisq++; m.declined_disqualifier++; }
      else if (tier === "No bid") { declinedScore++; m.declined_score++; }
      else if (tier === "untiered") declinedOther++;
      else { declinedPerson++; m.declined_person++; }
    } else if (!unknownOutcome) submitted++;
    monthly.set(month, m);

    if (!declined && !unknownOutcome) {
      const b = u.bid;
      const t = (byTier[tier] ||= { tier, submitted: 0, won: 0, lost: 0, open: 0, no_record: 0, won_value: 0, lost_value: 0, open_value: 0 });
      t.submitted++;
      if (!b) { t.no_record++; noRecord++; continue; }
      if (b.stage === "complete") {
        t.won++; won++;
        t.won_value += Number(b.final_value ?? b.estimated_value ?? 0);
        wonEstimate += Number(b.estimated_value || 0);
        wonValue += Number(b.final_value ?? b.estimated_value ?? 0);
        if (b.procore_project_id) becameProject++;
        wonProjects.push({ bid_id: b.id, project_name: b.project_name, procore_project_id: b.procore_project_id ? String(b.procore_project_id) : null, estimate: b.estimated_value == null ? null : Number(b.estimated_value), final_value: b.final_value == null ? null : Number(b.final_value), tier });
      } else if (b.stage === "lost") { t.lost++; lost++; t.lost_value += Number(b.estimated_value || 0); }
      else if (b.stage === "no_bid") { /* declined after the fact: not open, not decided */ }
      else { t.open++; open++; t.open_value += Number(b.estimated_value || 0); }
    }
  }

  // ---- Section B: cohorts by when the bid arrived (not period-filtered) ---------
  const startCut = new Date(PREQUAL_START + "T00:00:00Z").getTime();
  const MIDLATE = ["bid_submitted", "accepted", "in_progress", "to_do", "delayed"];
  const blank = () => ({ created: 0, complete: 0, lost: 0, midlate: 0, complete_value: 0, lost_value: 0, midlate_value: 0, est_sum: 0, est_n: 0, won_sum: 0, won_n: 0 });
  const cohorts = { before: blank(), after_all: blank(), after_scout: blank(), after_other: blank() };
  const addTo = (c, b) => {
    c.created++;
    const est = b.estimated_value == null ? null : Number(b.estimated_value);
    if (est != null) { c.est_sum += est; c.est_n++; }
    if (b.stage === "complete") {
      const v = b.final_value != null ? Number(b.final_value) : est;
      c.complete++; c.complete_value += v || 0;
      if (v != null) { c.won_sum += v; c.won_n++; }
    } else if (b.stage === "lost") { c.lost++; c.lost_value += est || 0; }
    else if (MIDLATE.includes(b.stage)) { c.midlate++; c.midlate_value += est || 0; }
  };
  for (const b of bids) {
    if (b.source_archived && !b.decision_recorded) continue;
    const t = new Date(b.created_at).getTime();
    if (t < startCut) addTo(cohorts.before, b);
    else {
      addTo(cohorts.after_all, b);
      addTo(scoutBidIds.has(b.id) ? cohorts.after_scout : cohorts.after_other, b);
    }
  }

  // LEDGER's contract / change-order / invoiced figures for the won projects.
  const finRows = await sql`select procore_project_id, contract_value, approved_change_orders, revised_contract, invoiced_to_date, paid_to_date, currency, as_of from project_financials`;
  const finById = new Map(finRows.map((r) => [String(r.procore_project_id), r]));
  const sum = (key) => {
    let total = 0, n = 0;
    for (const w of wonProjects) { const f = w.procore_project_id && finById.get(w.procore_project_id); if (f && f[key] != null) { total += Number(f[key]); n++; } }
    return n ? total : null;
  };
  let withFigures = 0, oldest = null;
  for (const w of wonProjects) {
    const f = w.procore_project_id && finById.get(w.procore_project_id);
    w.contract_value = f && f.contract_value != null ? Number(f.contract_value) : null;
    w.approved_change_orders = f && f.approved_change_orders != null ? Number(f.approved_change_orders) : null;
    w.revised_contract = f && f.revised_contract != null ? Number(f.revised_contract) : null;
    w.invoiced_to_date = f && f.invoiced_to_date != null ? Number(f.invoiced_to_date) : null;
    w.paid_to_date = f && f.paid_to_date != null ? Number(f.paid_to_date) : null;
    w.as_of = f && f.as_of ? new Date(f.as_of).toISOString() : null;
    if (f && (f.revised_contract != null || f.contract_value != null)) withFigures++;
    if (w.as_of && (!oldest || w.as_of < oldest)) oldest = w.as_of;
  }
  const financials = {
    won_projects: wonProjects.length,
    with_project_id: wonProjects.filter((w) => w.procore_project_id).length,
    with_figures: withFigures,
    contract_value: sum("contract_value"),
    approved_change_orders: sum("approved_change_orders"),
    revised_contract: sum("revised_contract"),
    invoiced_to_date: sum("invoiced_to_date"),
    paid_to_date: sum("paid_to_date"),
    oldest_as_of: oldest,
    projects: wonProjects.sort((a, b) => (b.revised_contract ?? b.estimate ?? 0) - (a.revised_contract ?? a.estimate ?? 0)).slice(0, 60),
  };

  const sinceDates = all.map((u) => u.at).sort((a, b) => a - b);
  return json({
    period: { key: range, start: bounds.start.toISOString(), end: bounds.end.getUTCFullYear() >= 9999 ? null : bounds.end.toISOString() },
    prequal_start: PREQUAL_START,
    first_run: sinceDates.length ? new Date(sinceDates[0]).toISOString() : null,
    unique_bids: inPeriod.length,
    total_runs: runs.length,
    tiers,
    submitted,
    overrides,
    priority_proceeds: priorityProceeds,
    declined: { total: declinedScore + declinedDisq + declinedPerson + declinedOther, by_score: declinedScore, by_disqualifier: declinedDisq, by_person: declinedPerson, other: declinedOther },
    outcomes: { won, lost, open, no_record: noRecord, became_project: becameProject, won_value: wonValue, won_estimate: wonEstimate },
    by_tier: ["A", "B", "C", "No bid", "untiered"].map((t) => byTier[t]).filter(Boolean),
    weekly: [...weekly.values()].sort((a, b) => a.week.localeCompare(b.week)),
    monthly: [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month)),
    cohorts,
    financials,
  });
}

// ---- history import (Excel log + the earlier scoring sheet) -------------------------------
// Rows come from a normalized CSV: source, ext_id, run_at, client, project_name, tier,
// total_score, outcome, push_to_bid, disqualifiers (semicolon list), override_reason,
// override_approver, estimator, notes, risks, copilot_summary, bid_due_date.
// Idempotent by source+ext_id; rows whose company isn't in CRM are still kept (the
// numbers don't need a company), just reported.
async function handleScoutImport(request, url, sql, user) {
  if (!isCrmAdmin(user)) return forbidden("Admin access required.");
  const body = await parseBody(request);
  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows) return json({ error: "rows[] is required" }, 400);
  if (rows.length > 600) return json({ error: "too_many_rows", detail: "Send at most 600 rows per request." }, 413);
  const companies = await sql`select id, name from companies`;
  const aliases = await sql`select alias_norm, company_id from company_aliases`;
  const byNorm = new Map();
  for (const c of companies) { const k = nsNorm(c.name); byNorm.set(k, byNorm.has(k) ? null : c.id); }
  for (const a of aliases) if (!byNorm.has(a.alias_norm)) byNorm.set(a.alias_norm, a.company_id);
  const existing = new Set((await sql`select ext_key from scout_runs where ext_key is not null`).map((r) => r.ext_key));

  const summary = { rows: rows.length, new: 0, already_imported: 0, company_in_crm: 0, company_not_in_crm: 0, invalid: 0 };
  const toInsert = [];
  const seen = new Set();
  for (const r of rows) {
    const source = String(r.source || "").trim();
    const extId = String(r.ext_id || "").trim();
    const runAt = r.run_at && !Number.isNaN(new Date(r.run_at).getTime()) ? new Date(r.run_at).toISOString() : null;
    if (!source || !extId || !runAt || !String(r.client || "").trim()) { summary.invalid++; continue; }
    const key = `${source}:${extId}`;
    if (existing.has(key) || seen.has(key)) { summary.already_imported++; continue; }
    seen.add(key);
    summary.new++;
    if (byNorm.get(nsNorm(r.client))) summary.company_in_crm++; else summary.company_not_in_crm++;
    toInsert.push({ key, source, runAt, r });
  }
  if (url.pathname === "/admin/scout-import/preview") return json({ summary });

  for (let i = 0; i < toInsert.length; i += 50) {
    const chunk = toInsert.slice(i, i + 50);
    const params = [];
    const tuples = chunk.map(({ key, source, runAt, r }) => {
      const base = params.length;
      const disq = String(r.disqualifiers || "").split(/;/).map((x) => x.trim()).filter(Boolean);
      const score = r.total_score === "" || r.total_score == null || Number.isNaN(Number(r.total_score)) ? null : Number(r.total_score);
      const push = /^bid$/i.test(String(r.push_to_bid || "").trim()) ? true : /^no bid$/i.test(String(r.push_to_bid || "").trim()) ? false : null;
      const outcome = /declin/i.test(String(r.outcome || "")) ? "declined" : /unknown/i.test(String(r.outcome || "")) ? "unknown" : "submitted";
      params.push(byNorm.get(nsNorm(r.client)) || null, key, "import:" + source, outcome, runAt, String(r.client).trim(), String(r.project_name || "").trim() || null, String(r.tier || "").trim() || null, score,
        JSON.stringify(disq), String(r.override_reason || "").trim() || null, String(r.override_approver || "").trim() || null, String(r.estimator || "").trim() || null,
        String(r.notes || "").trim() || null, String(r.risks || "").trim() || null, String(r.copilot_summary || "").trim() || null, push, JSON.stringify(r));
      return "(" + Array.from({ length: 18 }, (_, k) => "$" + (base + k + 1)).join(", ") + ")";
    });
    await sql.query(
      "insert into scout_runs (company_id, ext_key, source, outcome, submitted_at, client, project_name, tier, total_score, disqualifiers, override_reason, override_approver, estimator, notes, risks, copilot_summary, push_to_bid, payload) values " + tuples.join(", "),
      params
    );
  }
  return json({ summary, applied: true });
}

// Match the client names on SCOUT history to real companies (Ben, 2026-10-16).
// Lists each distinct client name on a run that has no company yet, with a few
// likely candidates, and lets an admin link it (which also remembers the spelling
// as an alias, so later pushes resolve) or mark it as not a real client.
async function resolveRunCompanies(sql) {
  const companies = await sql`select id, name from companies`;
  const aliases = await sql`select alias_norm, company_id from company_aliases`;
  const byNorm = new Map();
  for (const c of companies) { const k = nsNorm(c.name); byNorm.set(k, byNorm.has(k) ? null : c.id); }
  for (const a of aliases) if (!byNorm.has(a.alias_norm)) byNorm.set(a.alias_norm, a.company_id);
  const names = await sql`select client, count(*)::int as n from scout_runs where company_id is null and not excluded and client is not null group by client`;
  for (const r of names) {
    const id = byNorm.get(nsNorm(r.client));
    if (id) await sql`update scout_runs set company_id = ${id} where company_id is null and client = ${r.client}`;
  }
  return companies;
}

async function handleScoutUnlinked(request, url, sql, user) {
  if (!isCrmAdmin(user)) return forbidden("Admin access required.");
  if (url.pathname === "/admin/scout-unlinked" && request.method === "GET") {
    await resolveRunCompanies(sql);
    // Suggestions come from every company with its city/province, so branches of one
    // customer (each its own company) can be told apart; the province prefix on the
    // project name ("ON – ", "AB – ") nudges the matching branch to the top.
    const companies = await sql`select id, name, city, province from companies`;
    const runs = await sql`select id, client, project_name, submitted_at, tier from scout_runs where company_id is null and not excluded and client is not null order by client, submitted_at`;
    const tokens = (v) => new Set(nsLoose(v).split(" ").filter((w) => w.length > 1));
    const index = companies.map((c) => ({ id: c.id, name: c.name, city: c.city, province: c.province, t: tokens(c.name), first: nsLoose(c.name).split(" ")[0] }));
    const provOf = (project) => { const m = /^\s*([A-Za-z]{2})\s*[–—-]/.exec(project || ""); return m ? m[1].toUpperCase() : null; };
    const suggest = (client, project) => {
      const t = tokens(client);
      const first = nsLoose(client).split(" ")[0];
      const prov = provOf(project);
      return index
        .map((c) => {
          let overlap = 0;
          for (const w of t) if (c.t.has(w)) overlap++;
          let score = t.size ? overlap / t.size : 0;
          if (c.first && c.first === first) score += 0.4;
          if (score >= 0.5 && prov && c.province && String(c.province).toUpperCase() === prov) score += 0.3;
          return { id: c.id, name: c.name, city: c.city, province: c.province, score };
        })
        .filter((c) => c.score >= 0.5)
        .sort((x, y) => y.score - x.score)
        .slice(0, 6)
        .map(({ id, name, city, province }) => ({ id, name, city, province }));
    };
    const byClient = new Map();
    for (const r of runs) {
      if (!byClient.has(r.client)) byClient.set(r.client, []);
      byClient.get(r.client).push(r);
    }
    const out = [...byClient.entries()]
      .map(([client, rs]) => ({
        client,
        runs: rs.length,
        suggestions: suggest(client, rs[0].project_name),
        items: rs.slice(0, 80).map((r) => ({ id: r.id, project_name: r.project_name, submitted_at: r.submitted_at, tier: r.tier, suggestions: suggest(client, r.project_name) })),
      }))
      .sort((x, y) => y.runs - x.runs || x.client.localeCompare(y.client));
    return json({ clients: out });
  }
  const body = await parseBody(request);
  if (url.pathname === "/admin/scout-unlinked/link" && request.method === "POST") {
    const runIds = Array.isArray(body.run_ids) ? body.run_ids.map(String).slice(0, 200) : null;
    if ((!body.client && !runIds) || !body.company_id) return json({ error: "company_id and client or run_ids are required" }, 400);
    const [company] = await sql`select id, name from companies where id = ${body.company_id}`;
    if (!company) return json({ error: "not_found" }, 404);
    // Specific runs: just those (a customer with several branches is matched run by run, and
    // the spelling is NOT remembered as an alias because it doesn't point at one company).
    if (runIds) {
      let n = 0;
      for (const id of runIds) {
        const r = await sql`update scout_runs set company_id = ${company.id} where id = ${id} and company_id is null returning id`;
        n += r.length;
      }
      return json({ ok: true, linked_runs: n, company: company.name });
    }
    const upd = await sql`update scout_runs set company_id = ${company.id} where client = ${body.client} and company_id is null returning id`;
    const key = nsNorm(body.client);
    if (key && key !== nsNorm(company.name)) {
      await sql`insert into company_aliases (alias_norm, company_id, alias_name) values (${key}, ${company.id}, ${body.client}) on conflict (alias_norm) do update set company_id = excluded.company_id, alias_name = excluded.alias_name`;
    }
    return json({ ok: true, linked_runs: upd.length, company: company.name });
  }
  if (url.pathname === "/admin/scout-unlinked/exclude" && request.method === "POST") {
    const runIds = Array.isArray(body.run_ids) ? body.run_ids.map(String).slice(0, 200) : null;
    if (!body.client && !runIds) return json({ error: "client or run_ids is required" }, 400);
    if (runIds) {
      let n = 0;
      for (const id of runIds) n += (await sql`update scout_runs set excluded = true where id = ${id} and company_id is null returning id`).length;
      return json({ ok: true, excluded_runs: n });
    }
    const upd = await sql`update scout_runs set excluded = true where client = ${body.client} and company_id is null returning id`;
    return json({ ok: true, excluded_runs: upd.length });
  }
  return json({ error: "not_found" }, 404);
}

// ---------------------------------------------------------------------------
// Project financials pushed by LEDGER (Ben, 2026-10-16): POST /internal/project-financials,
// header X-CRM-Finance-Key (CRM_FINANCE_KEY secret, same value as on LEDGER). LEDGER pushes
// the projects it refreshed every 15 minutes. null = unknown and stays null (never 0);
// as_of is when LEDGER last read the project from Procore. All rows are kept; the SCOUT
// stats join them to won bids by procore_project_id.
// ---------------------------------------------------------------------------
function isFinanceCaller(request, env) {
  const key = request.headers.get("X-CRM-Finance-Key");
  return Boolean(key) && Boolean(env.CRM_FINANCE_KEY) && key === env.CRM_FINANCE_KEY;
}
const finNum = (v) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

async function upsertFinancials(sql, items) {
  let stored = 0;
  const bad = [];
  const good = [];
  for (const it of items) {
    const id = it && it.procore_project_id != null ? String(it.procore_project_id).trim() : "";
    if (!/^\d{5,}$/.test(id)) { bad.push(it && it.procore_project_id); continue; }
    const asOf = it.as_of && !Number.isNaN(new Date(it.as_of).getTime()) ? new Date(it.as_of).toISOString() : null;
    good.push([id, it.project_name ? String(it.project_name).slice(0, 300) : null, finNum(it.contract_value), finNum(it.approved_change_orders), finNum(it.revised_contract), finNum(it.invoiced_to_date), finNum(it.paid_to_date), it.currency ? String(it.currency).slice(0, 8) : null, asOf]);
  }
  for (let i = 0; i < good.length; i += 100) {
    const chunk = good.slice(i, i + 100);
    const params = [];
    const tuples = chunk.map((row) => {
      const base = params.length;
      params.push(...row);
      return "(" + row.map((_, k) => "$" + (base + k + 1)).join(", ") + ")";
    });
    await sql.query(
      "insert into project_financials (procore_project_id, project_name, contract_value, approved_change_orders, revised_contract, invoiced_to_date, paid_to_date, currency, as_of) values " + tuples.join(", ") +
      " on conflict (procore_project_id) do update set project_name = excluded.project_name, contract_value = excluded.contract_value, approved_change_orders = excluded.approved_change_orders, revised_contract = excluded.revised_contract, invoiced_to_date = excluded.invoiced_to_date, paid_to_date = excluded.paid_to_date, currency = excluded.currency, as_of = excluded.as_of, received_at = now()",
      params
    );
    stored += chunk.length;
  }
  return { stored, bad };
}

async function handleFinancialsPush(request, sql) {
  const body = await parseBody(request);
  const items = Array.isArray(body.items) ? body.items : null;
  if (!items) return json({ error: "items[] is required" }, 400);
  if (items.length > 500) return json({ error: "too_many_items", detail: "Send at most 500 items per request." }, 413);
  const { stored, bad } = await upsertFinancials(sql, items);
  return json({ received: items.length, stored, invalid: bad.length, invalid_ids: bad.slice(0, 20) });
}

// Ask LEDGER to refresh one project right now (counts against LEDGER's people allowance, not its
// background cap). Needs the LEDGER_WORKER service binding and the finance key; until both exist
// it says so instead of failing.
async function handleFinancialsRefresh(request, env, sql, user) {
  if (!canSeeAllBids(user)) return forbidden("Not available to your role.");
  const body = await parseBody(request);
  const id = body.procore_project_id ? String(body.procore_project_id).trim() : "";
  if (!/^\d{5,}$/.test(id)) return json({ error: "procore_project_id is required" }, 400);
  if (!env.LEDGER_WORKER || !env.CRM_FINANCE_KEY) return json({ error: "not_connected", detail: "LEDGER isn't connected to CRM yet (service binding or key missing)." }, 503);
  let res;
  try {
    res = await env.LEDGER_WORKER.fetch("https://ledger.ben-a90.workers.dev/crm/project-financials/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CRM-Finance-Key": env.CRM_FINANCE_KEY },
      body: JSON.stringify({ procore_project_id: id }),
    });
  } catch (e) {
    return json({ error: "ledger_unreachable", detail: e.message }, 502);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return json({ error: data.error || "ledger_error", detail: data.error || `LEDGER answered HTTP ${res.status}`, retry_after_seconds: data.retry_after_seconds || null }, [400, 404, 503].includes(res.status) ? res.status : 502);
  const item = data.item || data;
  await upsertFinancials(sql, [{ ...item, procore_project_id: item.procore_project_id || id }]);
  // LEDGER may hand back its last stored figures with a note that the live refresh failed.
  return json({ ok: !data.refresh_error, refresh_error: data.refresh_error || null });
}

// ---------------------------------------------------------------------------
// Admin review: what the leadership should look at in one place (Ben, 2026-10-21):
// declined priority-client RFQs (a queue to work through), SCOUT overrides, blacklisted
// clients and priority clients.
// ---------------------------------------------------------------------------
async function handleAdminReview(request, url, sql, user) {
  if (!isCrmAdmin(user)) return forbidden("Admin access required.");
  if (url.pathname === "/admin/review/resolve" && request.method === "POST") {
    const body = await parseBody(request);
    if (!body.id) return json({ error: "id is required" }, 400);
    const [row] = await sql`
      update review_queue set status = 'done', resolved_by = ${user.username}, resolved_at = now(), resolution_note = ${body.note || null}
      where id = ${body.id} and status = 'open' returning id`;
    if (!row) return json({ error: "not_found" }, 404);
    return json({ ok: true });
  }
  if (url.pathname === "/admin/review" && request.method === "GET") {
    const declined = await sql`
      select q.id, q.rfq_ref, q.project_name, q.reason, q.actor, q.status, q.created_at, q.resolved_by, q.resolved_at, q.resolution_note,
        c.id as company_id, c.name as company_name
      from review_queue q left join companies c on c.id = q.company_id
      where q.kind = 'priority_declined' and (q.status = 'open' or q.resolved_at > now() - interval '60 days')
      order by (q.status = 'open') desc, q.created_at desc limit 200`;
    const overrides = await sql`
      select id, client, project_name, tier, submitted_at, override_reason, override_approver, coalesce(nullif(estimator, ''), payload->>'submitted_by') as estimator
      from scout_runs
      where not excluded and outcome = 'submitted' and lower(coalesce(tier, '')) in ('no bid', 'no_bid')
        and coalesce((payload->>'priority_client'), 'false') <> 'true' and submitted_at > now() - interval '120 days'
      order by submitted_at desc limit 100`;
    // Priority clients' RFQs that scored No Bid but went ahead anyway: the ones that would
    // have failed without the flag. No override is needed for these, so they are listed here.
    const proceeds = await sql`
      select id, client, project_name, total_score, submitted_at, coalesce(nullif(estimator, ''), payload->>'submitted_by') as estimator
      from scout_runs
      where not excluded and outcome = 'submitted' and lower(coalesce(tier, '')) in ('no bid', 'no_bid')
        and coalesce((payload->>'priority_client'), 'false') = 'true' and submitted_at > now() - interval '180 days'
      order by submitted_at desc limit 100`;
    const blacklisted = await sql`
      select id, name, blacklist_reason, blacklisted_by, blacklisted_at from companies where blacklisted order by blacklisted_at desc nulls last, name`;
    const priority = await sql`
      select id, name, hot_lead_reason, hot_lead_set_by, hot_lead_set_at, priority_permanent from companies where hot_lead order by priority_permanent desc, hot_lead_set_at desc nulls last, name`;
    return json({ declined, overrides, proceeds, blacklisted, priority });
  }
  return json({ error: "not_found" }, 404);
}

// ---------------------------------------------------------------------------
// Follow-up dashboard (Ben, 2026-10-21): progress, bulk assignment and auto-assignment
// rules, for admins, estimators and follow-up managers only.
// ---------------------------------------------------------------------------
const provinceOfProject = (name) => { const m = /^\s*([A-Za-z]{2})\s*[–—-]/.exec(name || ""); return m ? m[1].toUpperCase() : null; };
const today = () => new Date().toISOString().slice(0, 10);
const dayOf = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

async function loadFollowupPeople(env, user) {
  try { return (await eligibleAssignees(env, user)).map((p) => ({ username: p.username, displayName: p.displayName, level: p.level, extras: Array.isArray(p.extras) ? p.extras : [] })); }
  catch (e) { return []; }
}

async function handleFollowupDashboard(env, sql, user) {
  if (!canSeeFollowupDashboard(user)) return forbidden("The follow-up dashboard isn't available to your role.");
  const people = await loadFollowupPeople(env, user);
  const bids = await sql`
    select b.id, b.project_name, b.stage, b.owner_username, b.estimator_username, b.next_action_date, b.created_at,
      c.name as company_name, c.region as company_region, c.province as company_province
    from bids b left join companies c on c.id = b.company_id
    where b.stage in ('rfq', 'invitation', 'accepted', 'estimating', 'bid_submitted', 'to_do', 'delayed', 'in_progress')
    order by b.next_action_date nulls first limit 1500`;
  const t = today();
  const assignedTo = (b) => b.owner_username || b.estimator_username || null;
  const daysOver = (b) => (b.next_action_date ? Math.floor((new Date(t) - new Date(dayOf(b.next_action_date))) / 86400000) : null);
  const summary = { open_bids: bids.length, overdue: 0, due_today: 0, never_set: 0, unassigned: 0, unassigned_overdue: 0 };
  const stats = new Map(people.map((p) => [p.username, { ...p, open: 0, overdue: 0, due_today: 0 }]));
  for (const b of bids) {
    const d = daysOver(b);
    const overdue = d != null && d > 0;
    if (overdue) summary.overdue++;
    else if (d === 0) summary.due_today++;
    else if (d == null) summary.never_set++;
    const who = assignedTo(b);
    if (!who) { summary.unassigned++; if (overdue || d == null) summary.unassigned_overdue++; }
    if (who && stats.has(who)) { const st = stats.get(who); st.open++; if (overdue) st.overdue++; else if (d === 0) st.due_today++; }
  }
  const logged = await sql`
    select logged_by, count(*) filter (where sent_at > now() - interval '7 days')::int as d7, count(*) filter (where sent_at > now() - interval '30 days')::int as d30
    from bid_emails where (direction = 'outbound' or contact_type <> 'email') and sent_at > now() - interval '30 days' group by logged_by`;
  for (const l of logged) if (stats.has(l.logged_by)) { const st = stats.get(l.logged_by); st.logged_7d = l.d7; st.logged_30d = l.d30; }
  const team = [...stats.values()].map((x) => ({ ...x, logged_7d: x.logged_7d || 0, logged_30d: x.logged_30d || 0 })).sort((a, b) => b.overdue - a.overdue || b.open - a.open);

  // The bids worth acting on: overdue, never given a date, or unassigned.
  const work = bids
    .filter((b) => !assignedTo(b) || daysOver(b) == null || daysOver(b) > 0)
    .slice(0, 400)
    .map((b) => ({
      id: b.id, project_name: b.project_name, company_name: b.company_name, stage: b.stage,
      owner_username: b.owner_username, estimator_username: b.estimator_username,
      next_action_date: dayOf(b.next_action_date), days_overdue: daysOver(b),
      province: provinceOfProject(b.project_name) || b.company_province || null, region: b.company_region || null,
    }));
  const rules = await sql`
    select r.id, r.position, r.kind, r.company_id, r.value, r.assignee_username, r.pool, r.active, r.note, r.updated_by, r.updated_at, c.name as company_name
    from followup_rules r left join companies c on c.id = r.company_id order by r.position, r.updated_at`;
  const managers = people.filter((p) => p.extras.includes(EXTRA_FOLLOWUP_MANAGER));
  const settings = await getCrmSettings(sql);
  return json({
    summary, team, work, rules, managers, people, cadence: settings.cadence,
    can: { assign: canAssignFollowups(user), edit_rules_directly: canEditRulesDirectly(user) },
  });
}

async function handleBulkAssign(request, env, sql, user) {
  if (!canSeeFollowupDashboard(user) || !canAssignFollowups(user)) return forbidden("You can't assign follow-ups.");
  const body = await parseBody(request);
  const ids = Array.isArray(body.bid_ids) ? body.bid_ids.map(String).slice(0, 300) : [];
  if (!ids.length) return json({ error: "bid_ids is required" }, 400);
  const target = body.owner_username || null;
  if (target) {
    const eligible = new Set((await eligibleAssignees(env, user)).map((p) => p.username));
    if (!eligible.has(target)) return json({ error: "not_assignable", detail: `"${target}" can't be assigned follow-ups; they need CRM access at PM level or above.` }, 422);
  }
  let n = 0;
  for (const id of ids) {
    const r = await sql`update bids set owner_username = ${target}, updated_at = now() where id = ${id} and stage in ('rfq', 'invitation', 'accepted', 'estimating', 'bid_submitted', 'to_do', 'delayed', 'in_progress') returning id`;
    n += r.length;
  }
  return json({ ok: true, assigned: n });
}

// The rules, in order; the first one that gives a bid an assignee wins.
async function planRuleAssignments(env, sql, user) {
  const people = await eligibleAssignees(env, user);
  const eligible = new Set(people.map((p) => p.username));
  const rules = (await sql`select * from followup_rules where active order by position, updated_at`);
  const bids = await sql`
    select b.id, b.project_name, b.company_id, b.owner_username, b.estimator_username, b.created_at,
      c.name as company_name, c.region as company_region, c.province as company_province
    from bids b left join companies c on c.id = b.company_id
    where b.stage in ('rfq', 'invitation', 'accepted', 'estimating', 'bid_submitted', 'to_do', 'delayed', 'in_progress')`;
  const load = new Map();
  for (const b of bids) { const w = b.owner_username || b.estimator_username; if (w) load.set(w, (load.get(w) || 0) + 1); }
  // relationship: the person who most recently owned a bid for the same company
  const lastOwner = new Map();
  for (const b of [...bids].sort((x, y) => new Date(y.created_at) - new Date(x.created_at))) {
    const w = b.owner_username || b.estimator_username;
    if (w && b.company_id && eligible.has(w) && !lastOwner.has(b.company_id)) lastOwner.set(b.company_id, w);
  }
  const out = [];
  let unmatched = 0;
  for (const b of bids) {
    if (b.owner_username || b.estimator_username) continue;
    let pick = null, why = null;
    for (const r of rules) {
      let who = null;
      if (r.kind === "client" && r.company_id && r.company_id === b.company_id) who = r.assignee_username;
      else if (r.kind === "region" && r.value && b.company_region === r.value) who = r.assignee_username;
      else if (r.kind === "province" && r.value && (provinceOfProject(b.project_name) === String(r.value).toUpperCase() || (!provinceOfProject(b.project_name) && String(b.company_province || "").toUpperCase() === String(r.value).toUpperCase()))) who = r.assignee_username;
      else if (r.kind === "relationship" && b.company_id && lastOwner.has(b.company_id)) who = lastOwner.get(b.company_id);
      else if (r.kind === "balance") {
        const pool = (Array.isArray(r.pool) ? r.pool : []).filter((u) => eligible.has(u));
        if (pool.length) who = pool.slice().sort((a, c2) => (load.get(a) || 0) - (load.get(c2) || 0))[0];
      }
      if (who && eligible.has(who)) { pick = who; why = r; break; }
    }
    if (!pick) { unmatched++; continue; }
    load.set(pick, (load.get(pick) || 0) + 1);
    out.push({ bid_id: b.id, project_name: b.project_name, company_name: b.company_name, assignee: pick, rule_id: why.id, rule_kind: why.kind });
  }
  return { assignments: out, unmatched, rules_active: rules.length };
}

async function handleFollowupRules(request, url, env, sql, user) {
  if (!canSeeFollowupDashboard(user)) return forbidden("The follow-up dashboard isn't available to your role.");
  const path = url.pathname;
  if (path === "/followups/rules/preview" && request.method === "POST") return json(await planRuleAssignments(env, sql, user));
  if (path === "/followups/rules/apply" && request.method === "POST") {
    if (!canAssignFollowups(user)) return forbidden("You can't assign follow-ups.");
    const plan = await planRuleAssignments(env, sql, user);
    let n = 0;
    for (const a of plan.assignments) {
      const r = await sql`update bids set owner_username = ${a.assignee}, updated_at = now() where id = ${a.bid_id} and owner_username is null and estimator_username is null returning id`;
      n += r.length;
    }
    return json({ ok: true, assigned: n, unmatched: plan.unmatched });
  }
  if (path === "/followups/rules" && request.method === "POST") {
    const body = await parseBody(request);
    const kinds = ["client", "region", "province", "relationship", "balance"];
    if (body.action === "delete") {
      await sql`delete from followup_rules where id = ${body.id}`;
      return json({ ok: true });
    }
    if (body.action === "move") {
      const rows = await sql`select id, position from followup_rules order by position, updated_at`;
      const i = rows.findIndex((r) => r.id === body.id);
      const j = body.direction === "up" ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= rows.length) return json({ ok: true });
      const order = rows.map((r) => r.id);
      [order[i], order[j]] = [order[j], order[i]];
      for (let k = 0; k < order.length; k++) await sql`update followup_rules set position = ${k}, updated_by = ${user.username}, updated_at = now() where id = ${order[k]}`;
      return json({ ok: true });
    }
    if (body.action === "toggle") {
      await sql`update followup_rules set active = ${Boolean(body.active)}, updated_by = ${user.username}, updated_at = now() where id = ${body.id}`;
      return json({ ok: true });
    }
    if (body.action === "create") {
      if (!kinds.includes(body.kind)) return json({ error: "kind must be one of " + kinds.join(", ") }, 400);
      const eligible = new Set((await eligibleAssignees(env, user)).map((p) => p.username));
      let assignee = body.assignee_username || null;
      let pool = Array.isArray(body.pool) ? body.pool.map(String) : [];
      if (body.kind === "balance") { pool = pool.filter((u) => eligible.has(u)); if (!pool.length) return json({ error: "A balance rule needs at least one person." }, 400); assignee = null; }
      else if (body.kind !== "relationship") { if (!assignee || !eligible.has(assignee)) return json({ error: "not_assignable", detail: "Pick someone with CRM access at PM level or above." }, 422); }
      else assignee = null;
      if (body.kind === "client" && !body.company_id) return json({ error: "Pick the client." }, 400);
      if ((body.kind === "region" || body.kind === "province") && !String(body.value || "").trim()) return json({ error: "A value is required for this rule." }, 400);
      const [{ n }] = await sql`select coalesce(max(position), -1)::int + 1 as n from followup_rules`;
      await sql`insert into followup_rules (position, kind, company_id, value, assignee_username, pool, note, updated_by)
        values (${n}, ${body.kind}, ${body.kind === "client" ? body.company_id : null}, ${body.kind === "region" || body.kind === "province" ? String(body.value).trim() : null}, ${assignee}, ${JSON.stringify(pool)}::jsonb, ${body.note || null}, ${user.username})`;
      return json({ ok: true });
    }
    return json({ error: "action must be create, delete, move or toggle" }, 400);
  }
  return json({ error: "not_found" }, 404);
}

// ---------------------------------------------------------------------------
// Customer payment scores — POST /internal/payment-scores (Ben, 2026-10-16).
// netsuite-worker computes the score once and pushes the finished values here,
// right after it writes the custentity_scout_pay* NetSuite fields. CRM stores
// and displays them as received; null means "not enough history" and stays
// null. Auth: X-CRM-Payscore-Key against the CRM_PAYSCORE_KEY secret — its own
// key, deliberately not the SCOUT intake key (that one is visible in SCOUT's page).
// Matching: companies.netsuite_customer_id = customer_id first; otherwise a
// case-insensitive exact name match, only when exactly one company has that
// name. Name matches are stored but never write netsuite_customer_id (that id
// also drives the hot-lead mirror into NetSuite, so a wrong guess must not
// stick). Unmatched items are reported, never created as companies.
// ---------------------------------------------------------------------------
function isPayscoreCaller(request, env) {
  const key = request.headers.get("X-CRM-Payscore-Key");
  return Boolean(key) && Boolean(env.CRM_PAYSCORE_KEY) && key === env.CRM_PAYSCORE_KEY;
}

async function handlePaymentScoresPush(request, sql) {
  const body = await parseBody(request);
  const items = Array.isArray(body.items) ? body.items : null;
  if (!items) return json({ error: "items[] is required" }, 400);
  if (items.length > 500) return json({ error: "too_many_items", detail: "Send at most 500 items per request." }, 413);
  const numOrNull = (v) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
  const out = { received: items.length, matched: 0, matched_by_id: 0, matched_by_name: 0, unmatched: [], invalid: [], ambiguous: [] };
  for (const it of items) {
    if (!it || (it.customer_id == null && !it.name)) { out.invalid.push({ item: it, reason: "customer_id or name is required" }); continue; }
    const customerId = it.customer_id != null ? String(it.customer_id) : null;
    let companyId = null, how = null;
    if (customerId) {
      const byId = await sql`select id from companies where netsuite_customer_id = ${customerId}`;
      if (byId.length === 1) { companyId = byId[0].id; how = "id"; }
      else if (byId.length > 1) { out.ambiguous.push({ customer_id: customerId, name: it.name || null, reason: "more than one company has this NetSuite id" }); continue; }
    }
    if (!companyId && it.name) {
      const byName = await sql`select id from companies where lower(trim(name)) = lower(trim(${String(it.name)}))`;
      if (byName.length === 1) { companyId = byName[0].id; how = "name"; }
      else if (byName.length > 1) { out.ambiguous.push({ customer_id: customerId, name: it.name, reason: "more than one company has this name" }); continue; }
    }
    if (!companyId) { out.unmatched.push({ customer_id: customerId, name: it.name || null }); continue; }
    await sql`
      insert into company_payment_scores (company_id, ns_customer_id, ns_name, status, score, score_18m, score_6m, judged_invoices,
        avg_days_past_terms_18m, avg_days_past_terms_6m, late_pct, credit_pct, credit_memos_per_invoice, overdue_days, calc_date, received_at)
      values (${companyId}, ${customerId}, ${it.name || null}, ${it.status || null}, ${numOrNull(it.score)}, ${numOrNull(it.score_18m)}, ${numOrNull(it.score_6m)},
        ${numOrNull(it.judged_invoices)}, ${numOrNull(it.avg_days_past_terms_18m)}, ${numOrNull(it.avg_days_past_terms_6m)}, ${numOrNull(it.late_pct)},
        ${numOrNull(it.credit_pct)}, ${numOrNull(it.credit_memos_per_invoice)}, ${numOrNull(it.overdue_days)}, ${it.calc_date ? String(it.calc_date) : null}, now())
      on conflict (company_id) do update set
        ns_customer_id = excluded.ns_customer_id, ns_name = excluded.ns_name, status = excluded.status, score = excluded.score,
        score_18m = excluded.score_18m, score_6m = excluded.score_6m, judged_invoices = excluded.judged_invoices,
        avg_days_past_terms_18m = excluded.avg_days_past_terms_18m, avg_days_past_terms_6m = excluded.avg_days_past_terms_6m,
        late_pct = excluded.late_pct, credit_pct = excluded.credit_pct, credit_memos_per_invoice = excluded.credit_memos_per_invoice,
        overdue_days = excluded.overdue_days, calc_date = excluded.calc_date, received_at = now()`;
    out.matched++;
    if (how === "id") out.matched_by_id++; else out.matched_by_name++;
  }
  return json(out);
}

async function handleCompanyDetail(id, sql) {
  const rows = await sql`select * from companies where id = ${id}`;
  if (!rows.length) return json({ error: "not_found" }, 404);
  const payment = (await sql`select * from company_payment_scores where company_id = ${id}`)[0] || null;
  const contacts = await sql`select * from contacts where company_id = ${id} order by created_at`;
  const bids = await sql`select id, rfq_ref, project_name, stage, qualification_result, estimated_value, submitted_value, final_value, bid_due_date, created_at from bids where company_id = ${id} order by created_at desc`;
  return json({ company: rows[0], contacts, bids, payment });
}

const COMPANY_PATCHABLE = ["account_segment", "region", "vertical", "tier", "notes", "hot_lead", "hot_lead_weight", "hot_lead_reason", "netsuite_customer_id", "blacklisted", "blacklist_reason", "priority_permanent"];

async function handleCompanyPatch(id, request, sql, env, user) {
  const body = await parseBody(request);
  if (["hot_lead", "hot_lead_weight", "hot_lead_reason"].some((f) => body[f] !== undefined) && !canSetHotLead(user)) {
    return forbidden("Only estimators and admins can add or change the hot-lead designation.");
  }
  const existing = await sql`select * from companies where id = ${id}`;
  if (!existing.length) return json({ error: "not_found" }, 404);
  // Blacklisting, its reason, and making a priority client permanent are admin-only.
  if (["blacklisted", "blacklist_reason"].some((f) => body[f] !== undefined && body[f] !== existing[0][f]) && !canManageBlacklist(user)) {
    return forbidden("Only admins can blacklist or un-blacklist a client.");
  }
  if (body.priority_permanent !== undefined && Boolean(body.priority_permanent) !== Boolean(existing[0].priority_permanent) && !isCrmAdmin(user)) {
    return forbidden("Only admins can make a priority client permanent.");
  }

  // A client is either blacklisted or a priority client, never both (Ben, 2026-10-21): the
  // other flag has to be removed first.
  const willBlacklist = body.blacklisted === true && !existing[0].blacklisted;
  const willPrioritize = body.hot_lead === true && !existing[0].hot_lead;
  if (willBlacklist && (existing[0].hot_lead && body.hot_lead !== false)) {
    return json({ error: "flag_conflict", detail: "This client is a priority client. Remove the priority flag before blacklisting it." }, 409);
  }
  if (willPrioritize && (existing[0].blacklisted && body.blacklisted !== false)) {
    return json({ error: "flag_conflict", detail: "This client is blacklisted. Remove the blacklist before making it a priority client." }, 409);
  }

  const fields = Object.keys(body).filter((k) => COMPANY_PATCHABLE.includes(k));
  if (!fields.length) return json({ error: "no_valid_fields", detail: `Patchable fields: ${COMPANY_PATCHABLE.join(", ")}` }, 400);
  if (body.region !== undefined) {
    const badRegion = await regionRejection(sql, body.region, existing[0].region);
    if (badRegion) return badRegion;
  }

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
  // The blacklist checkbox drives the old Do Not Pursue designation too, so anything that
  // still reads account_segment (older SCOUT builds) keeps working. Un-blacklisting puts the
  // account back to Unreviewed rather than guessing its earlier segment.
  if (body.blacklisted !== undefined && Boolean(body.blacklisted) !== Boolean(existing[0].blacklisted)) {
    if (body.blacklisted) {
      setClauses.blacklisted_by = user.username;
      setClauses.blacklisted_at = new Date().toISOString();
      if (!BLACKLIST_SEGMENTS.includes(setClauses.account_segment)) setClauses.account_segment = "do_not_pursue";
    } else {
      setClauses.blacklisted_by = null;
      setClauses.blacklisted_at = null;
      setClauses.blacklist_reason = null;
      if (BLACKLIST_SEGMENTS.includes(setClauses.account_segment)) setClauses.account_segment = "unreviewed";
    }
  }
  // Un-flagging a priority client also clears "permanent".
  if (body.hot_lead === false) setClauses.priority_permanent = false;
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
      blacklisted = ${Boolean(setClauses.blacklisted)},
      blacklist_reason = ${setClauses.blacklist_reason ?? null},
      blacklisted_by = ${setClauses.blacklisted_by ?? null},
      blacklisted_at = ${setClauses.blacklisted_at ?? null},
      priority_permanent = ${Boolean(setClauses.priority_permanent)},
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

async function handleBidsList(url, sql, user) {
  const denied = scopeDenied(user);
  if (denied) return denied;
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

async function handleBidDetail(id, sql, user) {
  const rows = await sql`
    select b.*, c.name as company_name, ct.email as contact_email, ct.first_name as contact_first_name, ct.last_name as contact_last_name
    from bids b left join companies c on c.id = b.company_id left join contacts ct on ct.id = b.contact_id
    where b.id = ${id}`;
  if (!rows.length) return json({ error: "not_found" }, 404);
  const denied = bidAccessDenied(user, rows[0]);
  if (denied) return denied;
  const history = await sql`select * from bid_stage_history where bid_id = ${id} order by changed_at desc`;
  const emails = await sql`select * from bid_emails where bid_id = ${id} order by sent_at desc`;
  // The customer's directory contacts, so a follow-up's recipient can be picked
  // without leaving the bid (a PM has no Companies tab).
  const contacts = rows[0].company_id
    ? await sql`select id, first_name, last_name, title, email from contacts where company_id = ${rows[0].company_id} order by first_name, last_name`
    : [];
  // SCOUT's latest complete record for this bid, plus how many pushes there were.
  const runs = await sql`select * from scout_runs where bid_id = ${id} order by coalesce(submitted_at, received_at) desc limit 1`;
  const [{ n: runCount }] = await sql`select count(*)::int as n from scout_runs where bid_id = ${id}`;
  const followupEvents = await sql`select id, kind, from_date, to_date, reason, by_username, created_at from bid_followup_events where bid_id = ${id} order by created_at desc limit 10`;
  return json({ bid: rows[0], stage_history: history, emails, followup_events: followupEvents, company_contacts: contacts, scout_latest: runs[0] || null, scout_run_count: runCount });
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
  const accessDenied = bidAccessDenied(user, existing[0]);
  if (accessDenied) return accessDenied;
  // A PM works their own follow-ups: next action and who the contact is, nothing else.
  const patchable = canSeeAllBids(user) ? BID_PATCHABLE : ["next_action", "next_action_date", "contact_id"];
  const fields = Object.keys(body).filter((k) => patchable.includes(k));
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
      decided_at = ${to_stage === "complete" || to_stage === "lost" ? (bid.stage === to_stage && bid.decided_at ? bid.decided_at : new Date().toISOString()) : null},
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

async function handleEmailsList(bidId, sql, user) {
  const [b] = await sql`select owner_username, estimator_username from bids where id = ${bidId}`;
  const denied = b ? bidAccessDenied(user, b) : null;
  if (denied) return denied;
  const rows = await sql`select * from bid_emails where bid_id = ${bidId} order by sent_at desc`;
  return json({ emails: rows });
}

const CONTACT_TYPES = { email: "Email", call: "Phone call", meeting: "In-person conversation", text: "Text / chat message", other: "Other contact" };

// Logs one contact with the client against a bid: an email (the default) or a call, meeting, text or
// other contact, which carry a short note instead of a message. Any logged contact, sent or received,
// restarts the follow-up clock.
async function handleEmailCreate(bidId, request, sql, user) {
  const body = await parseBody(request);
  const bidRows = await sql`select * from bids where id = ${bidId}`;
  if (!bidRows.length) return json({ error: "bid_not_found" }, 404);
  const accessDenied = bidAccessDenied(user, bidRows[0]);
  if (accessDenied) return accessDenied;
  if (!body.direction || !["outbound", "inbound"].includes(body.direction)) {
    return json({ error: "direction must be 'outbound' or 'inbound'" }, 400);
  }
  const contactType = body.contact_type || "email";
  if (!Object.keys(CONTACT_TYPES).includes(contactType)) return json({ error: "contact_type must be one of " + Object.keys(CONTACT_TYPES).join(", ") }, 400);
  const note = String(body.body || "").trim();
  if (contactType !== "email" && note.length < 3) return json({ error: "note_required", detail: "Add a short note on what was discussed." }, 400);
  const subject = body.subject || (contactType === "email" ? null : CONTACT_TYPES[contactType]);
  const [email] = await sql`
    insert into bid_emails (bid_id, company_id, direction, subject, from_address, to_addresses, cc_addresses, body, sent_at, logged_by, source, contact_type, spoke_with)
    values (${bidId}, ${bidRows[0].company_id}, ${body.direction}, ${subject}, ${body.from_address || null}, ${body.to_addresses || null}, ${body.cc_addresses || null}, ${contactType === "email" ? body.body || null : note}, ${body.sent_at || new Date().toISOString()}, ${user.username}, ${body.source || "manual"}, ${contactType}, ${body.spoke_with ? String(body.spoke_with).slice(0, 200) : null})
    returning *`;

  // A follow-up just happened — reset the cadence clock rather than waiting
  // for it to lapse again on its own. Inbound (a client wrote back) counts too.
  // The exception is a date the owner set deliberately at the client's request
  // and that is still ahead: logging a contact doesn't pull that back.
  const settings = await getCrmSettings(sql);
  const current = bidRows[0].next_action_date ? dayOf(bidRows[0].next_action_date) : null;
  const [lastSet] = await sql`select to_date from bid_followup_events where bid_id = ${bidId} and kind = 'postpone' order by created_at desc limit 1`;
  const keepDeliberate = current && lastSet && dayOf(lastSet.to_date) === current && current > todayIso();
  const next = keepDeliberate ? current : autoFollowUpDate(settings.cadence, bidRows[0].stage, null, { force: true });
  await sql`update bids set next_action_date = ${next}, updated_at = now() where id = ${bidId}`;

  return json({ email }, 201);
}

// An owner moves a bid's follow-up date because the client asked (Ben, 2026-10-26). A reason is
// required and every change is recorded with who made it, so repeated postponing is visible to the
// follow-up manager.
async function handleFollowupDateSet(bidId, request, sql, user) {
  const body = await parseBody(request);
  const [bid] = await sql`select id, next_action_date, stage from bids where id = ${bidId}`;
  if (!bid) return json({ error: "bid_not_found" }, 404);
  const denied = bidAccessDenied(user, bid);
  if (denied) return denied;
  const date = String(body.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(date + "T00:00:00Z").getTime())) return json({ error: "date must be YYYY-MM-DD" }, 400);
  if (date < todayIso()) return json({ error: "date_in_past", detail: "Pick today or a later date." }, 400);
  const reason = String(body.reason || "").trim();
  if (reason.length < 3) return json({ error: "reason_required", detail: "Add a short reason, for example what the client asked for." }, 400);
  if (["complete", "lost", "no_bid"].includes(bid.stage)) return json({ error: "closed_bid", detail: "This bid is closed, so it has no follow-up date." }, 400);
  await sql`update bids set next_action_date = ${date}, updated_at = now() where id = ${bidId}`;
  await sql`insert into bid_followup_events (bid_id, kind, from_date, to_date, reason, by_username) values (${bidId}, 'postpone', ${bid.next_action_date ? dayOf(bid.next_action_date) : null}, ${date}, ${reason.slice(0, 500)}, ${user.username})`;
  return json({ ok: true, next_action_date: date });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

async function handleNotificationsList(url, sql, user) {
  const status = url.searchParams.get("status") || "pending";
  const all = await sql`
    select n.*, b.project_name, b.rfq_ref, b.owner_username, c.name as company_name
    from notifications n
    left join bids b on b.id = n.bid_id
    left join companies c on c.id = coalesce(n.company_id, b.company_id)
    where n.status = ${status}
    order by n.created_at desc limit 200`;
  const rows = canSeeAllBids(user) ? all : all.filter((n) => n.owner_username === user.username);
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
  // A PM only ever gets their own; so does anyone without the follow-up
  // manager capability who didn't ask for everything (estimators keep the
  // "My bids only" toggle they had).
  const mine = url.searchParams.get("mine") === "1" || !canSeeAllBids(user);
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
    const nowArchived = Boolean(row.archived);
    if (!stageChanged && row.status === bid.source_status && !archivedChanged) continue;

    const [after] = await sql`
      update bids set
        stage = ${stageKnown ? newStage : bid.stage},
        source_status = ${row.status || null},
        source_archived = ${Boolean(row.archived)},
        next_action_date = ${stageChanged ? autoFollowUpDate(settings.cadence, newStage, bid.next_action_date) : bid.next_action_date},
        handoff_triggered_at = ${stageChanged && newStage === "complete" ? bid.handoff_triggered_at || new Date().toISOString() : bid.handoff_triggered_at},
        handoff_status = ${stageChanged && newStage === "complete" ? bid.handoff_status || "pending" : bid.handoff_status},
        decided_at = ${stageChanged ? (newStage === "complete" || newStage === "lost" ? new Date().toISOString() : null) : bid.decided_at},
        archived_at = ${nowArchived === bid.source_archived ? bid.archived_at : nowArchived ? new Date().toISOString() : null},
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
    all_bids: canSeeAllBids(user),
    followup_dashboard: canSeeFollowupDashboard(user),
    followup_rules_direct: canEditRulesDirectly(user),
    followup_manager: isFollowupManager(user),
    campaign_manager: hasCap(user, "campaign_manager"),
  };
  try {
    const people = (await eligibleAssignees(env, user)).map((p) => ({
      username: p.username,
      displayName: p.displayName,
      level: p.level,
      jobRole: p.jobRole || null,
      department: p.department || null,
      procoreUser: p.procoreUser || null,
    }));
    return json({ mode: c.mode, level: c.level, can, caps: user._caps || [], people });
  } catch (e) {
    return json({ mode: c.mode, level: c.level, can, caps: user._caps || [], people: [], people_error: e.message });
  }
}

// Admin-only: who has which extra capability. GET also lists everyone with
// CRM access (from auth-worker) so the Access tab can show a row per person.
async function handleGrantsGet(env, sql, user) {
  if (!isCrmAdmin(user)) return forbidden("Admin access required.");
  let people = [];
  try { people = (await getCrmPeople(env, user)).map((p) => ({ username: p.username, displayName: p.displayName, level: p.level })); } catch (e) { /* list stays empty */ }
  grantsCache.at = 0;
  return json({ caps: CRM_CAPS, grants: await loadGrants(sql), people });
}
async function handleGrantsPatch(request, sql, user) {
  if (!isCrmAdmin(user)) return forbidden("Admin access required.");
  const body = await parseBody(request);
  if (!body.username || !Array.isArray(body.caps)) return json({ error: "username and caps[] are required" }, 400);
  const caps = body.caps.filter((c) => CRM_CAPS.includes(c));
  const grants = { ...(await loadGrants(sql)) };
  if (caps.length) grants[body.username] = caps; else delete grants[body.username];
  await sql`update crm_settings set grants = ${JSON.stringify(grants)}::jsonb, updated_at = now(), updated_by = ${user.username} where singleton = 1`;
  grantsCache.at = 0;
  return json({ grants });
}

async function handleSettingsGet(sql) {
  return json(await getCrmSettings(sql));
}

async function handleSettingsPatch(request, sql, user) {
  // The cadence belongs to the follow-up managers as well as admins (Ben, 2026-10-26).
  if (!isCrmAdmin(user) && !isFollowupManager(user)) return forbidden("Only admins and follow-up managers can change the follow-up cadence.");
  const body = await parseBody(request);
  const current = await getCrmSettings(sql);
  let cadence = current.cadence;
  if (body.followup_cadence_days !== undefined) {
    const incoming = body.followup_cadence_days;
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return json({ error: "followup_cadence_days must be an object of stage: days" }, 400);
    cadence = { ...current.cadence };
    for (const stage of Object.keys(DEFAULT_CADENCE_DAYS)) {
      if (incoming[stage] === undefined) continue;
      const days = Number(incoming[stage]);
      if (!Number.isInteger(days) || days < 0 || days > 90) return json({ error: "bad_cadence", detail: `${stage}: days must be a whole number from 0 to 90 (0 means no follow-up).` }, 400);
      cadence[stage] = days;
    }
  }
  await sql`
    update crm_settings set
      followup_cadence_days = ${JSON.stringify(cadence)}::jsonb,
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

// Self-applied migrations (no separate manual migrate step after a deploy).
// Each entry runs once; the ids it has run are recorded in crm_schema_applied,
// so every later cold start costs one cheap query. Statements must be
// idempotent — two isolates can race on the first run.
const SELF_MIGRATIONS = [
  {
    id: "009_decided_at",
    statements: [
      `alter table bids add column if not exists decided_at timestamptz`,
      `alter table bids add column if not exists archived_at timestamptz`,
      `update bids b set decided_at = h.t
         from (select bid_id, to_stage, max(changed_at) as t from bid_stage_history
               where changed_by != 'system' group by bid_id, to_stage) h
         where h.bid_id = b.id and h.to_stage = b.stage and b.stage in ('complete', 'lost') and b.decided_at is null`,
    ],
  },
  {
    // Extra CRM capabilities on top of the Einbau ID level (admin/estimator/pm):
    // { "<username>": ["followup_manager", "campaign_manager"] }
    id: "010_grants",
    statements: [`alter table crm_settings add column if not exists grants jsonb not null default '{}'::jsonb`],
  },
];
SELF_MIGRATIONS.push({
  // The Procore project-region list (Einbau branches), copied from HANDOFF's
  // live read so every region pick in CRM is a dropdown of the same names.
  id: "011_regions",
  statements: [`create table if not exists regions (
    id text primary key,
    name text not null,
    active boolean not null default true,
    updated_at timestamptz not null default now()
  )`],
});
SELF_MIGRATIONS.push({
  // What SCOUT can now tell CRM about a decision (Ben, 2026-10-15): who approved
  // an override and which disqualifiers fired. override_reason already existed.
  id: "012_scout_override_fields",
  statements: [
    `alter table bids add column if not exists override_approver text`,
    `alter table bids add column if not exists disqualifiers jsonb not null default '[]'::jsonb`,
  ],
});
SELF_MIGRATIONS.push({
  // Customer payment scores pushed by netsuite-worker (computed there, once).
  // CRM only stores and shows what it receives — it never recomputes a score.
  id: "013_company_payment_scores",
  statements: [`create table if not exists company_payment_scores (
    company_id uuid primary key references companies(id) on delete cascade,
    ns_customer_id text,
    ns_name text,
    status text,
    score numeric,
    score_18m numeric,
    score_6m numeric,
    judged_invoices integer,
    avg_days_past_terms_18m numeric,
    avg_days_past_terms_6m numeric,
    late_pct numeric,
    credit_pct numeric,
    credit_memos_per_invoice numeric,
    overdue_days numeric,
    calc_date text,
    received_at timestamptz not null default now()
  )`],
});
SELF_MIGRATIONS.push({
  // One row per SCOUT push (or imported SCOUT/manual-sheet row), never
  // overwritten, with SCOUT's complete record kept verbatim in `payload` so
  // nothing SCOUT knew is lost (Ben, 2026-10-16: "all fields"). The columns are
  // just the commonly used parts pulled out for queries and the stats tab.
  id: "014_scout_runs",
  statements: [
    `create table if not exists scout_runs (
      id uuid primary key default gen_random_uuid(),
      bid_id uuid references bids(id) on delete set null,
      rfq_ref text,
      source text not null default 'push',      -- push | import:excel_log | import:manual_sheet
      outcome text,                             -- submitted | declined
      submitted_at timestamptz,
      received_at timestamptz not null default now(),
      client text,
      project_name text,
      tier text,
      total_score numeric,
      section_scores jsonb,
      scoring jsonb,
      scoring_labels jsonb,
      disqualifiers jsonb not null default '[]'::jsonb,
      override_reason text,
      override_approver text,
      estimator text,
      notes text,
      risks text,
      copilot_summary text,
      push_to_bid boolean,
      ns_opportunity_id text,
      procore_bid_id text,
      thresholds jsonb,
      payload jsonb not null
    )`,
    `create index if not exists scout_runs_bid_idx on scout_runs (bid_id)`,
    `create index if not exists scout_runs_rfq_idx on scout_runs (rfq_ref)`,
  ],
});
SELF_MIGRATIONS.push({
  id: "015_netsuite_company_sync",
  statements: [
    `create table if not exists crm_kv (key text primary key, value jsonb not null, updated_at timestamptz not null default now())`,
    `create table if not exists ns_sync_runs (
      id uuid primary key default gen_random_uuid(),
      created_at timestamptz not null default now(),
      created_by text,
      auto boolean not null default false,
      summary jsonb
    )`,
    `create table if not exists ns_sync_ops (
      id uuid primary key default gen_random_uuid(),
      run_id uuid not null references ns_sync_runs(id) on delete cascade,
      op text not null,                 -- link | create | review | ambiguous
      ns_id text,
      ns_name text,
      company_id uuid,
      company_name text,
      procore_id text,
      notes text,
      status text not null default 'pending',   -- pending | applied | skipped
      detail text
    )`,
    `create index if not exists ns_sync_ops_run_idx on ns_sync_ops (run_id, op, status)`,
    `create index if not exists companies_netsuite_id_idx on companies (netsuite_customer_id)`,
  ],
});
SELF_MIGRATIONS.push({
  id: "016_company_merge",
  statements: [
    // Other spellings of a company that was merged away, so the same typed name on a
    // later SCOUT/Procore bid resolves to the survivor instead of recreating it.
    `create table if not exists company_aliases (
      alias_norm text primary key,
      company_id uuid not null references companies(id) on delete cascade,
      alias_name text,
      created_at timestamptz not null default now()
    )`,
    // Audit trail of every merge, with a snapshot of the removed company.
    `create table if not exists company_merges (
      id uuid primary key default gen_random_uuid(),
      kept_id uuid,
      kept_name text,
      merged_id uuid,
      merged_name text,
      merged_snapshot jsonb,
      moved jsonb,
      merged_by text,
      merged_at timestamptz not null default now()
    )`,
  ],
});
SELF_MIGRATIONS.push({
  id: "017_company_address",
  statements: [
    `alter table companies add column if not exists address_line1 text`,
    `alter table companies add column if not exists address_line2 text`,
    `alter table companies add column if not exists city text`,
    `alter table companies add column if not exists province text`,
    `alter table companies add column if not exists postal_code text`,
    `alter table companies add column if not exists country text`,
    `alter table companies add column if not exists website text`,
    `create index if not exists contacts_company_email_idx on contacts (company_id, lower(email))`,
  ],
});
SELF_MIGRATIONS.push({
  id: "018_scout_runs_import",
  statements: [
    `alter table scout_runs add column if not exists ext_key text`,
    `alter table scout_runs add column if not exists excluded boolean not null default false`,
    `create unique index if not exists scout_runs_ext_key_idx on scout_runs (ext_key) where ext_key is not null`,
  ],
});
SELF_MIGRATIONS.push({
  id: "019_scout_runs_company",
  statements: [
    `alter table scout_runs add column if not exists company_id uuid references companies(id) on delete set null`,
    `create index if not exists scout_runs_company_idx on scout_runs (company_id)`,
  ],
});
SELF_MIGRATIONS.push({
  // Project money from LEDGER (pushed): contract, approved change orders, invoiced, paid.
  // Keyed on the Procore project id as TEXT (15 digits, never a JS number).
  id: "020_project_financials",
  statements: [`create table if not exists project_financials (
    procore_project_id text primary key,
    project_name text,
    contract_value numeric,
    approved_change_orders numeric,
    revised_contract numeric,
    invoiced_to_date numeric,
    paid_to_date numeric,
    currency text,
    as_of timestamptz,
    received_at timestamptz not null default now()
  )`],
});
SELF_MIGRATIONS.push({
  // Blacklist as one admin-only checkbox with a reason, permanent priority clients, and the
  // admin review queue (declined priority-client RFQs). Ben, 2026-10-21.
  id: "021_blacklist_priority_queue",
  statements: [
    `alter table companies add column if not exists blacklisted boolean not null default false`,
    `alter table companies add column if not exists blacklist_reason text`,
    `alter table companies add column if not exists blacklisted_by text`,
    `alter table companies add column if not exists blacklisted_at timestamptz`,
    `alter table companies add column if not exists priority_permanent boolean not null default false`,
    // Anything already designated Do Not Pursue / Do Not Work With becomes blacklisted.
    `update companies set blacklisted = true, blacklisted_at = coalesce(blacklisted_at, now()),
        blacklist_reason = coalesce(blacklist_reason, 'Was designated ' || replace(initcap(replace(account_segment, '_', ' ')), '_', ' ') || ' before the blacklist checkbox')
      where account_segment in ('do_not_pursue', 'do_not_work_with') and not blacklisted`,
    `create table if not exists review_queue (
      id uuid primary key default gen_random_uuid(),
      kind text not null,                       -- priority_declined
      company_id uuid references companies(id) on delete set null,
      rfq_ref text,
      project_name text,
      reason text,
      actor text,                               -- who declined it
      status text not null default 'open',      -- open | done
      resolved_by text,
      resolved_at timestamptz,
      resolution_note text,
      created_at timestamptz not null default now()
    )`,
    `create unique index if not exists review_queue_kind_rfq_idx on review_queue (kind, rfq_ref) where rfq_ref is not null`,
  ],
});
SELF_MIGRATIONS.push({
  id: "022_followup_rules",
  statements: [
    `create table if not exists followup_rules (
      id uuid primary key default gen_random_uuid(),
      position int not null default 0,
      kind text not null check (kind in ('client', 'region', 'province', 'relationship', 'balance')),
      company_id uuid references companies(id) on delete cascade,
      value text,                               -- region name or 2-letter province code
      assignee_username text,                   -- client / region / province rules
      pool jsonb not null default '[]'::jsonb,  -- balance rules: usernames to spread across
      active boolean not null default true,
      note text,
      updated_by text,
      updated_at timestamptz not null default now()
    )`,
  ],
});
// Other ways of contacting a client besides email (Ben, 2026-10-26), and a record of each time an owner
// deliberately moves a bid's follow-up date at the client's request.
SELF_MIGRATIONS.push({
  id: "023_contact_types_followup_events",
  statements: [
    `alter table bid_emails add column if not exists contact_type text not null default 'email'`,
    `alter table bid_emails add column if not exists spoke_with text`,
    `alter table bid_emails drop constraint if exists bid_emails_contact_type_check`,
    `alter table bid_emails add constraint bid_emails_contact_type_check check (contact_type in ('email', 'call', 'meeting', 'text', 'other'))`,
    `create table if not exists bid_followup_events (
      id uuid primary key default gen_random_uuid(),
      bid_id uuid not null references bids(id) on delete cascade,
      kind text not null default 'postpone',
      from_date date,
      to_date date,
      reason text,
      by_username text,
      created_at timestamptz not null default now()
    )`,
    `create index if not exists bid_followup_events_bid on bid_followup_events (bid_id, created_at desc)`,
  ],
});
let schemaReady = null;
function ensureSchema(sql) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await sql.query(`create table if not exists crm_schema_applied (id text primary key, applied_at timestamptz not null default now())`);
      const done = new Set((await sql`select id from crm_schema_applied`).map((r) => r.id));
      for (const m of SELF_MIGRATIONS) {
        if (done.has(m.id)) continue;
        for (const stmt of m.statements) await sql.query(stmt);
        await sql`insert into crm_schema_applied (id) values (${m.id}) on conflict do nothing`;
      }
    })().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
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
function rangeBounds(range, { from, to } = {}) {
  // Custom range (Ben, 2026-10-07): inclusive calendar dates from the date
  // pickers, YYYY-MM-DD. Falls back to all-time on a bad value rather than erroring.
  if (range === "custom") {
    const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "") && !Number.isNaN(new Date(d + "T00:00:00Z").getTime());
    if (ok(from) || ok(to)) {
      const start = ok(from) ? new Date(from + "T00:00:00Z") : new Date(0);
      const end = ok(to) ? new Date(new Date(to + "T00:00:00Z").getTime() + 86400000) : new Date("9999-12-31T00:00:00Z");
      return { start, end };
    }
  }
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

async function handleDashboardSummary(sql, range, { includeArchived = INCLUDE_ARCHIVED_IN_WIN_RATES, from, to } = {}) {
  const bounds = rangeBounds(range, { from, to });
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
      (b.rfq_ref not like 'PROCORE-%') as via_scout, b.scout_tier,
      (b.decided_at is not null) as decision_recorded,
      case when b.stage in ('complete', 'lost') then coalesce(b.decided_at,
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
  // SCOUT prequalifier results (Ben, 2026-10-07): bids whose RFQ ref was minted
  // by SCOUT/CRM (everything else is a Procore-board original) against the rest,
  // and by the tier SCOUT gave them — same decided/still-open rules as above.
  const scoutAll = blank();
  const scoutOthers = blank(); // not via SCOUT, created on/after the first SCOUT bid
  const scoutBefore = blank(); // not via SCOUT, created before SCOUT started
  const scoutTiers = new Map();
  let scoutSince = null;
  for (const r of popRows) {
    if (r.via_scout) { const t = new Date(r.created_at).getTime(); if (scoutSince == null || t < scoutSince) scoutSince = t; }
  }
  for (const r of popRows) {
    const aggs = [pcRow];
    if (r.via_scout) {
      aggs.push(scoutAll);
      const tier = r.scout_tier || "untiered";
      if (!scoutTiers.has(tier)) scoutTiers.set(tier, blank());
      aggs.push(scoutTiers.get(tier));
    } else {
      aggs.push(scoutSince != null && new Date(r.created_at).getTime() < scoutSince ? scoutBefore : scoutOthers);
    }
    if (r.company_id) aggs.push(perCompany.get(r.company_id) || perCompany.set(r.company_id, blank()).get(r.company_id));
    const add = (kind, value, valued) => {
      for (const agg of aggs) {
        agg[kind + "_count"] += 1;
        agg[kind + "_value"] += value || 0;
        if (valued && value != null) agg[kind + "_valued_count"] += 1;
      }
    };
    if (inRange(r.created_at)) add("created", num(r.estimated_value), false);
    // Archived bids stay out unless CRM itself recorded the win/loss while the
    // bid was still live (Ben, 2026-10-06) — decided_at is only ever set by a
    // real move, never by the historical backfill.
    if (r.source_archived && !includeArchived && !r.decision_recorded) continue;
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

  const scoutStats = (a) => ({
    created: a.created_count,
    won: a.complete_count,
    lost: a.lost_count,
    open: a.midlate_count,
    won_value: a.complete_value,
    lost_value: a.lost_value,
    decided_win_rate: a.complete_count + a.lost_count > 0 ? a.complete_count / (a.complete_count + a.lost_count) : null,
    pipeline_win_rate: a.complete_count + a.lost_count + a.midlate_count > 0 ? a.complete_count / (a.complete_count + a.lost_count + a.midlate_count) : null,
    decided_win_rate_value: a.complete_value + a.lost_value > 0 ? a.complete_value / (a.complete_value + a.lost_value) : null,
  });
  const scout = {
    since: scoutSince ? new Date(scoutSince).toISOString() : null,
    all: scoutStats(scoutAll),
    others: scoutStats(scoutOthers),
    before: scoutStats(scoutBefore),
    tiers: Object.fromEntries([...scoutTiers.entries()].map(([k, v]) => [k, scoutStats(v)])),
  };

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
    select count(*)::int as count from bid_emails where (direction = 'outbound' or contact_type <> 'email') and sent_at >= ${cutoffIso} and sent_at < ${endIso}`;

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
    scout,
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
    where hot_lead = true and not priority_permanent and hot_lead_set_at < now() - interval '30 days'
      and id not in (select company_id from notifications where type = 'hot_lead_expiring' and status = 'pending')`;
  for (const company of expiringSoon) {
    await sql`insert into notifications (company_id, type, message)
      values (${company.id}, 'hot_lead_expiring', ${`🔥 "${company.name}" has been a priority client for 30+ days — renew it, make it permanent, or let it expire.`})`;
  }

  const autoExpired = await sql`
    update companies set hot_lead = false, hot_lead_reason = coalesce(hot_lead_reason, '') || ' (auto-expired after 37 days unrenewed)'
    where hot_lead = true and not priority_permanent and hot_lead_set_at < now() - interval '37 days'
    returning id`;

  return { flagged_overdue: overdue.length, flagged_no_owner: noOwner.length, flagged_hot_lead_expiring: expiringSoon.length, auto_expired_hot_leads: autoExpired.length };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const res = await handleRequest(request, env);
    if (request.method !== "OPTIONS" && (res.status === 401 || res.status === 403 || res.status === 429)) reportRefusal(request, env, ctx, res.status);
    return res;
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runStalenessSweep(env));
    ctx.waitUntil((async () => { try { await nsSyncNightly(env, sqlFor(env)); } catch (e) { console.log("netsuite sync failed:", e.message); } })());
    ctx.waitUntil((async () => { try { await ensureSchema(sqlFor(env)); await refreshRegions(env, sqlFor(env)); } catch (e) { console.log("region refresh failed:", e.message); } })());
  },
};

async function handleRequest(request, env) {
  {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

    const url = new URL(request.url);
    const sql = sqlFor(env);
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      await ensureSchema(sql).catch((e) => console.error("ensureSchema failed", e));
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
      if (url.pathname === "/internal/project-financials" && request.method === "POST") {
        if (!isFinanceCaller(request, env)) return json({ error: "unauthorized" }, 401);
        return await handleFinancialsPush(request, sql);
      }
      if (url.pathname === "/internal/payment-scores" && request.method === "POST") {
        if (!isPayscoreCaller(request, env)) return json({ error: "unauthorized" }, 401);
        return await handlePaymentScoresPush(request, sql);
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

      await attachCaps(sql, auth.user);
      const refresh = auth.refreshedToken ? { "X-Refreshed-Token": auth.refreshedToken } : {};
      const withRefresh = (res) => {
        for (const [k, v] of Object.entries(refresh)) res.headers.set(k, v);
        return res;
      };

      if (url.pathname === "/rfq-ids/mint" && request.method === "POST") return withRefresh(await handleMintRfqRef(sql, auth.user));

      if (parts[0] === "companies" || parts[0] === "contacts") {
        const denied = scopeDenied(auth.user);
        if (denied) return withRefresh(denied);
      }
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
        if (parts.length === 1 && request.method === "GET") return withRefresh(await handleBidsList(url, sql, auth.user));
        if (isUuid(parts[1]) && !parts[2] && request.method === "GET") return withRefresh(await handleBidDetail(parts[1], sql, auth.user));
        if (isUuid(parts[1]) && !parts[2] && request.method === "PATCH") return withRefresh(await handleBidPatch(parts[1], request, sql, env, auth.user));
        if (isUuid(parts[1]) && parts[2] === "stage" && request.method === "POST") return withRefresh(await handleBidStageChange(parts[1], request, sql, env, auth.user));
        if (isUuid(parts[1]) && parts[2] === "emails" && request.method === "GET") return withRefresh(await handleEmailsList(parts[1], sql, auth.user));
        if (isUuid(parts[1]) && parts[2] === "emails" && request.method === "POST") return withRefresh(await handleEmailCreate(parts[1], request, sql, auth.user));
        if (isUuid(parts[1]) && parts[2] === "followup-date" && request.method === "POST") return withRefresh(await handleFollowupDateSet(parts[1], request, sql, auth.user));
      }

      if (parts[0] === "notifications") {
        if (parts.length === 1 && request.method === "GET") return withRefresh(await handleNotificationsList(url, sql, auth.user));
        if (isUuid(parts[1]) && parts[2] === "ack" && request.method === "POST") return withRefresh(await handleNotificationAck(parts[1], sql, auth.user));
      }

      if (url.pathname === "/followups" && request.method === "GET") return withRefresh(await handleFollowupsList(url, sql, auth.user));

      if (url.pathname === "/access" && request.method === "GET") return withRefresh(await handleAccess(env, auth.user));
      if (url.pathname === "/scout/financials/refresh" && request.method === "POST") return withRefresh(await handleFinancialsRefresh(request, env, sql, auth.user));
      if (url.pathname === "/scout/stats" && request.method === "GET") return withRefresh(await handleScoutStats(url, sql));
      if (url.pathname.startsWith("/admin/review")) return withRefresh(await handleAdminReview(request, url, sql, auth.user));
      if (url.pathname.startsWith("/admin/scout-unlinked")) return withRefresh(await handleScoutUnlinked(request, url, sql, auth.user));
      if (url.pathname.startsWith("/admin/scout-import") && request.method === "POST") return withRefresh(await handleScoutImport(request, url, sql, auth.user));
      if (url.pathname.startsWith("/admin/contacts-import") && request.method === "POST") return withRefresh(await handleContactsImport(request, url, sql, auth.user));
      if (url.pathname.startsWith("/admin/companies/merge")) return withRefresh(await handleCompanyMerge(request, url, sql, auth.user));
      if (url.pathname.startsWith("/admin/netsuite-sync")) return withRefresh(await handleNsSyncRoute(request, url, sql, env, auth.user));
      if (url.pathname === "/followups/dashboard" && request.method === "GET") return withRefresh(await handleFollowupDashboard(env, sql, auth.user));
      if (url.pathname === "/followups/bulk-assign" && request.method === "POST") return withRefresh(await handleBulkAssign(request, env, sql, auth.user));
      if (url.pathname.startsWith("/followups/rules")) return withRefresh(await handleFollowupRules(request, url, env, sql, auth.user));
      if (url.pathname === "/regions" && request.method === "GET") return withRefresh(await handleRegionsList(env, sql));
      if (url.pathname === "/grants" && request.method === "GET") return withRefresh(await handleGrantsGet(env, sql, auth.user));
      if (url.pathname === "/grants" && request.method === "PATCH") return withRefresh(await handleGrantsPatch(request, sql, auth.user));
      if (url.pathname === "/settings" && request.method === "GET") return withRefresh(await handleSettingsGet(sql));
      if (url.pathname === "/settings" && request.method === "PATCH") return withRefresh(await handleSettingsPatch(request, sql, auth.user));

      if (url.pathname === "/dashboard/summary" && request.method === "GET") return withRefresh(await handleDashboardSummary(sql, url.searchParams.get("range"), { from: url.searchParams.get("from"), to: url.searchParams.get("to") }));

      return withRefresh(json({ error: "not_found" }, 404));
    } catch (e) {
      return json({ error: "internal_error", detail: e.message }, 500);
    }
  }
}
