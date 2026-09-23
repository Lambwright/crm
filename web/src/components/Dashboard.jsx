import { useEffect, useState } from "react";
import { api } from "../api.js";
import { STAGE_LABELS, STAGE_ORDER } from "../stages.js";

// v1 dashboard: pipeline-by-stage, win rate, aging, hot-lead count — the
// Playbook's Executive-dashboard KPIs, read straight off crm-worker's SQL
// views instead of NetSuite saved searches. Charting/visual polish is
// deliberately deferred until the underlying data has been validated against
// real bids for a few weeks — see kickoff prompt "Explicitly deferred".
export default function Dashboard() {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getDashboardSummary().then(setSummary).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="card" style={{ color: "var(--red)" }}>{error}</div>;
  if (!summary) return <div className="spinner-inline">Loading…</div>;

  const byStage = Object.fromEntries((summary.by_stage || []).map((r) => [r.stage, r]));
  const totalPipeline = (summary.by_stage || [])
    .filter((r) => !["closed_won", "closed_lost", "no_bid"].includes(r.stage))
    .reduce((sum, r) => sum + Number(r.pipeline_value || 0), 0);

  return (
    <>
      <div className="kv-grid" style={{ marginBottom: 20 }}>
        <div className="card"><div className="kv-label">Open pipeline value</div><div className="kv-value mono" style={{ fontSize: 22 }}>${totalPipeline.toLocaleString()}</div></div>
        <div className="card"><div className="kv-label">Win rate</div><div className="kv-value mono" style={{ fontSize: 22 }}>{summary.win_rate != null ? `${Math.round(summary.win_rate * 100)}%` : "—"}</div></div>
        <div className="card"><div className="kv-label">Won / Lost</div><div className="kv-value mono" style={{ fontSize: 22 }}>{summary.won} / {summary.lost}</div></div>
        <div className="card"><div className="kv-label">Overdue follow-ups</div><div className="kv-value mono" style={{ fontSize: 22, color: summary.overdue_followups > 0 ? "var(--red)" : undefined }}>{summary.overdue_followups}</div></div>
        <div className="card"><div className="kv-label">Hot leads flagged</div><div className="kv-value mono" style={{ fontSize: 22 }}>🔥 {summary.hot_leads}</div></div>
      </div>

      <div className="card-title">Pipeline by stage</div>
      <div className="row-list">
        {STAGE_ORDER.map((stage) => {
          const row = byStage[stage];
          if (!row) return null;
          return (
            <div key={stage} style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", background: "var(--bg-card)", border: "1px solid var(--border-color)", borderRadius: "var(--radius-sm)" }}>
              <span>{STAGE_LABELS[stage]}</span>
              <span className="row-amount">{row.count} bids · ${Number(row.pipeline_value).toLocaleString()}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}
