import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { STAGE_LABELS } from "../stages.js";
import { buildFollowUpDraft } from "../followupTemplates.js";
import BidDetail from "./BidDetail.jsx";

function daysOverdue(dateStr) {
  if (!dateStr) return null;
  const days = Math.floor((Date.now() - new Date(dateStr + "T00:00:00Z").getTime()) / 86400000);
  return days;
}

export default function Followups({ user, assignableUsers = [], onNotificationsChanged }) {
  const [bids, setBids] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [mineOnly, setMineOnly] = useState(true);
  const [selected, setSelected] = useState(null); // { id, prefillEmail }

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .listFollowups(mineOnly)
      .then((data) => setBids(data.bids || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [mineOnly]);

  useEffect(() => {
    load();
  }, [load]);

  function openFollowUp(bid) {
    const draft = buildFollowUpDraft(bid, {
      contactFirstName: bid.contact_first_name,
      contactEmail: bid.contact_email,
    });
    setSelected({ id: bid.id, prefillEmail: draft });
  }

  function handleChanged() {
    load();
    onNotificationsChanged?.();
  }

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)" }}>
          <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
          My bids only
        </label>
        <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>{loading ? "↻ …" : "↻ Refresh"}</button>
      </div>
      {error && <div className="card" style={{ color: "var(--red)" }}>{error}</div>}
      {!loading && bids.length === 0 && !error && (
        <div className="empty-state">Nothing due right now — every open bid has a future follow-up date.</div>
      )}
      <div className="row-list">
        {bids.map((bid) => {
          const overdue = daysOverdue(bid.next_action_date);
          return (
            <div className="row-item" key={bid.id} style={{ gridTemplateColumns: "1.6fr 130px 120px 90px 140px", cursor: "default" }}>
              <div>
                <div className="row-primary">
                  {bid.company_hot_lead && <span className="hot-lead-flame">🔥 </span>}
                  {bid.project_name}
                </div>
                <div className="row-secondary">{bid.company_name || "—"}</div>
              </div>
              <div className="row-secondary">{STAGE_LABELS[bid.stage]}</div>
              <div className="row-secondary">{bid.owner_username || bid.estimator_username || "unassigned"}</div>
              <div className="row-secondary" style={{ color: overdue === null ? "var(--text-tertiary)" : overdue > 0 ? "var(--red)" : "var(--yellow, #c9a227)" }}>
                {overdue === null ? "never set" : overdue > 0 ? `${overdue}d overdue` : "due today"}
              </div>
              <button className="btn btn-accent btn-sm" onClick={() => openFollowUp(bid)}>Follow up →</button>
            </div>
          );
        })}
      </div>
      {selected && (
        <BidDetail
          id={selected.id}
          user={user}
          assignableUsers={assignableUsers}
          prefillEmail={selected.prefillEmail}
          onClose={() => setSelected(null)}
          onChanged={handleChanged}
        />
      )}
    </>
  );
}
