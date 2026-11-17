import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import Loading from "./Loading.jsx";

// Admin only: client records that look like the same company (Ben, 2026-11-18). "Certain" groups share a
// Procore or NetSuite number; "likely" groups only share a name once Inc / Ltd / ULC are ignored. Merging
// keeps the record you pick and folds the others into it (their bids, contacts and emails move across, the
// old names stay as alternates). Nothing happens until a button is clicked, and every merge asks first.
const WHY = { same_procore_id: "same Procore number", same_netsuite_id: "same NetSuite number", same_name: "same name apart from Inc / Ltd / ULC" };

export default function DuplicateFinder() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [keep, setKeep] = useState({});
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = useCallback(() => api.getDuplicates().then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  if (error) return <div className="card" style={{ color: "var(--red)" }}>{error}</div>;
  if (!data) return <Loading />;

  const keepOf = (g) => keep[g.key] || g.suggested_keep;
  const certain = data.groups.filter((g) => g.tier === "certain");

  async function mergeGroup(g, ask = true) {
    const k = keepOf(g);
    const keeper = g.members.find((m) => m.id === k);
    const others = g.members.filter((m) => m.id !== k);
    if (ask && !window.confirm(`Keep "${keeper.name}" and merge ${others.map((o) => `"${o.name}" (${o.bids} bids)`).join(", ")} into it?\n\nThe other record${others.length > 1 ? "s are" : " is"} removed and this can't be undone from here.`)) return false;
    for (const o of others) await api.mergeCompanies(k, o.id);
    return true;
  }

  async function runMerge(g) {
    setBusy(g.key); setMsg(null);
    try { if (await mergeGroup(g)) await load(); } catch (e) { setMsg(e.data?.detail || e.message); } finally { setBusy(null); }
  }
  async function runAllCertain() {
    if (!window.confirm(`Merge all ${certain.length} certain groups, keeping the suggested record in each?\n\nEach group shares a Procore or NetSuite number. This can't be undone from here.`)) return;
    setBusy("all"); setMsg(null);
    let done = 0;
    try { for (const g of certain) { await mergeGroup(g, false); done++; } } catch (e) { setMsg(`Stopped after ${done} of ${certain.length}: ${e.data?.detail || e.message}`); }
    setBusy(null);
    await load();
  }
  async function dismiss(g) {
    setBusy(g.key); setMsg(null);
    try { await api.dismissDuplicates(g.members.map((m) => m.id)); await load(); } catch (e) { setMsg(e.message); } finally { setBusy(null); }
  }

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <div className="card-title">Possible duplicate clients ({data.groups.length})</div>
        {certain.length > 0 && <button className="btn btn-accent btn-sm" disabled={!!busy} onClick={runAllCertain}>{busy === "all" ? "Merging…" : `Merge all ${certain.length} certain groups`}</button>}
      </div>
      <p className="field-help" style={{ marginBottom: 8, maxWidth: 760 }}>
        Checked across {data.total_companies} client records. <strong>Certain</strong> groups share a Procore or NetSuite number. <strong>Likely</strong> groups only look alike by name, so check each one.
        Pick which record to keep (the suggestion prefers the one with a Procore number). Groups marked <em>conflict</em> carry different numbers and are probably two real companies.
      </p>
      {msg && <div className="login-error" style={{ marginBottom: 8 }}>{msg}</div>}
      {data.groups.length === 0 && <div className="empty-state">No duplicates found.</div>}
      {data.groups.map((g) => (
        <div className="card" key={g.key} style={{ padding: 12 }}>
          <div className="field-help" style={{ marginBottom: 6 }}>
            <strong style={{ color: g.tier === "certain" ? "var(--green)" : "var(--yellow)" }}>{g.tier === "certain" ? "Certain" : "Likely"}</strong>
            {" · "}{g.reasons.map((r) => WHY[r] || r).join(", ")}
            {g.conflict && <strong style={{ color: "var(--red)" }}> · conflict: different Procore/NetSuite numbers</strong>}
          </div>
          <table className="data-table">
            <thead><tr><th>Keep</th><th>Name</th><th className="num">Bids</th><th className="num">Contacts</th><th>Procore #</th><th>NetSuite #</th></tr></thead>
            <tbody>
              {g.members.map((m) => (
                <tr key={m.id}>
                  <td><input type="radio" name={g.key} checked={keepOf(g) === m.id} onChange={() => setKeep((k) => ({ ...k, [g.key]: m.id }))} /></td>
                  <td>{m.name}</td><td className="num">{m.bids}</td><td className="num">{m.contacts}</td>
                  <td>{m.procore_vendor_id || <span className="row-secondary">none</span>}</td>
                  <td>{m.netsuite_customer_id || <span className="row-secondary">none</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <button className="btn btn-accent btn-sm" disabled={!!busy || g.conflict} onClick={() => runMerge(g)}>{busy === g.key ? "Working…" : `Merge into the kept record`}</button>
            <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => dismiss(g)}>Not duplicates</button>
          </div>
        </div>
      ))}
    </div>
  );
}
