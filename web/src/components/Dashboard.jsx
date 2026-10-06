import { useEffect, useState } from "react";
import { api } from "../api.js";
import { STAGE_LABELS, STAGE_ORDER } from "../stages.js";
import Tip from "./Tip.jsx";
import CustomerTable from "./CustomerTable.jsx";

// Einbau's fiscal year runs Oct 1 - Sep 30 and is named for the year it ends
// in, so from 2026-10-01 we're in FY2027 (Ben, 2026-10-06). Calendar quarters
// already line up with fiscal quarters (Q1 = Oct-Dec), so only the year needs
// its own tabs.
const FY_NOW = (() => {
  const n = new Date();
  return n.getMonth() >= 9 ? n.getFullYear() + 1 : n.getFullYear();
})();

const RANGES = [
  { key: "all", label: "All Time", phrase: "at any time" },
  { key: "fy", label: `This Fiscal Year (FY${FY_NOW})`, phrase: `this fiscal year (FY${FY_NOW})` },
  { key: "last_fy", label: `Last Fiscal Year (FY${FY_NOW - 1})`, phrase: `last fiscal year (FY${FY_NOW - 1})` },
  { key: "year", label: "This Calendar Year", phrase: "this calendar year" },
  { key: "quarter", label: "This Quarter", phrase: "this quarter" },
  { key: "month", label: "This Month", phrase: "this month" },
  { key: "week", label: "This Week", phrase: "this week" },
  { key: "last_week", label: "Last Week", phrase: "last week" },
];

// Count vs dollar-value view for every tile that has both (Ben, 2026-10-05).
const BASES = [
  { key: "count", label: "# Bids" },
  { key: "value", label: "$ Value" },
];

const RATE_MODES = [
  { key: "pipeline", label: "Pipeline" },
  { key: "decided", label: "Decided" },
];

function fmtMoney(n) {
  return `$${Math.round(n || 0).toLocaleString()}`;
}
function fmtNum(n) {
  return Number(n || 0).toLocaleString();
}
function fmtPct(n) {
  return n != null ? `${Math.round(n * 100)}%` : "—";
}

// Monday-to-Sunday dates for the week-based ranges, computed the same way the
// worker does, so the caption under the tabs says exactly what's included.
function weekCaption(rangeKey) {
  const now = new Date();
  const diffToMonday = now.getDay() === 0 ? 6 : now.getDay() - 1;
  const thisMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday);
  const start = rangeKey === "last_week" ? new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - 7) : thisMonday;
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  const f = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return rangeKey === "last_week" ? `${f(start)} – ${f(end)}` : `${f(start)} – today`;
}

// Exact dates for the periods that aren't obvious from their name. `period`
// comes from the worker so the dates here can never disagree with what it ran.
function periodCaption(range, period, rangeInfo) {
  if (range === "week" || range === "last_week") return `${rangeInfo.label}: ${weekCaption(range)} (Monday to Sunday). Win rates count bids decided in it; other figures count bids created in it.`;
  if (range === "all") return "Showing every bid on record.";
  const f = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  if ((range === "fy" || range === "last_fy") && period) {
    const start = new Date(period.start);
    const end = period.end ? new Date(new Date(period.end).getTime() - 86400000) : null; // end is exclusive
    return `${rangeInfo.label}: ${f(start)} – ${end ? f(end) : "today"}. Win rates count bids decided in that period; other figures count bids created in it.`;
  }
  return `Win rates count bids decided ${rangeInfo.phrase}; other figures count bids created ${rangeInfo.phrase}.`;
}

export default function Dashboard() {
  const [range, setRange] = useState("all");
  const [basis, setBasis] = useState("count");
  // Win rate card toggle (Ben, 2026-10-06): pipeline by default. The customer
  // table rates each customer on the same basis, against the same overall rate.
  const [rateMode, setRateMode] = useState("pipeline");
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setSummary(null);
    api.getDashboardSummary(range).then(setSummary).catch((e) => setError(e.message));
  }, [range]);

  if (error) return <div className="card" style={{ color: "var(--red)" }}>{error}</div>;
  if (!summary || (summary.period && summary.period.key !== range)) return <div className="spinner-inline">Loading…</div>;

  const rangeInfo = RANGES.find((r) => r.key === range);
  const byStage = Object.fromEntries((summary.by_stage || []).map((r) => [r.stage, r]));
  const openRows = (summary.by_stage || []).filter((r) => !["complete", "lost", "no_bid"].includes(r.stage));
  const totalPipeline = openRows.reduce((sum, r) => sum + Number(r.pipeline_value || 0), 0);
  const openCount = openRows.reduce((sum, r) => sum + Number(r.count || 0), 0);

  const isValue = basis === "value";
  const isPipeline = rateMode === "pipeline";
  const show = (n) => (isValue ? fmtMoney(n) : fmtNum(n));

  const decided = isValue ? summary.decided_win_rate_value_components : summary.decided_win_rate_components;
  const pipeline = isValue ? summary.pipeline_win_rate_value_components : summary.pipeline_win_rate_components;
  const decidedRate = isValue ? summary.decided_win_rate_value : summary.decided_win_rate;
  const pipelineRate = isValue ? summary.pipeline_win_rate_value : summary.pipeline_win_rate;
  const wonLost = decided || { complete: 0, lost: 0 };
  const overallRate = isPipeline ? pipelineRate : decidedRate;

  const archivedNote = summary.include_archived ? "archived bids included" : "archived bids excluded";
  const statusNote = `Judged by when each bid was actually decided (moved to Awarded or Lost), not when it was created. Bids from the one-time historical import have no recorded decision date, so their bid due date stands in for it.`;

  const valueNote = isValue
    ? "An Awarded bid counts at its confirmed final value where one was entered, otherwise at its estimate (most older wins never had a final value keyed in); Lost and still-active bids count at their estimate."
    : null;

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 8 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-secondary)" }}>
          Period
          <select value={range} onChange={(e) => setRange(e.target.value)} style={{ minWidth: 220 }}>
            {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        </label>
        <div className="tabs" style={{ marginBottom: 0 }} title="Switch the tiles that have both between a count of bids and their dollar value">
          {BASES.map((b) => (
            <button key={b.key} className={`tab ${basis === b.key ? "active" : ""}`} onClick={() => setBasis(b.key)}>
              {b.label}
            </button>
          ))}
        </div>
      </div>
      <p className="field-help" style={{ marginBottom: 14 }}>{periodCaption(range, summary.period, rangeInfo)}</p>

      <div className="kv-grid" style={{ marginBottom: 20 }}>
        <div className="card">
          <Tip label="Open pipeline">
            Bids created {rangeInfo.phrase} that are still being worked — anything not yet Awarded, Lost or No Bid.<br /><br />
            <strong>{fmtNum(openCount)} open bids</strong> with a combined estimate of <strong>{fmtMoney(totalPipeline)}</strong>.
            A bid with no estimate yet counts as $0 in the dollar figure.
          </Tip>
          <div className="kv-value mono stat">{isValue ? fmtMoney(totalPipeline) : fmtNum(openCount)}</div>
        </div>

        <div className="card">
          <Tip label={isPipeline ? "Win rate (pipeline)" : "Win rate (decided)"}>
            {isPipeline ? (
              <>
                Of everything that's actually been bid — decided {rangeInfo.phrase}, plus bids still active past the
                qualification stage (Submitted through Watch List) — what share are wins, counted by {isValue ? "dollar value" : "number of bids"}.
                RFQ, Invitation and Estimating aren't counted (nothing's been bid yet); {archivedNote}.<br /><br />
                <strong>{show(pipeline?.complete)} Awarded</strong> ÷ (<strong>{show(pipeline?.complete)}</strong> Awarded + <strong>{show(pipeline?.lost)}</strong> Lost + <strong>{show(pipeline?.midlate)}</strong> still active) = <strong>{fmtPct(pipelineRate)}</strong>
              </>
            ) : (
              <>
                Of bids decided {rangeInfo.phrase} — Awarded or Lost, {archivedNote} — what share were wins, counted by{" "}
                {isValue ? "dollar value" : "number of bids"}. Bids still in play don't dilute it.<br /><br />
                <strong>{show(decided?.complete)} Awarded</strong> ÷ (<strong>{show(decided?.complete)}</strong> Awarded + <strong>{show(decided?.lost)}</strong> Lost) = <strong>{fmtPct(decidedRate)}</strong>
              </>
            )}
            {valueNote && <><br /><br />{valueNote}</>}
            <br /><br />{statusNote}
            {isPipeline && <> The "still active" bids are the ones open right now (created before the period ended).</>}
          </Tip>
          <div className="kv-value mono stat">{fmtPct(overallRate)}</div>
          <div className="tabs" style={{ marginTop: 8, marginBottom: 0 }}>
            {RATE_MODES.map((m) => (
              <button key={m.key} className={`tab ${rateMode === m.key ? "active" : ""}`} onClick={() => setRateMode(m.key)} style={{ padding: "2px 8px", fontSize: 11 }}>
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <div className="card">
          <Tip label="Won / Lost">
            Bids decided {rangeInfo.phrase} — Awarded and Lost ({archivedNote}), counted by {isValue ? "dollar value" : "number of bids"}.
            The same figures sit behind the win rate. Switch between "# Bids" and "$ Value" at the top right to see both.<br /><br />{statusNote}
          </Tip>
          <div className="kv-value mono stat">{show(wonLost.complete)} / {show(wonLost.lost)}</div>
        </div>

        <div className="card">
          <Tip label="Total bids tracked">
            Every bid created {rangeInfo.phrase}, whatever stage it's in now — including ones still in RFQ or Estimating,
            and ones already Awarded, Lost or No Bid.<br /><br />
            <strong>{fmtNum(summary.total_bids)} bids</strong>, of which {fmtNum(summary.valued_count)} have an estimate, totalling <strong>{fmtMoney(summary.total_value)}</strong>.
          </Tip>
          <div className="kv-value mono stat">{isValue ? fmtMoney(summary.total_value) : fmtNum(summary.total_bids)}</div>
        </div>

        <div className="card">
          <Tip label="Avg bid value">
            The average estimate across bids created {rangeInfo.phrase} that have one. Bids with no estimate yet are left
            out so they don't drag the average down.<br /><br />
            <strong>{fmtMoney(summary.total_value)}</strong> ÷ <strong>{fmtNum(summary.valued_count)}</strong> bids with an estimate = <strong>{fmtMoney(summary.avg_bid_value)}</strong>.
          </Tip>
          <div className="kv-value mono stat">{fmtMoney(summary.avg_bid_value)}</div>
        </div>

        <div className="card">
          <Tip label="Avg won bid value">
            The average value of a bid Awarded {rangeInfo.phrase} ({archivedNote}). An Awarded bid counts at its
            confirmed final value where one was entered, otherwise at its estimate; bids with neither are left out.<br /><br />
            <strong>{fmtMoney(summary.pipeline_win_rate_value_components?.complete)}</strong> across{" "}
            <strong>{fmtNum(summary.avg_won_value_count)}</strong> won bids with a value = <strong>{summary.avg_won_value != null ? fmtMoney(summary.avg_won_value) : "—"}</strong>.<br /><br />
            For comparison, the average <em>lost</em> bid is {summary.avg_lost_value != null ? fmtMoney(summary.avg_lost_value) : "—"} ({fmtNum(summary.avg_lost_value_count)} with a value) — which is why winning
            by number of bids and by dollars give such different rates.
          </Tip>
          <div className="kv-value mono stat">{summary.avg_won_value != null ? fmtMoney(summary.avg_won_value) : "—"}</div>
        </div>

        <div className="card">
          <Tip label="Overdue follow-ups">
            Open bids created {rangeInfo.phrase} whose follow-up date has passed with nothing done about it.
            Logging a tender email on a bid resets its follow-up date; how many days each stage waits is set in
            HELM → CRM Options.<br /><br />
            <strong>{fmtNum(summary.overdue_followups)}</strong> overdue right now.
          </Tip>
          <div className="kv-value mono stat" style={{ color: summary.overdue_followups > 0 ? "var(--red)" : undefined }}>{fmtNum(summary.overdue_followups)}</div>
        </div>

        <div className="card">
          <Tip label={`Follow-ups completed (${rangeInfo.label})`}>
            Outbound tender emails logged {rangeInfo.phrase} — one each time someone uses "Open in mail app &amp; log" on a bid.
            It counts every logged email, not only ones sent from the Follow-ups tab.<br /><br />
            <strong>{fmtNum(summary.followups_completed)}</strong> logged {rangeInfo.phrase}.
          </Tip>
          <div className="kv-value mono stat">{fmtNum(summary.followups_completed)}</div>
        </div>

        <div className="card">
          <Tip label="Hot leads flagged">
            Customers currently flagged as hot leads (which nudges SCOUT's scoring in their favour). This one ignores the
            date filter — it's a count of flags in place right now. A flag prompts for renewal at 30 days and clears itself at 37
            unless someone renews it.<br /><br />
            <strong>{fmtNum(summary.hot_leads)}</strong> flagged.
          </Tip>
          <div className="kv-value mono stat">🔥 {fmtNum(summary.hot_leads)}</div>
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

      <div style={{ marginBottom: 24 }}>
        <CustomerTable
          rows={summary.by_company || []}
          basis={basis}
          mode={rateMode}
          overallRate={overallRate}
          periodPhrase={rangeInfo.phrase}
        />
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
    </>
  );
}
