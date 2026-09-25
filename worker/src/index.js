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
//   GET    /dashboard/summary           (Einbau ID) pipeline-by-stage, aging, win-rate aggregates
//   scheduled (cron 0 13 * * *)         flag stale/ownerless/actionless open bids into notifications
//
// Secrets: DATABASE_URL, CRM_SERVICE_KEY, NETSUITE_SERVICE_KEY
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

    // Per-app access list from HELM (auth-worker/README.md). Absent apps =
    // unrestricted (every user today) — only deny when it's a present array
    // that doesn't include "CRM".
    if (data.user.apps !== undefined) {
      const apps = Array.isArray(data.user.apps) ? data.user.apps : [];
      if (!apps.includes("CRM")) {
        return { ok: false, reason: `"${data.user.username}" doesn't have CRM access (HELM apps list).` };
      }
    }

    const allowedRoles = String(env.ALLOWED_ROLES || "admin,user").split(",").map((r) => r.trim());
    if (!allowedRoles.includes(data.user.role)) {
      return { ok: false, reason: `Logged in as "${data.user.username}" (role "${data.user.role}"), which isn't allowed in CRM.` };
    }
    return { ok: true, user: data.user, refreshedToken: data.refreshedToken || null };
  } catch (e) {
    return { ok: false, reason: `Couldn't reach auth-worker: ${e.message}` };
  }
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
const STAGES = [
  "invitation", "accepted", "estimating", "bid_submitted", "to_do",
  "delayed", "in_progress", "lost", "complete", "no_bid",
];

// Procore's own display labels for each raw stage key (Einbau's instance,
// confirmed live via /estimating/settings — see kickoff prompt). `no_bid`
// has no Procore equivalent; label is CRM's own.
const PROCORE_STAGE_LABELS = {
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
  const { rfq_ref, project_name, company_name, procore_vendor_id, contact, qualification_result, scout_score, scout_tier, hot_lead_applied, no_bid_reason, bid_due_date } = body;
  if (!rfq_ref) return json({ error: "rfq_ref is required" }, 400);
  if (!project_name) return json({ error: "project_name is required" }, 400);
  if (!company_name) return json({ error: "company_name is required" }, 400);

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

  const initialStage = qualification_result === "no_bid" ? "no_bid" : "invitation";

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
        updated_at = now()
      where id = ${existingBid[0].id}
      returning *`;
  } else {
    [bid] = await sql`
      insert into bids (
        rfq_ref, project_name, company_id, contact_id, qualification_result,
        scout_score, scout_tier, hot_lead_applied, no_bid_reason, bid_due_date, stage
      ) values (
        ${rfq_ref}, ${project_name}, ${company.id}, ${contactRow ? contactRow.id : null}, ${qualification_result || "pending_review"},
        ${scout_score ?? null}, ${scout_tier ?? null}, ${Boolean(hot_lead_applied)}, ${no_bid_reason ?? null}, ${bid_due_date ?? null}, ${initialStage}
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
  const rows = q
    ? segment
      ? await sql`select * from companies where lower(name) like ${"%" + q.toLowerCase() + "%"} and account_segment = ${segment} order by name limit 200`
      : await sql`select * from companies where lower(name) like ${"%" + q.toLowerCase() + "%"} order by name limit 200`
    : segment
      ? await sql`select * from companies where account_segment = ${segment} order by name limit 200`
      : await sql`select * from companies order by name limit 200`;
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
  const existing = await sql`select * from companies where id = ${id}`;
  if (!existing.length) return json({ error: "not_found" }, 404);

  const fields = Object.keys(body).filter((k) => COMPANY_PATCHABLE.includes(k));
  if (!fields.length) return json({ error: "no_valid_fields", detail: `Patchable fields: ${COMPANY_PATCHABLE.join(", ")}` }, 400);

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
  const rows = await sql`
    select b.*, c.name as company_name, c.hot_lead as company_hot_lead
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
    select b.*, c.name as company_name from bids b left join companies c on c.id = b.company_id where b.id = ${id}`;
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

async function handleBidPatch(id, request, sql) {
  const body = await parseBody(request);
  const existing = await sql`select * from bids where id = ${id}`;
  if (!existing.length) return json({ error: "not_found" }, 404);
  const fields = Object.keys(body).filter((k) => BID_PATCHABLE.includes(k));
  if (!fields.length) return json({ error: "no_valid_fields", detail: `Patchable fields: ${BID_PATCHABLE.join(", ")}` }, 400);
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

async function handleBidStageChange(id, request, sql, user) {
  const body = await parseBody(request);
  const { to_stage } = body;
  if (!to_stage) return json({ error: "to_stage is required" }, 400);

  const existing = await sql`select * from bids where id = ${id}`;
  if (!existing.length) return json({ error: "not_found" }, 404);
  const bid = existing[0];

  const validation = validateStageTransition(bid, to_stage, body);
  if (validation.badStage) return json({ error: "unknown_stage", detail: `"${to_stage}" isn't a recognized stage.` }, 400);
  if (!validation.ok) return json({ error: "missing_required_fields", missing: validation.missing }, 422);

  const merged = { ...bid, ...body, stage: to_stage };
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
  const bidRows = await sql`select company_id from bids where id = ${bidId}`;
  if (!bidRows.length) return json({ error: "bid_not_found" }, 404);
  if (!body.direction || !["outbound", "inbound"].includes(body.direction)) {
    return json({ error: "direction must be 'outbound' or 'inbound'" }, 400);
  }
  const [email] = await sql`
    insert into bid_emails (bid_id, company_id, direction, subject, from_address, to_addresses, cc_addresses, body, sent_at, logged_by)
    values (${bidId}, ${bidRows[0].company_id}, ${body.direction}, ${body.subject || null}, ${body.from_address || null}, ${body.to_addresses || null}, ${body.cc_addresses || null}, ${body.body || null}, ${body.sent_at || new Date().toISOString()}, ${user.username})
    returning *`;
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
// Dashboard
// ---------------------------------------------------------------------------

// 'all' | 'year' | 'quarter' | 'month' -> a real cutoff Date, computed
// server-side so the client just sends a keyword, not a date it has to get
// right. Filters on `created_at`, which for backfilled bids is the bid's
// real historical Procore creation date, not the date it was imported.
function rangeCutoffDate(range) {
  const now = new Date();
  if (range === "month") return new Date(now.getFullYear(), now.getMonth(), 1);
  if (range === "quarter") return new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  if (range === "year") return new Date(now.getFullYear(), 0, 1);
  return new Date(0); // 'all' or anything unrecognized
}

async function handleDashboardSummary(sql, range) {
  const cutoffIso = rangeCutoffDate(range).toISOString();

  const byStage = await sql`select stage, count(*)::int as count, coalesce(sum(estimated_value),0)::float as pipeline_value from bids where created_at >= ${cutoffIso} group by stage`;

  const winRateRows = await sql`
    select
      count(*) filter (where stage = 'complete')::int as won,
      count(*) filter (where stage = 'lost')::int as lost,
      coalesce(sum(estimated_value) filter (where stage = 'complete'),0)::float as won_value,
      coalesce(sum(estimated_value) filter (where stage = 'lost'),0)::float as lost_value
    from bids where created_at >= ${cutoffIso}`;
  const aging = await sql`
    select count(*)::int as overdue_count
    from bids
    where stage not in ('complete', 'lost', 'no_bid') and created_at >= ${cutoffIso}
      and next_action_date is not null and next_action_date < current_date`;
  const hotLeads = await sql`select count(*)::int as hot_lead_count from companies where hot_lead = true`;
  const totals = await sql`select count(*)::int as total_bids, coalesce(avg(estimated_value),0)::float as avg_bid_value from bids where created_at >= ${cutoffIso}`;

  // Top 10 companies by total bid value in range — a quick "who matters most" view.
  const byCompany = await sql`
    select c.id, c.name,
      count(b.id)::int as bid_count,
      coalesce(sum(b.estimated_value),0)::float as total_value,
      count(*) filter (where b.stage = 'complete')::int as won_count
    from companies c join bids b on b.company_id = c.id
    where b.created_at >= ${cutoffIso}
    group by c.id, c.name
    order by total_value desc
    limit 10`;

  // Region rollup — region lives on companies, not bids, hence the join.
  const byRegion = await sql`
    select coalesce(c.region, 'Unspecified') as region,
      count(b.id)::int as bid_count,
      coalesce(sum(b.estimated_value),0)::float as total_value,
      count(*) filter (where b.stage = 'complete')::int as won_count,
      count(*) filter (where b.stage = 'lost')::int as lost_count
    from bids b left join companies c on c.id = b.company_id
    where b.created_at >= ${cutoffIso}
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
    overdue_followups: aging[0]?.overdue_count || 0,
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
        if (isUuid(parts[1]) && !parts[2] && request.method === "PATCH") return withRefresh(await handleBidPatch(parts[1], request, sql));
        if (isUuid(parts[1]) && parts[2] === "stage" && request.method === "POST") return withRefresh(await handleBidStageChange(parts[1], request, sql, auth.user));
        if (isUuid(parts[1]) && parts[2] === "emails" && request.method === "GET") return withRefresh(await handleEmailsList(parts[1], sql));
        if (isUuid(parts[1]) && parts[2] === "emails" && request.method === "POST") return withRefresh(await handleEmailCreate(parts[1], request, sql, auth.user));
      }

      if (parts[0] === "notifications") {
        if (parts.length === 1 && request.method === "GET") return withRefresh(await handleNotificationsList(url, sql));
        if (isUuid(parts[1]) && parts[2] === "ack" && request.method === "POST") return withRefresh(await handleNotificationAck(parts[1], sql, auth.user));
      }

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
