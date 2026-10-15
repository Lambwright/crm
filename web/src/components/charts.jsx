import { useState } from "react";

// Small SVG charts for the SCOUT stats tab. Specs follow the dataviz skill:
// categorical colors in fixed order (dark-surface steps; this app is dark),
// columns capped at 24px with a 4px rounded data end, 2px surface gaps between
// stacked segments, hairline gridlines, labels in text tokens (never the series
// color), a legend whenever there are 2+ series, a hover tooltip on every mark,
// and a table view so no value lives only in a color.
export const SERIES = {
  1: "#3987e5", // blue
  2: "#d95926", // orange
  3: "#199e70", // aqua
  4: "#c98500", // yellow
};
const GRID = "#3A3733";
const SURFACE = "#2A2724";
const INK = "#F1ECE1";
const INK2 = "#8A8375";

const niceMax = (v) => {
  if (v <= 5) return 5;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
};
const compact = (v) => (v >= 1000 ? `${Math.round(v / 100) / 10}K` : String(v));

function Legend({ series }) {
  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11, color: INK2, margin: "6px 0 2px" }}>
      {series.map((s) => (
        <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: s.color, display: "inline-block" }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

function ChartFrame({ title, subtitle, series, children, table }) {
  const [showTable, setShowTable] = useState(false);
  return (
    <div className="card" style={{ marginBottom: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div className="card-title">{title}</div>
        <button className="btn btn-ghost btn-sm" style={{ padding: "1px 8px", fontSize: 10 }} onClick={() => setShowTable((v) => !v)}>{showTable ? "Chart" : "Table"}</button>
      </div>
      {subtitle && <div className="field-help" style={{ marginBottom: 4 }}>{subtitle}</div>}
      {series && series.length > 1 && !showTable && <Legend series={series} />}
      {showTable ? table : children}
    </div>
  );
}

function DataTable({ head, rows }) {
  return (
    <table className="data-table" style={{ marginTop: 6 }}>
      <thead><tr>{head.map((h, i) => <th key={h} className={i ? "num" : undefined}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j ? "num" : undefined}>{c}</td>)}</tr>)}</tbody>
    </table>
  );
}

// ---- stacked columns: one column per category, segments per series -----------------
export function StackedColumns({ title, subtitle, data, series, emptyText = "No data in this period." }) {
  const [tip, setTip] = useState(null);
  const W = 640, H = 220, L = 34, R = 8, T = 10, B = 34;
  const totals = data.map((d) => series.reduce((s, k) => s + (d.parts[k.key] || 0), 0));
  const max = niceMax(Math.max(1, ...totals));
  const plotW = W - L - R, plotH = H - T - B;
  const slot = data.length ? plotW / data.length : plotW;
  const bw = Math.min(24, slot - 6);
  const y = (v) => T + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];
  const labelEvery = Math.max(1, Math.ceil(data.length / 10));
  const table = <DataTable head={["", ...series.map((s) => s.label), "Total"]} rows={data.map((d, i) => [d.label, ...series.map((s) => d.parts[s.key] || 0), totals[i]])} />;
  return (
    <ChartFrame title={title} subtitle={subtitle} series={series} table={table}>
      {!data.length ? <div className="empty-state">{emptyText}</div> : (
        <div style={{ position: "relative" }}>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label={title}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth="1" />
                <text x={L - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill={INK2}>{compact(t)}</text>
              </g>
            ))}
            {data.map((d, i) => {
              const x = L + i * slot + (slot - bw) / 2;
              let acc = 0;
              const segs = series.filter((s) => (d.parts[s.key] || 0) > 0);
              return (
                <g key={d.label} onMouseLeave={() => setTip(null)}>
                  {segs.map((s, k) => {
                    const v = d.parts[s.key];
                    const y1 = y(acc + v), y0 = y(acc);
                    acc += v;
                    const isTop = k === segs.length - 1;
                    const h = Math.max(1, y0 - y1 - (k > 0 ? 2 : 0));
                    const top = y1;
                    return (
                      <path
                        key={s.key}
                        d={isTop
                          ? `M${x},${top + h} V${top + 4} Q${x},${top} ${x + 4},${top} H${x + bw - 4} Q${x + bw},${top} ${x + bw},${top + 4} V${top + h} Z`
                          : `M${x},${top} H${x + bw} V${top + h} H${x} Z`}
                        fill={s.color}
                        onMouseEnter={() => setTip({ x: ((x + bw / 2) / W) * 100, y: (top / H) * 100, text: `${d.label} · ${s.label}: ${v}` })}
                      />
                    );
                  })}
                  <rect x={L + i * slot} y={T} width={slot} height={plotH} fill="transparent" onMouseEnter={() => setTip({ x: ((x + bw / 2) / W) * 100, y: (y(totals[i]) / H) * 100, text: `${d.label}: ${totals[i]} total` })} />
                  {i % labelEvery === 0 && <text x={x + bw / 2} y={H - 14} textAnchor="middle" fontSize="10" fill={INK2}>{d.short || d.label}</text>}
                </g>
              );
            })}
          </svg>
          {tip && (
            <div style={{ position: "absolute", left: `${tip.x}%`, top: `${tip.y}%`, transform: "translate(-50%, -130%)", background: SURFACE, border: `1px solid ${GRID}`, borderRadius: 4, padding: "3px 8px", fontSize: 11, color: INK, pointerEvents: "none", whiteSpace: "nowrap" }}>{tip.text}</div>
          )}
        </div>
      )}
    </ChartFrame>
  );
}

// ---- grouped bars: a few groups, each with one bar per series ------------------------
// groups: [{ label, values: { [seriesKey]: number|null }, notes: { [seriesKey]: "n=…" } }]
export function GroupedBars({ title, subtitle, groups, series, format = (v) => String(v), max: maxProp }) {
  const [tip, setTip] = useState(null);
  const W = 640, H = 220, L = 46, R = 8, T = 18, B = 34;
  const vals = groups.flatMap((g) => series.map((s) => g.values[s.key]).filter((v) => v != null));
  const max = maxProp || niceMax(Math.max(1, ...vals));
  const plotW = W - L - R, plotH = H - T - B;
  const slot = groups.length ? plotW / groups.length : plotW;
  const n = series.length;
  const gap = n > 1 ? 16 : 0; // wide enough for each bar's value label
  const bw = Math.min(24, (slot - 12 - gap * (n - 1)) / n);
  const y = (v) => T + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];
  const table = <DataTable head={["", ...series.map((s) => s.label)]} rows={groups.map((g) => [g.label, ...series.map((s) => (g.values[s.key] == null ? "—" : format(g.values[s.key])))])} />;
  return (
    <ChartFrame title={title} subtitle={subtitle} series={series} table={table}>
      <div style={{ position: "relative" }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label={title}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth="1" />
              <text x={L - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill={INK2}>{format(t)}</text>
            </g>
          ))}
          {groups.map((g, gi) => {
            const groupW = n * bw + (n - 1) * gap;
            const gx = L + gi * slot + (slot - groupW) / 2;
            return (
              <g key={g.label} onMouseLeave={() => setTip(null)}>
                {series.map((s, si) => {
                  const v = g.values[s.key];
                  const x = gx + si * (bw + gap);
                  if (v == null) return <text key={s.key} x={x + bw / 2} y={y(0) - 4} textAnchor="middle" fontSize="10" fill={INK2}>n/a</text>;
                  const top = y(v);
                  const h = Math.max(1, y(0) - top);
                  return (
                    <g key={s.key} onMouseEnter={() => setTip({ x: ((x + bw / 2) / W) * 100, y: (top / H) * 100, text: `${g.label} · ${s.label}: ${format(v)}${g.notes?.[s.key] ? ` (${g.notes[s.key]})` : ""}` })}>
                      <path d={h > 4 ? `M${x},${y(0)} V${top + 4} Q${x},${top} ${x + 4},${top} H${x + bw - 4} Q${x + bw},${top} ${x + bw},${top + 4} V${y(0)} Z` : `M${x},${y(0)} V${top} H${x + bw} V${y(0)} Z`} fill={s.color} />
                      <text x={x + bw / 2} y={top - 4} textAnchor="middle" fontSize="10" fill={INK}>{format(v)}</text>
                    </g>
                  );
                })}
                <text x={L + gi * slot + slot / 2} y={H - 14} textAnchor="middle" fontSize="10" fill={INK2}>{g.label}</text>
              </g>
            );
          })}
        </svg>
        {tip && (
          <div style={{ position: "absolute", left: `${tip.x}%`, top: `${tip.y}%`, transform: "translate(-50%, -150%)", background: SURFACE, border: `1px solid ${GRID}`, borderRadius: 4, padding: "3px 8px", fontSize: 11, color: INK, pointerEvents: "none", whiteSpace: "nowrap" }}>{tip.text}</div>
        )}
      </div>
    </ChartFrame>
  );
}
