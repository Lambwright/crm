import { useState } from "react";
import { api } from "../api.js";

// The line under a contact picker that says where the client's contacts came from, with a Refresh button
// and, for a company that isn't tied to a Procore Directory company yet, a "Find in Procore" search so a
// person can link it. `status` is the answer from the refresh-contacts endpoints.
export default function ProcoreContacts({ companyId, status, refreshing, onRefresh, canLink, onLinked }) {
  const [finding, setFinding] = useState(false);
  const [candidates, setCandidates] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const s = status || {};

  async function find() {
    setFinding(true); setError(null);
    try {
      const r = await api.procoreCandidates(companyId);
      setCandidates(r.candidates || []);
      if (r.error) setError(r.error);
    } catch (e) { setError(e.data?.detail || e.message); } finally { setFinding(false); }
  }
  async function link(vendorId) {
    setBusy(true); setError(null);
    try {
      const r = await api.procoreLink(companyId, vendorId);
      setCandidates(null);
      onLinked?.(r);
    } catch (e) { setError(e.data?.detail || e.data?.error || e.message); } finally { setBusy(false); }
  }

  let line = "";
  if (refreshing && !status) line = "Checking Procore for this client's contacts…";
  else if (s.reason === "not_linked") line = "This client isn't linked to a Procore company yet, so its Procore contacts can't load.";
  else if (s.reason === "error") line = `Couldn't refresh from Procore (${s.error || "unknown error"}). Showing the contacts CRM already has.`;
  else if (s.reason === "no_contacts") line = "Procore has no contacts on file for this company.";
  else if (s.synced_at) line = `Contacts from Procore's Directory (company ${s.procore_vendor_id}), updated ${new Date(s.synced_at).toLocaleString()}.`;

  return (
    <div className="field-help" style={{ marginTop: 4 }}>
      {line}
      {s.linked && (
        <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} disabled={refreshing} onClick={() => onRefresh(true)}>{refreshing ? "…" : "↻ Refresh from Procore"}</button>
      )}
      {s.reason === "not_linked" && canLink && (
        <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} disabled={finding} onClick={find}>{finding ? "Searching…" : "Find in Procore"}</button>
      )}
      {error && <div className="login-error" style={{ marginTop: 4 }}>{error}</div>}
      {candidates && (
        <div className="card" style={{ marginTop: 6, padding: 10 }}>
          {candidates.length === 0 && <div>No close matches in Procore's Directory.</div>}
          {candidates.map((c) => (
            <div key={c.directory_id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "3px 0" }}>
              <span>{c.name} <span className="row-secondary">· Procore #{c.directory_id}{c.linked_to ? ` · already linked to ${c.linked_to}` : ""}</span></span>
              <button className="btn btn-accent btn-sm" disabled={busy || Boolean(c.linked_to)} onClick={() => link(c.directory_id)}>Link</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
