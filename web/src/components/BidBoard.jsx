import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { BOARD_STAGES, STAGE_LABELS, STAGE_REQUIREMENTS } from "../stages.js";
import BidDetail from "./BidDetail.jsx";

// Ben, 2026-10-01: "if I'm an estimator, admin or super admin". Once CRM is
// switched to the role matrix that's exactly access.can.move_stages
// (estimator/admin). Until then (legacy mode) this keeps using the closest
// equivalent: the HELM-curated assignable-users list or the legacy admin role.
function canStartHandoff(user, assignableUsers, access) {
  if (!user) return false;
  // Live (role matrix): same people who can move a bid between stages.
  if (access && access.mode === "live") return Boolean(access.can?.move_stages);
  if (user.role === "admin") return true;
  return assignableUsers.some((u) => u.username === user.username);
}

const HANDOFF_URL = (boardId) => `https://lambwright.github.io/handoff/#/bids?open=${encodeURIComponent(boardId)}`;

const SORTS = {
  updated: { label: "Recently updated", cmp: (a, b) => new Date(b.updated_at) - new Date(a.updated_at) },
  next_action: { label: "Follow-up date", cmp: (a, b) => (a.next_action_date || "9999").localeCompare(b.next_action_date || "9999") },
  value: { label: "Value (high-low)", cmp: (a, b) => (b.estimated_value || 0) - (a.estimated_value || 0) },
  due: { label: "Bid due date", cmp: (a, b) => (a.bid_due_date || "9999").localeCompare(b.bid_due_date || "9999") },
  name: { label: "Project name", cmp: (a, b) => (a.project_name || "").localeCompare(b.project_name || "") },
};

export default function BidBoard({ user, access, assignableUsers = [], onNotificationsChanged }) {
  const can = access?.can;
  const canMove = can?.move_stages ?? true; // cosmetic; the worker enforces it
  const [bids, setBids] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [gatedMove, setGatedMove] = useState(null); // { id, toStage, autoHandoff? } — a drop (or Start Handoff click) that needs required fields first
  const [showClosed, setShowClosed] = useState(false);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState("updated");
  const [dragOverStage, setDragOverStage] = useState(null);
  const [draggingId, setDraggingId] = useState(null);

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

  const q = search.trim().toLowerCase();
  const visible = useMemo(
    () => bids.filter((b) => !q || (b.project_name || "").toLowerCase().includes(q) || (b.company_name || "").toLowerCase().includes(q)),
    [bids, q]
  );

  // Bids with real CRM-side activity lead their column (see worker's
  // has_activity), sorted among themselves the same way as the rest —
  // "touched recently" isn't a sort key of its own, it's a grouping on top of
  // whichever sort is picked.
  function bidsForColumn(stage) {
    const stageBids = visible.filter((b) => b.stage === stage);
    const cmp = SORTS[sortKey].cmp;
    const active = stageBids.filter((b) => b.has_activity).sort(cmp);
    const rest = stageBids.filter((b) => !b.has_activity).sort(cmp);
    return [...active, ...rest];
  }

  async function handleDrop(toStage) {
    setDragOverStage(null);
    const bidId = draggingId;
    setDraggingId(null);
    if (!bidId || !canMove) return;
    const bid = bids.find((b) => b.id === bidId);
    if (!bid || bid.stage === toStage) return;

    const reqs = STAGE_REQUIREMENTS[toStage] || [];
    if (reqs.length > 0) {
      // Can't collect required fields mid-drag — open the bid pointed at the
      // target stage instead of silently failing the move.
      setGatedMove({ id: bidId, toStage });
      return;
    }
    try {
      await api.moveBidStage(bidId, toStage, {});
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  // One action from the card itself, not "find the Awarded column, drag it
  // there, notice a link appeared, click that too" (Ben, 2026-10-01):
  // already-awarded bids jump straight into HANDOFF; anything else opens
  // the bid pre-aimed at Awarded, and completing that move (final value +
  // award date — can't skip those, they're real required fields) continues
  // straight into HANDOFF on its own.
  function handleStartHandoff(e, bid) {
    e.stopPropagation();
    if (!bid.procore_bid_board_id) {
      setError(`"${bid.project_name}" has no Procore Bid Board ID — can't start a handoff for it.`);
      return;
    }
    if (bid.stage === "complete") {
      window.open(HANDOFF_URL(bid.procore_bid_board_id), "_blank");
      return;
    }
    setGatedMove({ id: bid.id, toStage: "complete", autoHandoff: true });
  }

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <input
            placeholder="Search project or company…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 220 }}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)" }}>
            Sort
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value)}>
              {Object.entries(SORTS).map(([key, s]) => <option key={key} value={key}>{s.label}</option>)}
            </select>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)" }}>
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
            Show closed / no-bid columns
          </label>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>{loading ? "↻ …" : "↻ Refresh"}</button>
      </div>
      {error && <div className="card" style={{ color: "var(--red)" }}>{error}</div>}
      <div className="pipeline-board">
        {columns.map((stage) => {
          const stageBids = bidsForColumn(stage);
          return (
            <div className="pipeline-column" key={stage}>
              <div className="pipeline-column-head">
                <span>{STAGE_LABELS[stage]}</span>
                <span>{stageBids.length}</span>
              </div>
              <div
                className={`pipeline-column-drop-zone${dragOverStage === stage ? " drag-over" : ""}`}
                style={{ display: "flex", flexDirection: "column", gap: 8 }}
                onDragOver={(e) => { e.preventDefault(); if (dragOverStage !== stage) setDragOverStage(stage); }}
                onDragLeave={() => setDragOverStage((s) => (s === stage ? null : s))}
                onDrop={(e) => { e.preventDefault(); handleDrop(stage); }}
              >
                {stageBids.map((bid) => (
                  <div
                    className={`pipeline-card${bid.has_activity ? " has-activity" : ""}${draggingId === bid.id ? " dragging" : ""}`}
                    key={bid.id}
                    draggable={canMove}
                    onDragStart={(e) => { e.dataTransfer.setData("text/plain", bid.id); setDraggingId(bid.id); }}
                    onDragEnd={() => { setDraggingId(null); setDragOverStage(null); }}
                    onClick={() => setSelectedId(bid.id)}
                    title={bid.has_activity ? "Has recent activity (email logged, a stage move, or a follow-up noted)" : undefined}
                  >
                    <div className="pipeline-card-title">
                      {bid.company_hot_lead && <span className="hot-lead-flame">🔥 </span>}
                      {bid.project_name}
                    </div>
                    <div className="pipeline-card-company">{bid.company_name || "—"}</div>
                    {bid.source_archived && (
                      <div style={{ fontSize: 10, color: "var(--yellow)", marginBottom: 4 }} title="Archived in Procore but still open here — needs a manual close-out">
                        🗄 Archived in Procore, still open here
                      </div>
                    )}
                    <div className="pipeline-card-meta">
                      <span>{bid.scout_tier ? `Tier ${bid.scout_tier}` : ""}</span>
                      <span>{bid.next_action_date ? `Next: ${bid.next_action_date}` : ""}</span>
                    </div>
                    {stage !== "complete" && canStartHandoff(user, assignableUsers, access) && (
                      <button
                        className="btn btn-accent btn-sm"
                        style={{ marginTop: 8, width: "100%" }}
                        onClick={(e) => handleStartHandoff(e, bid)}
                      >
                        🚀 Start Handoff
                      </button>
                    )}
                  </div>
                ))}
                {stageBids.length === 0 && <div className="empty-state" style={{ padding: 12, fontSize: 11 }}>—</div>}
              </div>
            </div>
          );
        })}
      </div>
      {selectedId && (
        <BidDetail
          id={selectedId}
          user={user}
          assignableUsers={assignableUsers}
          can={can}
          onClose={() => setSelectedId(null)}
          onChanged={handleChanged}
        />
      )}
      {gatedMove && (
        <BidDetail
          id={gatedMove.id}
          user={user}
          assignableUsers={assignableUsers}
          initialToStage={gatedMove.toStage}
          can={can}
          autoHandoffOnComplete={gatedMove.autoHandoff}
          onClose={() => setGatedMove(null)}
          onChanged={handleChanged}
        />
      )}
    </>
  );
}
