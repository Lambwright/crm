import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";

// Admin: SCOUT history rows whose client name isn't a CRM company yet. Pick the
// real company for each name (likely ones are suggested); the spelling is
// remembered, so later pushes and imports of the same name resolve on their own.
// "Not a client" hides test or junk names from the stats.
function Row({ item, onDone }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function search(text) {
    setQ(text);
    if (text.trim().length < 2) { setResults([]); return; }
    try { setResults(((await api.listCompanies({ q: text.trim() })).companies || []).slice(0, 10)); } catch (e) { setError(e.message); }
  }
  async function link(company) {
    setBusy(true); setError(null);
    try { await api.linkScoutClient(item.client, company.id); onDone(item.client); } catch (e) { setError(e.data?.detail || e.message); setBusy(false); }
  }
  async function exclude() {
    setBusy(true); setError(null);
    try { await api.excludeScoutClient(item.client); onDone(item.client); } catch (e) { setError(e.data?.detail || e.message); setBusy(false); }
  }

  return (
    <tr>
      <td style={{ verticalAlign: "top" }}>
        <div style={{ fontWeight: 600 }}>{item.client}</div>
        <div className="row-secondary">{item.runs} run{item.runs === 1 ? "" : "s"}{item.example ? ` · e.g. ${item.example}` : ""}</div>
      </td>
      <td>
        {item.suggestions.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
            {item.suggestions.map((c) => (
              <button key={c.id} className="btn btn-ghost btn-sm" disabled={busy} onClick={() => link(c)} title="Link to this company">{c.name}</button>
            ))}
          </div>
        )}
        <input placeholder="Search for the company…" value={q} onChange={(e) => search(e.target.value)} style={{ maxWidth: 320 }} />
        {results.length > 0 && (
          <div className="row-list" style={{ marginTop: 4, maxHeight: 140, overflowY: "auto" }}>
            {results.map((c) => (
              <button key={c.id} className="btn btn-ghost btn-sm" style={{ textAlign: "left" }} disabled={busy} onClick={() => link(c)}>{c.name}</button>
            ))}
          </div>
        )}
        {error && <div className="login-error" style={{ marginTop: 4 }}>{error}</div>}
      </td>
      <td style={{ verticalAlign: "top", whiteSpace: "nowrap" }}>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={exclude} title="Test or junk name: leave it out of the stats">Not a client</button>
      </td>
    </tr>
  );
}

export default function ScoutLinkClients({ onChanged }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.getScoutUnlinked().then((d) => setItems(d.clients)).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  function done(client) {
    setItems((list) => list.filter((x) => x.client !== client));
    onChanged?.();
  }

  return (
    <details className="card" style={{ background: "var(--bg-page)", marginTop: 12 }}>
      <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
        Match SCOUT clients to companies (admin){items ? ` (${items.length} to match)` : ""}
      </summary>
      <div style={{ marginTop: 10 }}>
        <p className="field-help" style={{ marginBottom: 10, maxWidth: 720 }}>
          These names appear on SCOUT history but aren't a CRM company. Choose the real company for each; its other runs and later
          imports under the same name follow automatically. The stats count these runs either way.
        </p>
        {error && <div className="login-error">{error}</div>}
        {!items && !error && <div className="spinner-inline">Loading…</div>}
        {items && items.length === 0 && <div className="empty-state">Everything is matched.</div>}
        {items && items.length > 0 && (
          <table className="data-table">
            <thead><tr><th>Name on the SCOUT run</th><th>Company</th><th /></tr></thead>
            <tbody>{items.map((it) => <Row key={it.client} item={it} onDone={done} />)}</tbody>
          </table>
        )}
      </div>
    </details>
  );
}
