import { useState } from "react";
import { api } from "../api.js";

// Admin only: fold a duplicate company into the one being viewed. The duplicate's
// bids, contacts, emails and notes move here, blank fields are filled from it,
// and the duplicate is removed. A Do Not Pursue / Do Not Work With designation
// on either one is kept.
export default function MergeCompany({ company, onMerged }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [picked, setPicked] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function search(text) {
    setQ(text);
    setPicked(null);
    setPreview(null);
    if (text.trim().length < 2) { setResults([]); return; }
    try {
      const d = await api.listCompanies({ q: text.trim() });
      setResults((d.companies || []).filter((c) => c.id !== company.id).slice(0, 12));
    } catch (e) {
      setError(e.message);
    }
  }

  async function pick(c) {
    setPicked(c);
    setError(null);
    try {
      setPreview(await api.previewCompanyMerge(company.id, c.id));
    } catch (e) {
      setPreview(null);
      setError(e.data?.detail || e.message);
    }
  }

  async function doMerge() {
    setBusy(true);
    setError(null);
    try {
      await api.mergeCompanies(company.id, picked.id);
      onMerged?.();
    } catch (e) {
      setError(e.data?.detail || e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="card" style={{ background: "var(--bg-page)", marginTop: 12 }}>
      <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Merge a duplicate into this company</summary>
      <div style={{ marginTop: 10 }}>
        <div className="field-help" style={{ marginBottom: 8 }}>
          Keeps <strong>{company.name}</strong>. Search for the duplicate; its bids, contacts and emails move here and it is then removed.
        </div>
        <input placeholder="Search for the duplicate by name…" value={q} onChange={(e) => search(e.target.value)} />
        {!picked && results.length > 0 && (
          <div className="row-list" style={{ marginTop: 6, maxHeight: 160, overflowY: "auto" }}>
            {results.map((c) => (
              <button key={c.id} className="btn btn-ghost btn-sm" style={{ justifyContent: "space-between", textAlign: "left" }} onClick={() => pick(c)}>
                <span>{c.name}</span>
                <span className="row-secondary">{c.bid_count} bids</span>
              </button>
            ))}
          </div>
        )}
        {picked && preview && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 13, marginBottom: 8 }}>
              Merge <strong>{preview.merge.name}</strong> into <strong>{preview.keep.name}</strong>: moves {preview.moves.bids} bid{preview.moves.bids === 1 ? "" : "s"},
              {" "}{preview.moves.contacts} contact{preview.moves.contacts === 1 ? "" : "s"} and {preview.moves.emails} email{preview.moves.emails === 1 ? "" : "s"}.
              This can't be undone from here (a record of it is kept).
            </div>
            <button className="btn btn-accent btn-sm" disabled={busy} onClick={doMerge}>{busy ? "Merging…" : "Merge and remove the duplicate"}</button>{" "}
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setPicked(null); setPreview(null); }}>Cancel</button>
          </div>
        )}
        {error && <div className="login-error" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    </details>
  );
}
