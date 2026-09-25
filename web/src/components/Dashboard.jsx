import { useEffect, useState } from "react";
import { api } from "../api.js";
import { STAGE_LABELS, STAGE_ORDER } from "../stages.js";

function fmtMoney(n) {
  return `$${Math.round(n || 0).toLocaleString()}`;
}
function fmtPct(n) {
  return n != null ? `${Math.round(n * 100)}%` : "—";
}

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
        <div className="card"><div className="kv-label">Open pipeline value</div><div className="kv-value mono stat">{fmtMoney(totalPipeline)}</div></div>
        <div className="card"><div className="kv-label">Win rate (count)</div><div className="kv-value mono stat">{fmtPct(summary.win_rate)}</div></div>
        <div className="card"><div className="kv-label">Win rate ($ value)</div><div className="kv-value mono stat">{fmtPct(summary.win_rate_by_value)}</div></div>
        <div className="card"><div className="kv-label">Won / Lost</div><div className="kv-value mono stat">{summary.won} / {summary.lost}</div></div>
        <div className="card"><div className="kv-label">Total bids tracked</div><div className="kv-value mono stat">{summary.total_bids}</div></div>
        <div className="card"><div className="kv-label">Avg bid value</div><div className="kv-value mono stat">{fmtMoney(summary.avg_bid_value)}</div></div>
        <div className="card"><div className="kv-label">Overdue follow-ups</div><div className="kv-value mono stat" style={{ color: summary.overdue_followups > 0 ? "var(--red)" : undefined }}>{summary.overdue_followups}</div></div>
        <div className="card"><div className="kv-label">Hot leads flagged</div><div className="kv-value mono stat">🔥 {summary.hot_leads}</div></div>
      </div>

      <div className="card-title">Pipeline by stage</div>
      <div className="row-list" style={{ marginBottom: 24 }}>
        {STAGE_ORDER.map((stage) => {
          const row = byStage[stage];
          if (!row) return null;
          return (
            <div key={stage} style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", background: "var(--bg-card)", border: "1px solid var(--border-color)", borderRadius: "var(--radius-sm)" }}>
              <span>{STAGE_LABELS[stage]}</span>
              <span className="row-amount">{row.count} bids · {fmtMoney(row.pipeline_value)}</span>
            </div>
          );
        })}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 16 }}>
        <div>
          <div className="card-title">Top companies by bid value</div>
          <table className="data-table">
            <thead>
              <tr><th>Company</th><th className="num">Bids</th><th className="num">Won</th><th className="num">Total value</th></tr>
            </thead>
            <tbody>
              {(summary.by_company || []).map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="num">{c.bid_count}</td>
                  <td className="num">{c.won_count}</td>
                  <td className="num">{fmtMoney(c.total_value)}</td>
                </tr>
              ))}
              {(!summary.by_company || summary.by_company.length === 0) && (
                <tr><td colSpan={4} className="empty-state">No bids yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div>
          <div className="card-title">By region</div>
          <table className="data-table">
            <thead>
              <tr><th>Region</th><th className="num">Bids</th><th className="num">Won</th><th className="num">Lost</th><th className="num">Total value</th></tr>
            </thead>
            <tbody>
              {(summary.by_region || []).map((r) => (
                <tr key={r.region}>
                  <td>{r.region}</td>
                  <td className="num">{r.bid_count}</td>
                  <td className="num">{r.won_count}</td>
                  <td className="num">{r.lost_count}</td>
                  <td className="num">{fmtMoney(r.total_value)}</td>
                </tr>
              ))}
              {(!summary.by_region || summary.by_region.length === 0) && (
                <tr><td colSpan={5} className="empty-state">No region data yet — set a company's region under Companies.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
