import { useEffect, useState } from "react";
import { api } from "../api.js";
import { STAGE_LABELS, STAGE_ORDER } from "../stages.js";

const RANGES = [
  { key: "all", label: "All Time", phrase: "at any time" },
  { key: "year", label: "This Year", phrase: "this year" },
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

// A stat label with a hover explanation — the formula in plain language
// plus the actual numbers behind the current figure, so nobody has to take
// the percentage on faith (Ben, 2026-09-29).
function Tip({ label, children }) {
  return (
    <div className="kv-label stat-tooltip-wrap">
      {label}
      <span className="stat-tooltip-icon">?</span>
      <div className="stat-tooltip-popup">{children}</div>
    </div>
  );
}

export default function Dashboard() {
  const [range, setRange] = useState("all");
  const [basis, setBasis] = useState("count");
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setSummary(null);
    api.getDashboardSummary(range).then(setSummary).catch((e) => setError(e.message));
  }, [range]);

  if (error) return <div className="card" style={{ color: "var(--red)" }}>{error}</div>;
  if (!summary) return <div className="spinner-inline">Loading…</div>;

  const rangeInfo = RANGES.find((r) => r.key === range);
  const byStage = Object.fromEntries((summary.by_stage || []).map((r) => [r.stage, r]));
  const openRows = (summary.by_stage || []).filter((r) => !["complete", "lost", "no_bid"].includes(r.stage));
  const totalPipeline = openRows.reduce((sum, r) => sum + Number(r.pipeline_value || 0), 0);
  const openCount = openRows.reduce((sum, r) => sum + Number(r.count || 0), 0);

  const isValue = basis === "value";
  const show = (n) => (isValue ? fmtMoney(n) : fmtNum(n));

  const decided = isValue ? summary.decided_win_rate_value_components : summary.decided_win_rate_components;
  const pipeline = isValue ? summary.pipeline_win_rate_value_components : summary.pipeline_win_rate_components;
  const decidedRate = isValue ? summary.decided_win_rate_value : summary.decided_win_rate;
  const pipelineRate = isValue ? summary.pipeline_win_rate_value : summary.pipeline_win_rate;
  const wonLost = decided || { complete: 0, lost: 0 };

  const valueNote = isValue
    ? "An Awarded bid counts at its confirmed final value where one was entered, otherwise at its estimate (most older wins never had a final value keyed in); Lost and still-active bids count at their estimate."
    : null;

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 8 }}>
        <div className="tabs" style={{ marginBottom: 0 }}>
          {RANGES.map((r) => (
            <button key={r.key} className={`tab ${range === r.key ? "active" : ""}`} onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
        <div className="tabs" style={{ marginBottom: 0 }} title="Switch the tiles that have both between a count of bids and their dollar value">
          {BASES.map((b) => (
            <button key={b.key} className={`tab ${basis === b.key ? "active" : ""}`} onClick={() => setBasis(b.key)}>
              {b.label}
            </button>
          ))}
        </div>
      </div>
      <p className="field-help" style={{ marginBottom: 14 }}>
        {range === "week" || range === "last_week"
          ? `${rangeInfo.label}: ${weekCaption(range)} (Monday to Sunday).`
          : range === "all"
            ? "Showing every bid on record."
            : `Showing bids created ${rangeInfo.phrase}.`}
      </p>

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
          <Tip label="Win rate (decided)">
            Of bids that have actually been decided one way or the other — Awarded or Lost, not counting anything
            Procore has archived — what share were wins, counted by {isValue ? "dollar value" : "number of bids"}.<br /><br />
            <strong>{show(decided?.complete)} Awarded</strong> ÷ (<strong>{show(decided?.complete)}</strong> Awarded + <strong>{show(decided?.lost)}</strong> Lost) = <strong>{fmtPct(decidedRate)}</strong>
            {valueNote && <><br /><br />{valueNote}</>}
          </Tip>
          <div className="kv-value mono stat">{fmtPct(decidedRate)}</div>
        </div>

        <div className="card">
          <Tip label="Win rate (pipeline)">
            Of everything that's actually been bid — Awarded, Lost, or still active past the qualification stage
            (Submitted through Watch List) — what share are wins, counted by {isValue ? "dollar value" : "number of bids"}.
            RFQ, Invitation and Estimating aren't counted (nothing's been bid yet), and neither is anything archived.<br /><br />
            <strong>{show(pipeline?.complete)} Awarded</strong> ÷ (<strong>{show(pipeline?.complete)}</strong> Awarded + <strong>{show(pipeline?.lost)}</strong> Lost + <strong>{show(pipeline?.midlate)}</strong> still active) = <strong>{fmtPct(pipelineRate)}</strong>
            {valueNote && <><br /><br />{valueNote}</>}
          </Tip>
          <div className="kv-value mono stat">{fmtPct(pipelineRate)}</div>
        </div>

        <div className="card">
          <Tip label="Won / Lost">
            The plain totals behind the win rates above — Awarded and Lost bids, archived excluded, counted by {isValue ? "dollar value" : "number of bids"}.
            Switch between "# Bids" and "$ Value" at the top right to see both.
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

      <div className="card-title">Created / Won / Lost {rangeInfo.phrase}, by actual date</div>
      <p className="field-help" style={{ marginBottom: 10, maxWidth: 720 }}>
        The figures above are a snapshot of the pipeline as it stands. These use each bid's real stage-change
        date instead — so a bid opened months ago that just got awarded this week shows up here, not lumped into
        "bids created."
      </p>
      <div className="kv-grid" style={{ marginBottom: 20 }}>
        <div className="card">
          <Tip label="Bids created">
            Bids that came in {rangeInfo.phrase} (by the date the bid was created), in whatever stage they are now.<br /><br />
            <strong>{fmtNum(summary.total_bids)} bids</strong> worth <strong>{fmtMoney(summary.total_value)}</strong> in estimates.
          </Tip>
          <div className="kv-value mono stat">{isValue ? fmtMoney(summary.total_value) : fmtNum(summary.total_bids)}</div>
        </div>
        <div className="card">
          <Tip label="Won this range">
            Bids moved to Awarded {rangeInfo.phrase}, judged by when they were actually awarded — not when the bid was
            created. Awards made in CRM or picked up by the Procore sync are counted; the one-time historical import
            has no real award dates, so for a specific period it's left out (it still counts under All Time).<br /><br />
            <strong>{fmtNum(summary.won_in_range?.count)}</strong> bids, <strong>{fmtMoney(summary.won_in_range?.value)}</strong> (final value where entered, otherwise the estimate).
          </Tip>
          <div className="kv-value mono stat" style={{ color: "var(--green)" }}>{isValue ? fmtMoney(summary.won_in_range?.value) : fmtNum(summary.won_in_range?.count)}</div>
        </div>
        <div className="card">
          <Tip label="Lost this range">
            Bids moved to Lost {rangeInfo.phrase}, judged by when they were actually marked lost — not when the bid
            was created. Same rule as Won: CRM moves and Procore-sync detections count; the historical import only counts under All Time.<br /><br />
            <strong>{fmtNum(summary.lost_in_range?.count)}</strong> bids, <strong>{fmtMoney(summary.lost_in_range?.value)}</strong> in estimates.
          </Tip>
          <div className="kv-value mono stat" style={{ color: "var(--text-tertiary)" }}>{isValue ? fmtMoney(summary.lost_in_range?.value) : fmtNum(summary.lost_in_range?.count)}</div>
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
