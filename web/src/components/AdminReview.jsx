import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";

// Admin review (Ben, 2026-10-21): the things leadership should look at in one place.
// Priority-client RFQs an estimator declined are a queue to work through (follow up
// with the customer personally, then mark it done); overrides, blacklisted clients and
// priority clients are lists to keep an eye on.
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : "—");

function Section({ title, count, tip, children, empty }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div className="card-title">{title}{count != null ? ` (${count})` : ""}</div>
      {tip && <div className="field-help" style={{ marginBottom: 8, maxWidth: 760 }}>{tip}</div>}
      {count === 0 ? <div className="empty-state">{empty}</div> : children}
    </div>
  );
}

function DeclinedRow({ item, onDone }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const open = item.status === "open";
  async function done() {
    setBusy(true); setError(null);
    try { await api.resolveReviewItem(item.id, note); onDone(); } catch (e) { setError(e.data?.detail || e.message); setBusy(false); }
  }
  return (
    <div className="card" style={{ marginBottom: 8, opacity: open ? 1 : 0.7 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 600 }}>🔥 {item.company_name || "(unknown client)"} <span className="row-secondary">· {item.project_name || item.rfq_ref}</span></div>
          <div className="row-secondary">Declined by {item.actor || "an estimator"} on {fmtDate(item.created_at)}</div>
          <div style={{ marginTop: 6, fontSize: 13 }}><strong>Reason given:</strong> {item.reason || "(none)"}</div>
          {!open && <div className="field-help" style={{ marginTop: 4 }}>Followed up by {item.resolved_by} on {fmtDate(item.resolved_at)}{item.resolution_note ? `: ${item.resolution_note}` : ""}</div>}
        </div>
        {open && (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
            <input placeholder="What was done (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ minWidth: 220 }} />
            <button className="btn btn-accent btn-sm" disabled={busy} onClick={done}>{busy ? "…" : "Mark followed up"}</button>
          </div>
        )}
      </div>
      {error && <div className="login-error" style={{ marginTop: 6 }}>{error}</div>}
    </div>
  );
}

export default function AdminReview() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.getAdminReview().then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  if (error) return <div className="card" style={{ color: "var(--red)" }}>{error}</div>;
  if (!data) return <div className="spinner-inline">Loading…</div>;

  const open = data.declined.filter((d) => d.status === "open");
  const closed = data.declined.filter((d) => d.status !== "open");
  const daysLeft = (p) => {
    if (p.priority_permanent) return "permanent";
    if (!p.hot_lead_set_at) return "—";
    const left = 37 - Math.floor((Date.now() - new Date(p.hot_lead_set_at).getTime()) / 86400000);
    return left > 0 ? `expires in ${left} day${left === 1 ? "" : "s"}` : "expiring now";
  };

  return (
    <>
      <Section
        title="Declined priority-client RFQs: follow up"
        count={open.length}
        tip="A priority client's RFQ that an estimator declined in SCOUT. Contact the customer personally, then mark it followed up."
        empty="Nothing waiting. No priority-client RFQ is sitting declined."
      >
        {open.map((d) => <DeclinedRow key={d.id} item={d} onDone={load} />)}
      </Section>
      {closed.length > 0 && (
        <details style={{ marginBottom: 24 }}>
          <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Followed up in the last 60 days ({closed.length})</summary>
          <div style={{ marginTop: 8 }}>{closed.map((d) => <DeclinedRow key={d.id} item={d} onDone={load} />)}</div>
        </details>
      )}

      <Section
        title="SCOUT overrides (last 120 days)"
        count={data.overrides.length}
        tip="Bids scored No Bid that were submitted anyway, with who approved and why. Priority clients aren't listed here: the priority flag is their reason."
        empty="No overrides."
      >
        <table className="data-table">
          <thead><tr><th>Date</th><th>Client</th><th>Project</th><th>Approved by</th><th>Reason</th></tr></thead>
          <tbody>
            {data.overrides.map((o) => (
              <tr key={o.id}><td>{fmtDate(o.submitted_at)}</td><td>{o.client}</td><td>{o.project_name}</td><td>{o.override_approver || "—"}</td><td>{o.override_reason || "—"}</td></tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="⛔ Blacklisted clients" count={data.blacklisted.length} empty="No blacklisted clients.">
        <table className="data-table">
          <thead><tr><th>Client</th><th>Reason</th><th>By</th><th>Date</th></tr></thead>
          <tbody>
            {data.blacklisted.map((c) => <tr key={c.id}><td>{c.name}</td><td>{c.blacklist_reason || "—"}</td><td>{c.blacklisted_by || "—"}</td><td>{fmtDate(c.blacklisted_at)}</td></tr>)}
          </tbody>
        </table>
      </Section>

      <Section title="🔥 Priority clients" count={data.priority.length} empty="No priority clients.">
        <table className="data-table">
          <thead><tr><th>Client</th><th>Reason</th><th>Set by</th><th>Since</th><th>Expiry</th></tr></thead>
          <tbody>
            {data.priority.map((c) => (
              <tr key={c.id}><td>{c.name}</td><td>{c.hot_lead_reason || "—"}</td><td>{c.hot_lead_set_by || "—"}</td><td>{fmtDate(c.hot_lead_set_at)}</td><td>{daysLeft(c)}</td></tr>
            ))}
          </tbody>
        </table>
      </Section>
    </>
  );
}
