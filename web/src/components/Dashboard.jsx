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
  if (range === "week" || range === "last_week") return `${rangeInfo.label}: ${weekCaption(range)} (Monday to Sunday).`;
  if (range === "all") return "Showing every bid on record.";
  const f = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  if ((range === "fy" || range === "last_fy") && period) {
    const start = new Date(period.start);
    const end = period.end ? new Date(new Date(period.end).getTime() - 86400000) : null; // end is exclusive
    return `${rangeInfo.label}: ${f(start)} – ${end ? f(end) : "today"}. Showing bids created in that period.`;
  }
  return `Showing bids created ${rangeInfo.phrase}.`;
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
  if (!summary || (summary.period && summary.period.key !== range)) return <div className="spinner-inline">Loading…</div>;

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

  const archivedNote = summary.include_archived ? "archived bids included" : "archived bids excluded";
  const cohortNote = "Judged by when each bid was created, so for a recent or short period most bids haven't been decided yet and this can read zero — the \"by actual date\" section below counts what was decided in the period.";

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
          <Tip label="Win rate (decided)">
            Of bids that have actually been decided one way or the other — Awarded or Lost, {archivedNote} —
            what share were wins, counted by {isValue ? "dollar value" : "number of bids"}.<br /><br />
            <strong>{show(decided?.complete)} Awarded</strong> ÷ (<strong>{show(decided?.complete)}</strong> Awarded + <strong>{show(decided?.lost)}</strong> Lost) = <strong>{fmtPct(decidedRate)}</strong>
            {valueNote && <><br /><br />{valueNote}</>}
            <br /><br />{cohortNote}
          </Tip>
          <div className="kv-value mono stat">{fmtPct(decidedRate)}</div>
        </div>

        <div className="card">
          <Tip label="Win rate (pipeline)">
            Of everything that's actually been bid — Awarded, Lost, or still active past the qualification stage
            (Submitted through Watch List) — what share are wins, counted by {isValue ? "dollar value" : "number of bids"}.
            RFQ, Invitation and Estimating aren't counted (nothing's been bid yet); {archivedNote}.<br /><br />
            <strong>{show(pipeline?.complete)} Awarded</strong> ÷ (<strong>{show(pipeline?.complete)}</strong> Awarded + <strong>{show(pipeline?.lost)}</strong> Lost + <strong>{show(pipeline?.midlate)}</strong> still active) = <strong>{fmtPct(pipelineRate)}</strong>
            {valueNote && <><br /><br />{valueNote}</>}
            <br /><br />{cohortNote}
          </Tip>
          <div className="kv-value mono stat">{fmtPct(pipelineRate)}</div>
        </div>

        <div className="card">
          <Tip label="Won / Lost">
            The plain totals behind the win rates above — Awarded and Lost bids ({archivedNote}), counted by {isValue ? "dollar value" : "number of bids"}.
            Switch between "# Bids" and "$ Value" at the top right to see both.<br /><br />{cohortNote}
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
            The average value of an Awarded bid created {rangeInfo.phrase} ({archivedNote}). An Awarded bid counts at its
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
          <Tip label="Won this period">
            Bids moved to Awarded {rangeInfo.phrase}, judged by when they were actually awarded — not when the bid was
            created. Awards made in CRM or picked up by the Procore sync are counted; the one-time historical import
            has no real award dates, so for a specific period it's left out (it still counts under All Time).<br /><br />
            <strong>{fmtNum(summary.won_in_range?.count)}</strong> bids, <strong>{fmtMoney(summary.won_in_range?.value)}</strong> (final value where entered, otherwise the estimate).
          </Tip>
          <div className="kv-value mono stat" style={{ color: "var(--green)" }}>{isValue ? fmtMoney(summary.won_in_range?.value) : fmtNum(summary.won_in_range?.count)}</div>
        </div>
        <div className="card">
          <Tip label="Lost this period">
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

      <div style={{ marginBottom: 24 }}>
        <CustomerTable rows={summary.by_company || []} basis={basis} overallRate={isValue ? summary.decided_win_rate_value : summary.decided_win_rate} periodPhrase={rangeInfo.phrase} />
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
