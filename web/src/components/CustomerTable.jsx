import { useMemo, useState } from "react";
import Tip from "./Tip.jsx";

// A customer within this many percentage points of our overall win rate counts
// as "at" average; further above is "over", further below is "under".
const AT_BAND = 0.05;

function fmtMoney(n) {
  return `$${Math.round(n || 0).toLocaleString()}`;
}
function fmtNum(n) {
  return Number(n || 0).toLocaleString();
}
function fmtPct(n) {
  return n != null ? `${Math.round(n * 100)}%` : "—";
}

const COLS = [
  { key: "name", label: "Customer", num: false, firstDir: "asc" },
  { key: "all", label: "All bids", num: true, firstDir: "desc" },
  { key: "submitted", label: "Submitted", num: true, firstDir: "desc" },
  { key: "won", label: "Won", num: true, firstDir: "desc" },
  { key: "lost", label: "Lost", num: true, firstDir: "desc" },
  { key: "rate", label: "Win rate", num: true, firstDir: "desc" },
  { key: "band", label: "vs average", num: true, firstDir: "desc" },
];

// One row per customer with a bid in the period (Ben, 2026-10-06): the number
// and dollar value of all bids, bids actually submitted, and won / lost,
// following the page's "# Bids | $ Value" toggle, plus each customer's win rate
// against our overall one so the strong and weak accounts stand out.
export default function CustomerTable({ rows, basis, overallRate, periodPhrase }) {
  const isValue = basis === "value";
  const [sort, setSort] = useState({ key: "all", dir: "desc" });
  const [minDecided, setMinDecided] = useState(3);
  const [limit, setLimit] = useState(15);

  const computed = useMemo(
    () =>
      (rows || []).map((r) => {
        const decidedCount = r.won_count + r.lost_count;
        const won = isValue ? r.won_value : r.won_count;
        const lost = isValue ? r.lost_value : r.lost_count;
        const rate = won + lost > 0 ? won / (won + lost) : null;
        const enough = decidedCount >= minDecided;
        const diff = enough && rate != null && overallRate != null ? rate - overallRate : null;
        const band = diff == null ? null : diff > AT_BAND ? "over" : diff < -AT_BAND ? "under" : "at";
        return {
          ...r,
          decidedCount,
          all: isValue ? r.all_value : r.all_count,
          submitted: isValue ? r.submitted_value : r.submitted_count,
          won,
          lost,
          rate,
          enough,
          diff,
          band,
        };
      }),
    [rows, isValue, minDecided, overallRate]
  );

  const sorted = useMemo(() => {
    const val = (r) => {
      if (sort.key === "name") return r.name.toLowerCase();
      if (sort.key === "rate") return r.enough && r.rate != null ? r.rate : -1; // too-few-bids sort last
      if (sort.key === "band") return r.diff == null ? -Infinity : r.diff;
      return r[sort.key];
    };
    return [...computed].sort((a, b) => {
      const va = val(a), vb = val(b);
      const cmp = typeof va === "string" ? va.localeCompare(vb) : va - vb;
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [computed, sort]);

  const shown = limit === 0 ? sorted : sorted.slice(0, limit);
  const money = (n) => (isValue ? fmtMoney(n) : fmtNum(n));

  function toggleSort(col) {
    setSort((s) => (s.key === col.key ? { key: s.key, dir: s.dir === "asc" ? "desc" : "asc" } : { key: col.key, dir: col.firstDir }));
  }

  return (
    <div>
      <Tip label="Customers" className="card-title">
        Every customer with a bid created {periodPhrase}, shown {isValue ? "by dollar value" : "by number of bids"} — switch with
        the "# Bids | $ Value" buttons at the top.<br /><br />
        <strong>All bids</strong>: everything created in the period. <strong>Submitted</strong>: bids actually bid — Submitted
        through Watch List, plus Awarded and Lost. <strong>Won / Lost</strong>: bids decided either way.<br /><br />
        <strong>Win rate</strong>: Won ÷ (Won + Lost) for that customer. <strong>vs average</strong> compares it to our overall
        decided win rate ({fmtPct(overallRate)} on this basis): <em>Over</em> is more than 5 points above, <em>Under</em> more than
        5 points below, <em>At</em> is within 5. A customer needs at least {minDecided} decided bids to be rated — one win in one
        bid isn't a 100% customer.
      </Tip>

      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", margin: "6px 0 10px" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)" }}>
          Rate a customer after
          <select value={minDecided} onChange={(e) => setMinDecided(Number(e.target.value))}>
            {[1, 3, 5, 10].map((n) => <option key={n} value={n}>{n}+ decided bids</option>)}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)" }}>
          Show
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            <option value={15}>Top 15</option>
            <option value={50}>Top 50</option>
            <option value={0}>All customers</option>
          </select>
        </label>
        <span className="field-help">Click a column to sort. Overall win rate for comparison: <strong>{fmtPct(overallRate)}</strong></span>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            {COLS.map((c) => (
              <th key={c.key} className={c.num ? "num" : undefined} style={{ cursor: "pointer", userSelect: "none" }} onClick={() => toggleSort(c)}>
                {c.label}{sort.key === c.key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td className="num">{money(r.all)}</td>
              <td className="num">{money(r.submitted)}</td>
              <td className="num" style={{ color: r.won > 0 ? "var(--green)" : undefined }}>{money(r.won)}</td>
              <td className="num" style={{ color: r.lost > 0 ? "var(--text-tertiary)" : undefined }}>{money(r.lost)}</td>
              <td className="num">{r.enough ? fmtPct(r.rate) : <span title={`Fewer than ${minDecided} decided bids (${r.decidedCount})`} style={{ color: "var(--text-tertiary)" }}>—</span>}</td>
              <td className="num">
                {r.band === "over" && <span style={{ color: "var(--green)" }}>▲ Over <small>(+{Math.round(r.diff * 100)})</small></span>}
                {r.band === "at" && <span style={{ color: "var(--text-secondary)" }}>● At</span>}
                {r.band === "under" && <span style={{ color: "var(--red)" }}>▼ Under <small>({Math.round(r.diff * 100)})</small></span>}
                {!r.band && <span style={{ color: "var(--text-tertiary)" }}>—</span>}
              </td>
            </tr>
          ))}
          {shown.length === 0 && (
            <tr><td colSpan={COLS.length} className="empty-state">No bids in this period.</td></tr>
          )}
        </tbody>
      </table>
      <div className="field-help" style={{ marginTop: 6 }}>
        Showing {shown.length} of {sorted.length} customers.
      </div>
    </div>
  );
}
