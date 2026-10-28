import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import Loading from "./Loading.jsx";

// Admin: SCOUT history runs whose client name isn't a CRM company yet. A customer can
// have several branches, each its own company, and a bid is for one specific branch,
// so each run can be matched on its own ("Match run by run"). "Link all runs" is the
// shortcut when the name is unambiguous: it also remembers the spelling as an alias,
// so later pushes and imports of that name resolve by themselves. "Not a client" hides
// test or junk names from the stats.
const where = (c) => [c.city, c.province].filter(Boolean).join(", ");

function Picker({ suggestions, busy, onPick }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [error, setError] = useState(null);
  async function search(text) {
    setQ(text);
    if (text.trim().length < 2) { setResults([]); return; }
    try { setResults(((await api.listCompanies({ q: text.trim() })).companies || []).slice(0, 12)); } catch (e) { setError(e.message); }
  }
  const label = (c) => (where(c) ? `${c.name} · ${where(c)}` : c.name);
  return (
    <div>
      {suggestions.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
          {suggestions.map((c) => (
            <button key={c.id} className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onPick(c)} title="Pick this company">{label(c)}</button>
          ))}
        </div>
      )}
      <input placeholder="Search for the company…" value={q} onChange={(e) => search(e.target.value)} style={{ maxWidth: 320 }} />
      {results.length > 0 && (
        <div className="row-list" style={{ marginTop: 4, maxHeight: 160, overflowY: "auto" }}>
          {results.map((c) => (
            <button key={c.id} className="btn btn-ghost btn-sm" style={{ textAlign: "left" }} disabled={busy} onClick={() => onPick(c)}>{label(c)}</button>
          ))}
        </div>
      )}
      {error && <div className="login-error" style={{ marginTop: 4 }}>{error}</div>}
    </div>
  );
}

function RunRow({ run, onLinked }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function pick(c) {
    setBusy(true); setError(null);
    try { await api.linkScoutRuns([run.id], c.id); onLinked([run.id]); } catch (e) { setError(e.data?.detail || e.message); setBusy(false); }
  }
  async function exclude() {
    setBusy(true); setError(null);
    try { await api.excludeScoutRuns([run.id]); onLinked([run.id]); } catch (e) { setError(e.data?.detail || e.message); setBusy(false); }
  }
  return (
    <div style={{ padding: "8px 0", borderTop: "1px solid var(--border-color)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
        <div style={{ fontSize: 12 }}>
          {run.project_name || "(no project name)"}
          <span className="row-secondary"> · {run.submitted_at ? new Date(run.submitted_at).toLocaleDateString() : ""}{run.tier ? ` · ${run.tier}` : ""}</span>
        </div>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={exclude}>Not a client</button>
      </div>
      <Picker suggestions={run.suggestions} busy={busy} onPick={pick} />
      {error && <div className="login-error" style={{ marginTop: 4 }}>{error}</div>}
    </div>
  );
}

function ClientRow({ item, onRunsLinked, onClientDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function linkAll(c) {
    setBusy(true); setError(null);
    try { await api.linkScoutClient(item.client, c.id); onClientDone(item.client); } catch (e) { setError(e.data?.detail || e.message); setBusy(false); }
  }
  async function exclude() {
    setBusy(true); setError(null);
    try { await api.excludeScoutClient(item.client); onClientDone(item.client); } catch (e) { setError(e.data?.detail || e.message); setBusy(false); }
  }
  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <div>
          <div style={{ fontWeight: 600 }}>{item.client}</div>
          <div className="row-secondary">{item.runs} run{item.runs === 1 ? "" : "s"}{item.runs > 1 ? ". Several branches? Match run by run below." : ""}</div>
        </div>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={exclude} title="Test or junk name: leave all its runs out of the stats">Not a client</button>
      </div>
      <div className="kv-label" style={{ marginBottom: 4 }}>{item.runs > 1 ? "Link all runs to one company" : "Link to"}</div>
      <Picker suggestions={item.suggestions} busy={busy} onPick={linkAll} />
      {error && <div className="login-error" style={{ marginTop: 4 }}>{error}</div>}
      {item.items.length > 0 && (
        <details style={{ marginTop: 10 }} open={item.runs <= 3}>
          <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Match run by run ({item.items.length}{item.runs > item.items.length ? ` of ${item.runs}` : ""})</summary>
          <div style={{ marginTop: 4 }}>
            {item.items.map((r) => <RunRow key={r.id} run={r} onLinked={(ids) => onRunsLinked(item.client, ids)} />)}
          </div>
        </details>
      )}
    </div>
  );
}

export default function ScoutLinkClients({ onChanged }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.getScoutUnlinked().then((d) => setItems(d.clients)).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  // Matched runs just leave the list in place; nothing reloads or closes.
  function runsLinked(client, ids) {
    setItems((list) => list
      .map((c) => (c.client !== client ? c : { ...c, runs: c.runs - ids.length, items: c.items.filter((r) => !ids.includes(r.id)) }))
      .filter((c) => c.runs > 0));
    onChanged?.();
  }
  function clientDone(client) {
    setItems((list) => list.filter((x) => x.client !== client));
    onChanged?.();
  }

  return (
    <details className="card" style={{ background: "var(--bg-page)", marginTop: 12 }}>
      <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
        Match SCOUT clients to companies (admin){items ? ` (${items.length} names to match)` : ""}
      </summary>
      <div style={{ marginTop: 10 }}>
        <p className="field-help" style={{ marginBottom: 10, maxWidth: 720 }}>
          These names appear on SCOUT history but aren't a CRM company. A customer with several branches has a company per branch,
          and a bid belongs to one of them, so match each run to the right branch (city and province are shown to help; the province
          prefix on the project name is used to rank the suggestions). "Link all runs" is for a name that is only ever one company.
          The stats count these runs either way.
        </p>
        {error && <div className="login-error">{error}</div>}
        {!items && !error && <Loading />}
        {items && items.length === 0 && <div className="empty-state">Everything is matched.</div>}
        {items && items.map((it) => <ClientRow key={it.client} item={it} onRunsLinked={runsLinked} onClientDone={clientDone} />)}
      </div>
    </details>
  );
}
