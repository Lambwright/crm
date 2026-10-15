import { useEffect, useState } from "react";
import { api } from "../api.js";
import Tip from "./Tip.jsx";
import { SERIES, StackedColumns, GroupedBars } from "./charts.jsx";
import ScoutImport from "./ScoutImport.jsx";

// SCOUT prequalification stats (Ben, 2026-10-16). Prequalification began June 8
// 2026 with the scoring spreadsheet; SCOUT's app took over in late July; both are
// one program here. Activity (top tiles and charts) follows the period filter, by
// when each bid was scored. The "does it help" comparison groups bids by when they
// arrived and ignores the filter.
const FY_NOW = (() => { const n = new Date(); return n.getMonth() >= 9 ? n.getFullYear() + 1 : n.getFullYear(); })();
const RANGES = [
  { key: "all", label: "All Time", phrase: "at any time" },
  { key: "fy", label: `This Fiscal Year (FY${FY_NOW})`, phrase: `this fiscal year` },
  { key: "last_fy", label: `Last Fiscal Year (FY${FY_NOW - 1})`, phrase: "last fiscal year" },
  { key: "year", label: "This Calendar Year", phrase: "this calendar year" },
  { key: "quarter", label: "This Quarter", phrase: "this quarter" },
  { key: "month", label: "This Month", phrase: "this month" },
  { key: "week", label: "This Week", phrase: "this week" },
  { key: "last_week", label: "Last Week", phrase: "last week" },
  { key: "custom", label: "Custom range…", phrase: "in the chosen dates" },
];
const money = (n) => `$${Math.round(n || 0).toLocaleString()}`;
const num = (n) => Number(n || 0).toLocaleString();
const pct = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const TIERS = [
  { key: "A", label: "Tier A", color: SERIES[1] },
  { key: "B", label: "Tier B", color: SERIES[2] },
  { key: "C", label: "Tier C", color: SERIES[3] },
  { key: "No bid", label: "No Bid", color: SERIES[4] },
];

function cohortRates(c, basis, mode) {
  const v = basis === "value";
  const won = v ? c.complete_value : c.complete;
  const lost = v ? c.lost_value : c.lost;
  const open = v ? c.midlate_value : c.midlate;
  const denom = won + lost + (mode === "pipeline" ? open : 0);
  return denom > 0 ? won / denom : null;
}

function Tile({ label, tip, value, color }) {
  return (
    <div className="card">
      <Tip label={label}>{tip}</Tip>
      <div className="kv-value mono stat" style={color ? { color } : undefined}>{value}</div>
    </div>
  );
}

export default function ScoutStats({ access }) {
  const [range, setRange] = useState("all");
  const [from, setFrom] = useState("2026-06-08");
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [basis, setBasis] = useState("count");
  const [mode, setMode] = useState("pipeline");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setData((d) => (range === "custom" && d && d.period?.key === "custom" ? d : null));
    let live = true;
    api.getScoutStats(range, from, to).then((d) => live && setData(d)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [range, from, to, reload]);

  if (error) return <div className="card" style={{ color: "var(--red)" }}>{error}</div>;
  if (!data || data.period.key !== range) return <div className="spinner-inline">Loading…</div>;

  const info = range === "custom" ? { label: "Custom range", phrase: `from ${from} to ${to}` } : RANGES.find((r) => r.key === range);
  const isValue = basis === "value";
  const c = data.cohorts;
  const since = data.prequal_start ? new Date(data.prequal_start + "T12:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
  const total = data.unique_bids;
  const tierCount = (k) => data.tiers[k] || 0;
  const tierShare = (k) => (total ? ` (${Math.round((tierCount(k) / total) * 100)}%)` : "");

  const weekly = data.weekly.map((w) => ({
    label: `Week of ${new Date(w.week + "T12:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" })}`,
    short: new Date(w.week + "T12:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    parts: { A: w.A, B: w.B, C: w.C, "No bid": w["No bid"] },
  }));
  const monthly = data.monthly.map((m) => ({
    label: new Date(m.month + "-15T12:00:00Z").toLocaleDateString(undefined, { month: "long", year: "numeric" }),
    short: new Date(m.month + "-15T12:00:00Z").toLocaleDateString(undefined, { month: "short" }),
    parts: { overrides: m.overrides, score: m.declined_score, disq: m.declined_disqualifier, person: m.declined_person },
  }));
  const tierRates = TIERS.map((t) => {
    const r = data.by_tier.find((x) => x.tier === t.key);
    const decided = r ? r.won + r.lost : 0;
    return { label: t.label, values: { rate: decided ? r.won / decided : null }, notes: { rate: r ? `${r.won} won of ${decided} decided, ${r.open} still open` : "no bids" } };
  });
  const COHORT_SERIES = [
    { key: "before", label: `Before ${since}`, color: SERIES[1] },
    { key: "scout", label: "After: through SCOUT", color: SERIES[2] },
    { key: "other", label: "After: not through SCOUT", color: SERIES[3] },
  ];
  const cohortFor = { before: c.before, scout: c.after_scout, other: c.after_other };
  const rateGroup = [{
    label: `${mode === "pipeline" ? "Pipeline" : "Decided"} win rate, ${isValue ? "by dollars" : "by bids"}`,
    values: Object.fromEntries(COHORT_SERIES.map((s) => [s.key, cohortRates(cohortFor[s.key], basis, mode)])),
    notes: Object.fromEntries(COHORT_SERIES.map((s) => [s.key, `${cohortFor[s.key].created} bids, ${cohortFor[s.key].complete} won, ${cohortFor[s.key].lost} lost`])),
  }];
  const avg = (sum, n) => (n ? sum / n : null);
  const avgGroups = [
    { label: "Average bid", values: Object.fromEntries(COHORT_SERIES.map((s) => [s.key, avg(cohortFor[s.key].est_sum, cohortFor[s.key].est_n)])), notes: Object.fromEntries(COHORT_SERIES.map((s) => [s.key, `${cohortFor[s.key].est_n} bids with an estimate`])) },
    { label: "Average won bid", values: Object.fromEntries(COHORT_SERIES.map((s) => [s.key, avg(cohortFor[s.key].won_sum, cohortFor[s.key].won_n)])), notes: Object.fromEntries(COHORT_SERIES.map((s) => [s.key, `${cohortFor[s.key].won_n} won bids`])) },
  ];
  const k = (v) => (v >= 1000 ? `$${Math.round(v / 100) / 10}K` : `$${Math.round(v)}`);

  const dec = data.declined;
  const o = data.outcomes;

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 8 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-secondary)" }}>
          Period
          <select value={range} onChange={(e) => setRange(e.target.value)} style={{ minWidth: 220 }}>
            {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        </label>
        {range === "custom" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-secondary)" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>From <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>To <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
          </div>
        )}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <div className="tabs" style={{ marginBottom: 0 }}>
            {[["pipeline", "Pipeline"], ["decided", "Decided"]].map(([key, label]) => (
              <button key={key} className={`tab ${mode === key ? "active" : ""}`} onClick={() => setMode(key)}>{label}</button>
            ))}
          </div>
          <div className="tabs" style={{ marginBottom: 0 }}>
            {[["count", "# Bids"], ["value", "$ Value"]].map(([key, label]) => (
              <button key={key} className={`tab ${basis === key ? "active" : ""}`} onClick={() => setBasis(key)}>{label}</button>
            ))}
          </div>
        </div>
      </div>
      <p className="field-help" style={{ marginBottom: 14 }}>
        Prequalification began {since} with the scoring spreadsheet; SCOUT's app took over in late July. Both are counted together.
        The tiles and the first charts show what was scored {info.phrase}. The comparison further down ignores the period.
      </p>

      <div className="kv-grid" style={{ marginBottom: 20 }}>
        <Tile label="Unique bids prequalified" value={num(total)} tip={<>Each project scored {info.phrase}, counted once however many times it was re-run (same company and project name, ignoring case and punctuation; the latest run counts). Test entries are excluded.<br /><br />{num(data.total_runs)} scoring runs in total, {num(total)} unique bids in this period.</>} />
        <Tile label="Tier A" value={`${num(tierCount("A"))}${tierShare("A")}`} tip="Scored 80–100: high priority, submit." />
        <Tile label="Tier B" value={`${num(tierCount("B"))}${tierShare("B")}`} tip="Scored 69–79: medium priority, qualify further." />
        <Tile label="Tier C" value={`${num(tierCount("C"))}${tierShare("C")}`} tip="Scored 58–68: low priority. SCOUT now lets Tier C through without an override." />
        <Tile label="No Bid" value={`${num(tierCount("No bid"))}${tierShare("No bid")}`} tip="Scored below 58, or hit an automatic disqualifier (any one forces No Bid)." />
        <Tile label="Overrides" value={num(data.overrides)} tip="A No Bid that leadership submitted anyway (needs a reason and an approver). Counted from bids scored No Bid that were submitted, not from the free-text Override field, which people also use for notes." />
        <Tile label="Declined (total)" value={num(dec.total)} tip={<>Bids someone declined in SCOUT.<br /><br /><strong>{num(dec.by_score)}</strong> by score alone (No Bid with no disqualifier), <strong>{num(dec.by_disqualifier)}</strong> by an automatic disqualifier, <strong>{num(dec.by_person)}</strong> declined by a person despite a passing tier, {num(dec.other)} with no tier recorded.</>} />
        <Tile label="Declined by score" value={num(dec.by_score)} tip="Scored No Bid on points with no disqualifier triggered." />
        <Tile label="Declined by disqualifier" value={num(dec.by_disqualifier)} tip="At least one automatic disqualifier was triggered. Only recorded since SCOUT began sending the list; older log rows carry it too where it was filled in." />
        <Tile label="Won (Awarded)" color="var(--green)" value={num(o.won)} tip={<>Prequalified, submitted bids that are now Awarded in CRM. {num(o.lost)} lost, {num(o.open)} still open, {num(o.no_record)} with no matching bid record (for example not pushed to Procore).</>} />
        <Tile label="Became a project" value={num(o.became_project)} tip="Won bids that now have a Procore project (HANDOFF created the project)." />
        <Tile label="Value of won bids" value={money(o.won_value)} tip={<>The confirmed final value where one is entered, otherwise the bid's estimate, summed over the won bids above. Contract value plus change orders, and payments received, will come from LEDGER; until then this is the best CRM has.</>} />
      </div>

      <div className="stat-chart-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 16, marginBottom: 20 }}>
        <StackedColumns title="Bids prequalified per week, by tier" subtitle="Unique bids by the week they were scored" data={weekly} series={TIERS} />
        <StackedColumns
          title="Overrides and declines per month"
          subtitle="Declines split by why"
          data={monthly}
          series={[
            { key: "overrides", label: "Overrides", color: SERIES[1] },
            { key: "score", label: "Declined by score", color: SERIES[2] },
            { key: "disq", label: "Declined by disqualifier", color: SERIES[3] },
            { key: "person", label: "Declined by a person", color: SERIES[4] },
          ]}
        />
        <GroupedBars
          title="Win rate by tier"
          subtitle="Submitted bids only: won ÷ (won + lost), bids still open not counted"
          groups={tierRates}
          series={[{ key: "rate", label: "Win rate", color: SERIES[1] }]}
          format={(v) => `${Math.round(v * 100)}%`}
          max={1}
        />
      </div>

      <div className="card-title" style={{ marginBottom: 6 }}>
        <Tip label="Does prequalification help?" className="card-title">
          Bids are grouped by when they <strong>arrived</strong> (the bid's creation date; for older bids the due date), and judged by what happened to them since. Before {since} is the starting point.
          After {since} is split into bids that went through SCOUT and bids that didn't. <strong>That last comparison isn't like for like:</strong> bids sent outside SCOUT are usually ones
          we already knew we wanted, so they should win more. Use the before and after comparison as the real test. Archived bids are left out unless CRM recorded the decision.
          This section ignores the period filter.
        </Tip>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 16, marginBottom: 20 }}>
        <GroupedBars
          title={`Win rate: before and after ${since}`}
          subtitle={`${mode === "pipeline" ? "Won ÷ (won + lost + still open after qualification)" : "Won ÷ (won + lost)"}, by ${isValue ? "dollars" : "number of bids"}`}
          groups={rateGroup}
          series={COHORT_SERIES}
          format={(v) => `${Math.round(v * 100)}%`}
          max={1}
        />
        <GroupedBars title="Average bid and average won bid" subtitle="Estimate (final value for won bids where entered); bids with no value are left out" groups={avgGroups} series={COHORT_SERIES} format={k} />
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-title">Cohort numbers</div>
        <table className="data-table">
          <thead><tr><th>Group</th><th className="num">Bids arrived</th><th className="num">Won</th><th className="num">Lost</th><th className="num">Open</th><th className="num">Decided rate</th><th className="num">Pipeline rate</th></tr></thead>
          <tbody>
            {[["Before " + since, c.before], ["After: all bids", c.after_all], ["After: through SCOUT", c.after_scout], ["After: not through SCOUT", c.after_other]].map(([label, x]) => (
              <tr key={label}>
                <td>{label}</td><td className="num">{num(x.created)}</td><td className="num">{num(isValue ? Math.round(x.complete_value) : x.complete)}</td><td className="num">{num(isValue ? Math.round(x.lost_value) : x.lost)}</td>
                <td className="num">{num(isValue ? Math.round(x.midlate_value) : x.midlate)}</td><td className="num">{pct(cohortRates(x, basis, "decided"))}</td><td className="num">{pct(cohortRates(x, basis, "pipeline"))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {access?.can?.admin === true && <ScoutImport onImported={() => setReload((n) => n + 1)} />}
    </>
  );
}
