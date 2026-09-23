import { useEffect, useState } from "react";
import { api } from "../api.js";
import { ACCOUNT_SEGMENT_LABELS, ACCOUNT_SEGMENTS, STAGE_LABELS } from "../stages.js";

export default function CompanyDetail({ id, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [hotLeadReason, setHotLeadReason] = useState("");

  function load() {
    api.getCompany(id).then((d) => {
      setData(d);
      setHotLeadReason(d.company.hot_lead_reason || "");
    }).catch((e) => setError(e.message));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (error) return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div style={{ color: "var(--red)" }}>{error}</div>
        <div className="modal-actions"><button className="btn btn-ghost" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
  if (!data) return null;

  const { company, contacts, bids } = data;

  async function patch(fields) {
    setSaving(true);
    try {
      await api.patchCompany(id, fields);
      load();
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 620 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginBottom: 4 }}>{company.name}</h2>
        {company.netsuite_sync_status === "failed" && (
          <div className="notification-banner" style={{ marginBottom: 12 }}>
            NetSuite mirror push failed: {company.netsuite_sync_error}
          </div>
        )}

        <div className="field-row" style={{ marginBottom: 12 }}>
          <div className="field">
            <label>Account Segment</label>
            <select value={company.account_segment} onChange={(e) => patch({ account_segment: e.target.value })} disabled={saving}>
              {ACCOUNT_SEGMENTS.map((s) => <option key={s} value={s}>{ACCOUNT_SEGMENT_LABELS[s]}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Region</label>
            <input defaultValue={company.region || ""} onBlur={(e) => patch({ region: e.target.value })} />
          </div>
          <div className="field">
            <label>Vertical</label>
            <input defaultValue={company.vertical || ""} onBlur={(e) => patch({ vertical: e.target.value })} />
          </div>
        </div>

        <div className="card" style={{ background: "var(--bg-page)" }}>
          <div className="card-title">Hot-lead weighting</div>
          <div className="field-help" style={{ marginBottom: 8 }}>
            Manual override read by SCOUT at scoring time — a flagged account can get a passing
            tier on a borderline score. Recorded here and mirrored to NetSuite during the
            parallel-run period.
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <input type="checkbox" checked={company.hot_lead} onChange={(e) => patch({ hot_lead: e.target.checked, hot_lead_reason: hotLeadReason })} disabled={saving} />
            Hot lead
          </label>
          <div className="field">
            <label>Reason</label>
            <input
              value={hotLeadReason}
              onChange={(e) => setHotLeadReason(e.target.value)}
              onBlur={() => patch({ hot_lead_reason: hotLeadReason })}
              placeholder="Why this account gets weighted (relationship, strategic account, referral…)"
            />
          </div>
          {company.hot_lead_set_by && (
            <div className="field-help" style={{ marginTop: 6 }}>
              Set by {company.hot_lead_set_by} on {new Date(company.hot_lead_set_at).toLocaleString()}
              {company.netsuite_sync_status === "synced" ? " · mirrored to NetSuite" : ""}
            </div>
          )}
        </div>

        <div className="card-title" style={{ marginTop: 16 }}>Contacts ({contacts.length})</div>
        <div className="row-list" style={{ marginBottom: 16 }}>
          {contacts.map((c) => (
            <div className="card" key={c.id} style={{ padding: 10, marginBottom: 0 }}>
              <div style={{ fontWeight: 600 }}>{[c.first_name, c.last_name].filter(Boolean).join(" ") || "(no name)"}</div>
              <div className="row-secondary">{c.title} {c.email ? `· ${c.email}` : ""}</div>
            </div>
          ))}
          {contacts.length === 0 && <div className="empty-state">No contacts yet.</div>}
        </div>

        <div className="card-title">Bid history ({bids.length})</div>
        <div className="row-list" style={{ maxHeight: 160, overflowY: "auto" }}>
          {bids.map((b) => (
            <div key={b.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "6px 0", borderBottom: "1px solid var(--border-color)" }}>
              <span>{b.project_name}</span>
              <span className="row-secondary">{STAGE_LABELS[b.stage]}</span>
            </div>
          ))}
          {bids.length === 0 && <div className="empty-state">No bids yet.</div>}
        </div>

        <div className="modal-actions"><button className="btn btn-ghost" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
