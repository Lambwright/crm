import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { ACCOUNT_SEGMENT_LABELS, ACCOUNT_SEGMENTS } from "../stages.js";
import CompanyDetail from "./CompanyDetail.jsx";

function fmtMoney(n) {
  return `$${Math.round(n || 0).toLocaleString()}`;
}

export default function CompanyList() {
  const [companies, setCompanies] = useState([]);
  const [q, setQ] = useState("");
  const [segment, setSegment] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [expiringHotLeads, setExpiringHotLeads] = useState([]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const params = {};
    if (q) params.q = q;
    if (segment) params.segment = segment;
    api.listCompanies(params).then((data) => setCompanies(data.companies || [])).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [q, segment]);

  const loadExpiring = useCallback(() => {
    api.listNotifications("pending")
      .then((data) => setExpiringHotLeads((data.notifications || []).filter((n) => n.type === "hot_lead_expiring")))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    loadExpiring();
  }, [load, loadExpiring]);

  async function renewHotLead(n) {
    await api.patchCompany(n.company_id, { hot_lead: true });
    await api.ackNotification(n.id);
    loadExpiring();
    load();
  }

  async function letHotLeadExpire(n) {
    await api.patchCompany(n.company_id, { hot_lead: false });
    await api.ackNotification(n.id);
    loadExpiring();
    load();
  }

  return (
    <>
      {expiringHotLeads.map((n) => (
        <div className="notification-banner" key={n.id}>
          <span>🔥 {n.message}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-accent btn-sm" onClick={() => renewHotLead(n)}>Renew</button>
            <button className="btn btn-ghost btn-sm" onClick={() => letHotLeadExpire(n)}>Let it expire</button>
          </div>
        </div>
      ))}
      <div className="field-row" style={{ marginBottom: 12 }}>
        <div className="field" style={{ flex: 2 }}>
          <input placeholder="Search companies…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="field">
          <select value={segment} onChange={(e) => setSegment(e.target.value)}>
            <option value="">All segments</option>
            {ACCOUNT_SEGMENTS.map((s) => <option key={s} value={s}>{ACCOUNT_SEGMENT_LABELS[s]}</option>)}
          </select>
        </div>
      </div>
      {error && <div className="card" style={{ color: "var(--red)" }}>{error}</div>}
      <div className="row-list">
        <div className="row-item" style={{ background: "transparent", border: "none", cursor: "default", padding: "0 16px" }}>
          <div className="kv-label">Company</div>
          <div className="kv-label">Segment</div>
          <div className="kv-label" style={{ textAlign: "right" }}>Bids</div>
          <div className="kv-label" style={{ textAlign: "right" }}>Won</div>
          <div className="kv-label" style={{ textAlign: "right" }}>Lost</div>
          <div className="kv-label" style={{ textAlign: "right" }}>Total value</div>
        </div>
        {companies.map((c) => (
          <div className="row-item" key={c.id} onClick={() => setSelectedId(c.id)}>
            <div className="row-primary">
              {c.hot_lead && <span className="hot-lead-flame">🔥</span>}
              {c.name}
            </div>
            <div><span className="badge badge-segment">{ACCOUNT_SEGMENT_LABELS[c.account_segment]}</span></div>
            <div className="row-amount">{c.bid_count}</div>
            <div className="row-amount" style={{ color: c.won_count > 0 ? "var(--green)" : undefined }}>{c.won_count}</div>
            <div className="row-amount" style={{ color: c.lost_count > 0 ? "var(--text-tertiary)" : undefined }}>{c.lost_count}</div>
            <div className="row-amount">{fmtMoney(c.total_value)}</div>
          </div>
        ))}
        {!loading && companies.length === 0 && <div className="empty-state">No companies match.</div>}
      </div>

      {selectedId && (
        <CompanyDetail id={selectedId} onClose={() => setSelectedId(null)} onChanged={load} />
      )}
    </>
  );
}
