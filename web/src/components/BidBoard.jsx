import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { BOARD_STAGES, STAGE_LABELS } from "../stages.js";
import BidDetail from "./BidDetail.jsx";

export default function BidBoard({ user, onNotificationsChanged }) {
  const [bids, setBids] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [showClosed, setShowClosed] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api.listBids().then((data) => setBids(data.bids || [])).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const columns = showClosed ? [...BOARD_STAGES, "complete", "lost", "no_bid"] : BOARD_STAGES;

  function handleChanged() {
    load();
    onNotificationsChanged?.();
  }

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)" }}>
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          Show closed / no-bid columns
        </label>
        <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>{loading ? "↻ …" : "↻ Refresh"}</button>
      </div>
      {error && <div className="card" style={{ color: "var(--red)" }}>{error}</div>}
      <div className="pipeline-board">
        {columns.map((stage) => {
          const stageBids = bids.filter((b) => b.stage === stage);
          return (
            <div className="pipeline-column" key={stage}>
              <div className="pipeline-column-head">
                <span>{STAGE_LABELS[stage]}</span>
                <span>{stageBids.length}</span>
              </div>
              {stageBids.map((bid) => (
                <div className="pipeline-card" key={bid.id} onClick={() => setSelectedId(bid.id)}>
                  <div className="pipeline-card-title">
                    {bid.company_hot_lead && <span className="hot-lead-flame">🔥 </span>}
                    {bid.project_name}
                  </div>
                  <div className="pipeline-card-company">{bid.company_name || "—"}</div>
                  <div className="pipeline-card-meta">
                    <span>{bid.scout_tier ? `Tier ${bid.scout_tier}` : ""}</span>
                    <span>{bid.next_action_date ? `Next: ${bid.next_action_date}` : ""}</span>
                  </div>
                </div>
              ))}
              {stageBids.length === 0 && <div className="empty-state" style={{ padding: 12, fontSize: 11 }}>—</div>}
            </div>
          );
        })}
      </div>
      {selectedId && (
        <BidDetail
          id={selectedId}
          user={user}
          onClose={() => setSelectedId(null)}
          onChanged={handleChanged}
        />
      )}
    </>
  );
}
