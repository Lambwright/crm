import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { ACCOUNT_SEGMENT_LABELS, ACCOUNT_SEGMENTS } from "../stages.js";
import CompanyDetail from "./CompanyDetail.jsx";

export default function CompanyList() {
  const [companies, setCompanies] = useState([]);
  const [q, setQ] = useState("");
  const [segment, setSegment] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const params = {};
    if (q) params.q = q;
    if (segment) params.segment = segment;
    api.listCompanies(params).then((data) => setCompanies(data.companies || [])).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [q, segment]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate() {
    if (!newName.trim()) return;
    await api.createCompany({ name: newName.trim() });
    setNewName("");
    setShowCreate(false);
    load();
  }

  return (
    <>
      <div className="field-row" style={{ marginBottom: 12 }}>
        <div className="field" style={{ flex: 2 }}>
          <input placeholder="Search companies…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="field">
          <select value={segment} onChange={(e) => setSegment(e.target.value)}>
            <option value="">All segments</option>
            {ACCOUNT_SEGMENTS.map((s) => <option key={s} value={s}>{ACCOUNT_SEGMENT_LABELS[s]}</option>)}
          </select>
        </div>
        <button className="btn btn-accent btn-sm" onClick={() => setShowCreate(true)}>+ New Company</button>
      </div>
      {error && <div className="card" style={{ color: "var(--red)" }}>{error}</div>}
      <div className="row-list">
        {companies.map((c) => (
          <div className="row-item" key={c.id} onClick={() => setSelectedId(c.id)}>
            <div className="row-primary">
              {c.hot_lead && <span className="hot-lead-flame">🔥</span>}
              {c.name}
            </div>
            <div className="row-secondary">{c.region || "—"}</div>
            <div className="row-secondary">{c.vertical || "—"}</div>
            <div><span className="badge badge-segment">{ACCOUNT_SEGMENT_LABELS[c.account_segment]}</span></div>
            <div className="row-secondary" style={{ textAlign: "right" }}>{c.tier || ""}</div>
          </div>
        ))}
        {!loading && companies.length === 0 && <div className="empty-state">No companies match.</div>}
      </div>

      {selectedId && (
        <CompanyDetail id={selectedId} onClose={() => setSelectedId(null)} onChanged={load} />
      )}

      {showCreate && (
        <div className="modal-backdrop" onClick={() => setShowCreate(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="card-title">New Company</div>
            <div className="field" style={{ marginBottom: 12 }}>
              <label>Name</label>
              <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} />
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setShowCreate(false)}>Cancel</button>
              <button className="btn btn-accent" onClick={handleCreate}>Create</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
