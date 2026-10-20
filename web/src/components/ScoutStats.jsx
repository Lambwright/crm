import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import Tip from "./Tip.jsx";
import { SERIES, StackedColumns, GroupedBars, CompareRows } from "./charts.jsx";
import ScoutImport from "./ScoutImport.jsx";
import ScoutLinkClients from "./ScoutLinkClients.jsx";

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

function WonProjects({ projects, onRefreshed }) {
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  if (!projects || projects.length === 0) return null;
  async function refresh(id) {
    setBusy(id); setMsg(null);
    try { const r = await api.refreshProjectFinancials(id); if (r.refresh_error) setMsg(`LEDGER couldn't refresh this project just now, so these are its last stored figures: ${r.refresh_error}`); onRefreshed(); }
    catch (e) { setMsg(e.data?.retry_after_seconds ? `${e.data.detail} Try again in about ${Math.ceil(e.data.retry_after_seconds / 60)} min.` : e.data?.detail || e.message); }
    finally { setBusy(null); }
  }
  const cell = (v) => (v == null ? "—" : money(v));
  return (
    <details style={{ marginBottom: 20 }}>
      <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Won projects ({projects.length})</summary>
      {msg && <div className="login-error" style={{ marginTop: 6 }}>{msg}</div>}
      <div style={{ overflowX: "auto", marginTop: 6 }}>
        <table className="data-table">
          <thead><tr><th>Project</th><th>Tier</th><th className="num">Estimate</th><th className="num">Contract</th><th className="num">Change orders</th><th className="num">Revised</th><th className="num">Invoiced</th><th>As of</th><th /></tr></thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p.bid_id}>
                <td>{p.project_name}</td>
                <td>{p.tier}</td>
                <td className="num">{cell(p.final_value ?? p.estimate)}</td>
                <td className="num">{cell(p.contract_value)}</td>
                <td className="num">{cell(p.approved_change_orders)}</td>
                <td className="num">{cell(p.revised_contract)}</td>
                <td className="num">{cell(p.invoiced_to_date)}</td>
                <td>{p.as_of ? new Date(p.as_of).toLocaleDateString() : "—"}</td>
                <td>{p.procore_project_id ? <button className="btn btn-ghost btn-sm" disabled={busy === p.procore_project_id} onClick={() => refresh(p.procore_project_id)}>{busy === p.procore_project_id ? "…" : "↻ Refresh"}</button> : <span className="row-secondary">no project yet</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
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

  const lastKey = useRef("");
  useEffect(() => {
    // Only blank the page when the period itself changed; a refresh after matching a
    // client keeps everything (including open lists) in place.
    const key = `${range}|${range === "custom" ? from + to : ""}`;
    if (lastKey.current !== key) { lastKey.current = key; setData((d) => (range === "custom" && d && d.period?.key === "custom" ? d : null)); }
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
    if (!r) return { label: t.label, values: { rate: null }, notes: { rate: "no bids" } };
    const won = isValue ? r.won_value : r.won;
    const lost = isValue ? r.lost_value : r.lost;
    const open = isValue ? r.open_value : r.open;
    const denom = won + lost + (mode === "pipeline" ? open : 0);
    return { label: t.label, values: { rate: denom ? won / denom : null }, notes: { rate: `${r.won} won, ${r.lost} lost, ${r.open} still open` } };
  });
  const COHORT_SERIES = [
    { key: "before", label: `Before prequalifying (before ${since})`, color: SERIES[1] },
    { key: "after", label: `After prequalifying (from ${since})`, color: SERIES[2] },
  ];
  const cohortFor = { before: c.before, after: c.after_all };
  const avg = (sum, n) => (n ? sum / n : null);
  const k = (v) => (v >= 1000 ? `$${Math.round(v / 100) / 10}K` : `$${Math.round(v)}`);
  const noteFor = (key) => `${cohortFor[key].created} bids, ${cohortFor[key].complete} won, ${cohortFor[key].lost} lost`;
  const rate = (key) => cohortRates(cohortFor[key], basis, mode);
  const rateDelta = rate("before") != null && rate("after") != null ? { up: rate("after") >= rate("before"), text: `${Math.abs(Math.round((rate("after") - rate("before")) * 100))} pts` } : null;
  const pctDelta = (b, a2) => (b && a2 != null ? { up: a2 >= b, text: `${Math.abs(Math.round(((a2 - b) / b) * 100))}%` } : null);
  const avgBid = { before: avg(c.before.est_sum, c.before.est_n), after: avg(c.after_all.est_sum, c.after_all.est_n) };
  const avgWon = { before: avg(c.before.won_sum, c.before.won_n), after: avg(c.after_all.won_sum, c.after_all.won_n) };
  const compareRows = [
    {
      label: `${mode === "pipeline" ? "Pipeline" : "Decided"} win rate, ${isValue ? "by dollars" : "by bids"}`,
      values: { before: rate("before"), after: rate("after") },
      format: (v) => `${Math.round(v * 100)}%`,
      max: 1,
      delta: rateDelta,
      notes: { before: noteFor("before"), after: noteFor("after") },
    },
    { label: "Average bid", values: avgBid, format: k, delta: pctDelta(avgBid.before, avgBid.after), notes: { before: `${c.before.est_n} bids with an estimate`, after: `${c.after_all.est_n} bids with an estimate` } },
    { label: "Average won bid", values: avgWon, format: k, delta: pctDelta(avgWon.before, avgWon.after), notes: { before: `${c.before.won_n} won bids`, after: `${c.after_all.won_n} won bids` } },
  ];

  const dec = data.declined;
  const o = data.outcomes;
  const fin = data.financials || { won_projects: 0, with_project_id: 0, with_figures: 0, projects: [] };

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
        <Tile label="Value of won bids (estimate)" value={money(o.won_value)} tip={<>The confirmed final value where one is entered, otherwise the bid's estimate, summed over the won bids above. The real contract figures from LEDGER are in the tiles that follow.</>} />
      </div>

      <div className="card-title" style={{ marginBottom: 6 }}>
        <Tip label="Won projects: money from LEDGER" className="card-title">
          For the won bids above that became a Procore project, LEDGER sends its contract figures to CRM whenever it refreshes a project (mostly overnight).
          Only projects LEDGER has read are summed, so the totals can be lower than the number of won projects until each has been refreshed.
          Contract value and approved change orders appear after a project's next LEDGER refresh. Payments received aren't available yet (LEDGER doesn't hold them).
        </Tip>
      </div>
      <div className="kv-grid" style={{ marginBottom: 8 }}>
        <Tile label="Contract value" value={fin.contract_value == null ? "—" : money(fin.contract_value)} tip="The original contract amounts on the won projects' approved prime contracts, pass-through contracts included." />
        <Tile label="Approved change orders" value={fin.approved_change_orders == null ? "—" : money(fin.approved_change_orders)} tip="Revised contract minus the original contract amounts." />
        <Tile label="Revised contract" value={fin.revised_contract == null ? "—" : money(fin.revised_contract)} tip="Contract value plus approved change orders: the real value of the work." />
        <Tile label="Invoiced to date" value={fin.invoiced_to_date == null ? "—" : money(fin.invoiced_to_date)} tip="Owner invoices to date, before retainage, drafts excluded." />
        <Tile label="Payments received" value={fin.paid_to_date == null ? "—" : money(fin.paid_to_date)} tip="Not available yet: LEDGER doesn't hold payments." />
      </div>
      <div className="field-help" style={{ marginBottom: 20 }}>
        {fin.with_figures} of {fin.won_projects} won projects have LEDGER figures{fin.won_projects > fin.with_project_id ? ` (${fin.won_projects - fin.with_project_id} haven't become a Procore project yet)` : ""}
        {fin.oldest_as_of ? `. Oldest reading: ${new Date(fin.oldest_as_of).toLocaleDateString()}.` : "."}
      </div>
      <WonProjects projects={fin.projects} onRefreshed={() => setReload((n) => n + 1)} />

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
          subtitle={`Submitted bids only. ${mode === "pipeline" ? "Won ÷ (won + lost + still open)" : "Won ÷ (won + lost)"}, by ${isValue ? "dollars" : "number of bids"}`}
          groups={tierRates}
          series={[{ key: "rate", label: "Win rate", color: SERIES[1] }]}
          format={(v) => `${Math.round(v * 100)}%`}
          max={1}
        />
      </div>

      <div className="card-title" style={{ marginBottom: 6 }}>
        <Tip label="Does prequalification help?" className="card-title">
          Bids are grouped by when they were <strong>created</strong> in CRM (for older bids, their due date), and judged by what happened to them since. Before {since} is the starting point.
          Prequalifying every bid started {since}, so that date is the line between the two groups. Archived bids are left out unless CRM recorded the decision.
          This section ignores the period filter.
        </Tip>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 16, marginBottom: 20 }}>
        <div style={{ gridColumn: "1 / -1" }}>
          <CompareRows
            title="Before and after prequalifying bids"
            subtitle={`Win rate: ${mode === "pipeline" ? "won ÷ (won + lost + still open after qualification)" : "won ÷ (won + lost)"}. Averages are estimates (final value for won bids where entered); bids with no value are left out. Each row has its own scale.`}
            rows={compareRows}
            series={COHORT_SERIES}
          />
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-title">Cohort numbers</div>
        <table className="data-table">
          <thead><tr><th>Group</th><th className="num">Bids created</th><th className="num">Submitted</th><th className="num">Won</th><th className="num">Lost</th><th className="num">Open</th><th className="num">Decided rate</th><th className="num">Pipeline rate</th></tr></thead>
          <tbody>
            {[["Before prequalifying", c.before], ["After prequalifying", c.after_all]].map(([label, x]) => (
              <tr key={label}>
                <td>{label}</td><td className="num">{num(x.created)}</td><td className="num">{num(x.complete + x.lost + x.midlate)}</td><td className="num">{num(isValue ? Math.round(x.complete_value) : x.complete)}</td><td className="num">{num(isValue ? Math.round(x.lost_value) : x.lost)}</td>
                <td className="num">{num(isValue ? Math.round(x.midlate_value) : x.midlate)}</td><td className="num">{pct(cohortRates(x, basis, "decided"))}</td><td className="num">{pct(cohortRates(x, basis, "pipeline"))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {access?.can?.admin === true && (
        <>
          <ScoutImport onImported={() => setReload((n) => n + 1)} />
          <ScoutLinkClients onChanged={() => setReload((n) => n + 1)} />
        </>
      )}
    </>
  );
}
