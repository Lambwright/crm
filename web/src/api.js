import { getStoredToken, storeToken, clearToken } from "./auth.js";

const API_BASE = import.meta.env.DEV
  ? "/api"
  : import.meta.env.VITE_CRM_API || "";

class UnauthorizedError extends Error {
  constructor(reason) {
    super(reason || "unauthorized");
    this.unauthorized = true;
  }
}

async function request(path, { method = "GET", body, headers } = {}) {
  const token = getStoredToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const refreshed = res.headers.get("X-Refreshed-Token");
  if (refreshed) storeToken(refreshed);

  if (res.status === 401) {
    clearToken();
    const data = await res.json().catch(() => ({}));
    throw new UnauthorizedError(data.reason);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.detail || data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  // Companies
  listCompanies: (params = {}) => request(`/companies?${new URLSearchParams(params)}`),
  getCompany: (id) => request(`/companies/${id}`), // { company, contacts, bids }
  patchCompany: (id, fields) => request(`/companies/${id}`, { method: "PATCH", body: fields }),
  addContact: (companyId, fields) => request(`/companies/${companyId}/contacts`, { method: "POST", body: fields }),
  patchContact: (id, fields) => request(`/contacts/${id}`, { method: "PATCH", body: fields }),

  // Bids
  listBids: (params = {}) => request(`/bids?${new URLSearchParams(params)}`),
  getBid: (id) => request(`/bids/${id}`), // { bid, stage_history, emails }
  patchBid: (id, fields) => request(`/bids/${id}`, { method: "PATCH", body: fields }),
  moveBidStage: (id, toStage, fields = {}) => request(`/bids/${id}/stage`, { method: "POST", body: { to_stage: toStage, ...fields } }),

  // Tender emails
  listEmails: (bidId) => request(`/bids/${bidId}/emails`),
  logEmail: (bidId, fields) => request(`/bids/${bidId}/emails`, { method: "POST", body: fields }),

  // Notifications
  listNotifications: (status) => request(`/notifications${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  ackNotification: (id) => request(`/notifications/${id}/ack`, { method: "POST", body: {} }),

  // Follow-ups — open bids due (or overdue) for a human touch
  listFollowups: (mine, upcoming) => request(`/followups?${[mine ? "mine=1" : "", upcoming ? "upcoming=1" : ""].filter(Boolean).join("&")}`),

  // Dashboard
  getDashboardSummary: (range, from, to) => {
    const q = new URLSearchParams();
    if (range) q.set("range", range);
    if (range === "custom") { if (from) q.set("from", from); if (to) q.set("to", to); }
    return request(`/dashboard/summary?${q}`);
  },

  // Extra CRM capabilities per person (admin only): follow-up manager, campaign manager
  getGrants: () => request(`/grants`),
  setGrants: (username, caps) => request(`/grants`, { method: "PATCH", body: { username, caps } }),

  // NetSuite -> CRM company sync (admin): preview first, then apply
  getNsSync: () => request(`/admin/netsuite-sync`),
  previewNsSync: (rows) => request(`/admin/netsuite-sync/preview`, { method: "POST", body: { rows } }),
  applyNsSync: (runId) => request(`/admin/netsuite-sync/apply`, { method: "POST", body: { run_id: runId } }),
  reviewNsSync: (opId, decision) => request(`/admin/netsuite-sync/review`, { method: "POST", body: { op_id: opId, decision } }),
  setNsSyncAuto: (enabled) => request(`/admin/netsuite-sync/auto`, { method: "POST", body: { enabled } }),

  // Merge a duplicate company into another (admin)
  previewCompanyMerge: (keepId, mergeId) => request(`/admin/companies/merge-preview?keep=${keepId}&merge=${mergeId}`),
  mergeCompanies: (keepId, mergeId) => request(`/admin/companies/merge`, { method: "POST", body: { keep_id: keepId, merge_id: mergeId } }),

  // Contacts + addresses from a NetSuite export (admin)
  previewContactsImport: (rows) => request(`/admin/contacts-import/preview`, { method: "POST", body: { rows } }),
  applyContactsImport: (rows) => request(`/admin/contacts-import/apply`, { method: "POST", body: { rows } }),

  // SCOUT prequalification stats, and the admin history import
  getScoutStats: (range, from, to) => {
    const q = new URLSearchParams();
    if (range) q.set("range", range);
    if (range === "custom") { if (from) q.set("from", from); if (to) q.set("to", to); }
    return request(`/scout/stats?${q}`);
  },
  previewScoutImport: (rows) => request(`/admin/scout-import/preview`, { method: "POST", body: { rows } }),
  applyScoutImport: (rows) => request(`/admin/scout-import/apply`, { method: "POST", body: { rows } }),

  // Match SCOUT history client names to companies (admin)
  getScoutUnlinked: () => request(`/admin/scout-unlinked`),
  linkScoutClient: (client, companyId) => request(`/admin/scout-unlinked/link`, { method: "POST", body: { client, company_id: companyId } }),
  linkScoutRuns: (runIds, companyId) => request(`/admin/scout-unlinked/link`, { method: "POST", body: { run_ids: runIds, company_id: companyId } }),
  excludeScoutClient: (client) => request(`/admin/scout-unlinked/exclude`, { method: "POST", body: { client } }),
  excludeScoutRuns: (runIds) => request(`/admin/scout-unlinked/exclude`, { method: "POST", body: { run_ids: runIds } }),

  // Ask LEDGER to refresh one project's contract / change-order figures now
  refreshProjectFinancials: (procoreProjectId) => request(`/scout/financials/refresh`, { method: "POST", body: { procore_project_id: procoreProjectId } }),

  // Admin review queue (declined priority-client RFQs, overrides, blacklist, priority clients)
  getAdminReview: () => request(`/admin/review`),
  resolveReviewItem: (id, note) => request(`/admin/review/resolve`, { method: "POST", body: { id, note } }),

  // Follow-up manager dashboard: progress, bulk assignment, auto-assignment rules
  getFollowupDashboard: () => request(`/followups/dashboard`),
  bulkAssignFollowups: (bidIds, owner) => request(`/followups/bulk-assign`, { method: "POST", body: { bid_ids: bidIds, owner_username: owner } }),
  followupRule: (body) => request(`/followups/rules`, { method: "POST", body }),
  previewFollowupRules: (includeOwned) => request(`/followups/rules/preview`, { method: "POST", body: { include_owned: Boolean(includeOwned) } }),
  applyFollowupRules: (includeOwned) => request(`/followups/rules/apply`, { method: "POST", body: { include_owned: Boolean(includeOwned) } }),

  // Procore project regions (one list, used for every region pick)
  listRegions: () => request(`/regions`),

  // Settings — cadence + assignable-users list, edited from HELM's CRM Options tab
  getSettings: () => request(`/settings`),
  // The follow-up managers (and admins) change the cadence from the Follow-up manager tab as well
  saveCadence: (cadence, priority, holdDays) => request(`/settings`, { method: "PATCH", body: { followup_cadence_days: cadence, followup_cadence_priority: priority, estimating_hold_days: holdDays } }),
  // An owner moves a bid's follow-up date because the client asked (a reason is required)
  // The owner's answer to "is this client answering you?", optionally asking a colleague to try
  answerChase: (bidId, body) => request(`/bids/${bidId}/chase`, { method: "POST", body }),
  setBidPriority: (bidId, flag) => request(`/bids/${bidId}/priority`, { method: "POST", body: { priority_bid: flag } }),
  resolveHelp: (helpId, status) => request(`/followups/help/${helpId}/resolve`, { method: "POST", body: { status } }),
  getFollowupCounts: () => request(`/followups/counts`),
  // The client's real contacts from Procore's Directory (CRM asks at most weekly per company unless forced)
  refreshCompanyContacts: (companyId, force) => request(`/companies/${companyId}/refresh-contacts`, { method: "POST", body: { force: Boolean(force) } }),
  procoreCandidates: (companyId) => request(`/companies/${companyId}/procore-candidates`),
  procoreLink: (companyId, vendorId) => request(`/companies/${companyId}/procore-link`, { method: "POST", body: { vendor_id: vendorId } }),
  refreshContacts: (bidId, force) => request(`/bids/${bidId}/refresh-contacts`, { method: "POST", body: { force: Boolean(force) } }),
  setFollowupDate: (bidId, date, reason) => request(`/bids/${bidId}/followup-date`, { method: "POST", body: { date, reason } }),

  // What the signed-in user can do in CRM (role matrix) + who they can assign follow-ups to
  getAccess: () => request(`/access`),
};

// Builds a prefilled mailto: link for the tender-email popout. Kept client-side
// (no backend round-trip needed) — logging what was sent is a separate,
// explicit step (api.logEmail) once the user has actually sent it.
//
// Deliberately NOT URLSearchParams here — its .toString() form-encodes
// spaces as "+" (application/x-www-form-urlencoded), but a mailto: URI's
// query needs RFC 6068 percent-encoding ("%20"), so mail clients were
// showing literal "+" characters instead of spaces (Ben, 2026-09).
// encodeURIComponent gives the correct escaping.
export function buildMailto({ to, subject, body }) {
  const parts = [];
  if (subject) parts.push(`subject=${encodeURIComponent(subject)}`);
  if (body) parts.push(`body=${encodeURIComponent(body)}`);
  const query = parts.join("&");
  return `mailto:${encodeURIComponent(to || "").replace(/%40/g, "@")}${query ? `?${query}` : ""}`;
}

export { UnauthorizedError };
