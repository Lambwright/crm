import { useEffect, useState } from "react";
import { api } from "../api.js";
import { STAGE_LABELS, STAGE_ORDER } from "../stages.js";

const RANGES = [
  { key: "all", label: "All Time" },
  { key: "year", label: "This Year" },
  { key: "quarter", label: "This Quarter" },
  { key: "month", label: "This Month" },
  { key: "week", label: "This Week" },
];

function fmtMoney(n) {
  return `$${Math.round(n || 0).toLocaleString()}`;
}
function fmtPct(n) {
  return n != null ? `${Math.round(n * 100)}%` : "—";
}

export default function Dashboard() {
  const [range, setRange] = useState("all");
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setSummary(null);
    api.getDashboardSummary(range).then(setSummary).catch((e) => setError(e.message));
  }, [range]);

  if (error) return <div className="card" style={{ color: "var(--red)" }}>{error}</div>;
  if (!summary) return <div className="spinner-inline">Loading…</div>;

  const byStage = Object.fromEntries((summary.by_stage || []).map((r) => [r.stage, r]));
  const totalPipeline = (summary.by_stage || [])
    .filter((r) => !["complete", "lost", "no_bid"].includes(r.stage))
    .reduce((sum, r) => sum + Number(r.pipeline_value || 0), 0);

  return (
    <>
      <div className="tabs" style={{ marginBottom: 16 }}>
        {RANGES.map((r) => (
          <button key={r.key} className={`tab ${range === r.key ? "active" : ""}`} onClick={() => setRange(r.key)}>
            {r.label}
          </button>
        ))}
      </div>

      {range !== "all" && (
        <p className="field-help" style={{ marginBottom: 10, maxWidth: 720 }}>
          Win rate below is a <em>cohort</em> figure — of bids created in this range, how many are currently won/lost
          — so a bid opened months ago that just got awarded won't move it. "Won/Lost this range" further down uses
          the actual award/lost date instead, so that case shows up there.
        </p>
      )}

      <div className="kv-grid" style={{ marginBottom: 20 }}>
        <div className="card"><div className="kv-label">Open pipeline value</div><div className="kv-value mono stat">{fmtMoney(totalPipeline)}</div></div>
        <div className="card"><div className="kv-label" title="Cohort: of bids created in this range, how many are won">Win rate (count)</div><div className="kv-value mono stat">{fmtPct(summary.win_rate)}</div></div>
        <div className="card"><div className="kv-label" title="Cohort: of bids created in this range, how many $ are won">Win rate ($ value)</div><div className="kv-value mono stat">{fmtPct(summary.win_rate_by_value)}</div></div>
        <div className="card">
          <div className="kv-label" title="Awarded / (Awarded + Lost + everything past qualification) — excludes RFQ/Invitation/Estimating and archived">Win rate (pipeline)</div>
          <div className="kv-value mono stat">{fmtPct(summary.pipeline_win_rate)}</div>
          {summary.pipeline_win_rate_components && (
            <div className="field-help">{summary.pipeline_win_rate_components.complete} won / {summary.pipeline_win_rate_components.total} in pipeline</div>
          )}
        </div>
        <div className="card"><div className="kv-label">Won / Lost (cohort)</div><div className="kv-value mono stat">{summary.won} / {summary.lost}</div></div>
        <div className="card"><div className="kv-label">Total bids tracked</div><div className="kv-value mono stat">{summary.total_bids}</div></div>
        <div className="card"><div className="kv-label">Avg bid value</div><div className="kv-value mono stat">{fmtMoney(summary.avg_bid_value)}</div></div>
        <div className="card"><div className="kv-label">Overdue follow-ups</div><div className="kv-value mono stat" style={{ color: summary.overdue_followups > 0 ? "var(--red)" : undefined }}>{summary.overdue_followups}</div></div>
        <div className="card"><div className="kv-label">Follow-ups completed ({RANGES.find((r) => r.key === range)?.label})</div><div className="kv-value mono stat">{summary.followups_completed}</div></div>
        <div className="card"><div className="kv-label">Hot leads flagged</div><div className="kv-value mono stat">🔥 {summary.hot_leads}</div></div>
      </div>

      <div className="card-title">Won / Lost this range, by actual date</div>
      <div className="kv-grid" style={{ marginBottom: 20 }}>
        <div className="card"><div className="kv-label">Bids created</div><div className="kv-value mono stat">{summary.total_bids}</div></div>
        <div className="card"><div className="kv-label">Won this range</div><div className="kv-value mono stat" style={{ color: "var(--green)" }}>{summary.won_in_range?.count ?? 0}</div></div>
        <div className="card"><div className="kv-label">Won value</div><div className="kv-value mono stat">{fmtMoney(summary.won_in_range?.value)}</div></div>
        <div className="card"><div className="kv-label">Lost this range</div><div className="kv-value mono stat" style={{ color: "var(--text-tertiary)" }}>{summary.lost_in_range?.count ?? 0}</div></div>
        <div className="card"><div className="kv-label">Lost value</div><div className="kv-value mono stat">{fmtMoney(summary.lost_in_range?.value)}</div></div>
        <div className="card">
          <div className="kv-label">Needs cleanup</div>
          <div className="kv-value mono stat" style={{ color: summary.needs_cleanup > 0 ? "var(--yellow)" : undefined }}>{summary.needs_cleanup}</div>
          <div className="field-help">Archived in Procore, never closed out here</div>
        </div>
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
          <div className="card-title">Top companies by bid value ({RANGES.find((r) => r.key === range)?.label})</div>
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
                <tr><td colSpan={4} className="empty-state">No bids in this range.</td></tr>
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
