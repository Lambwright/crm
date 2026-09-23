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
  createCompany: (fields) => request("/companies", { method: "POST", body: fields }),
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

  // Dashboard
  getDashboardSummary: () => request("/dashboard/summary"),
};

// Builds a prefilled mailto: link for the tender-email popout. Kept client-side
// (no backend round-trip needed) — logging what was sent is a separate,
// explicit step (api.logEmail) once the user has actually sent it.
export function buildMailto({ to, subject, body }) {
  const params = new URLSearchParams();
  if (subject) params.set("subject", subject);
  if (body) params.set("body", body);
  const query = params.toString();
  return `mailto:${encodeURIComponent(to || "").replace(/%40/g, "@")}${query ? `?${query}` : ""}`;
}

export { UnauthorizedError };
