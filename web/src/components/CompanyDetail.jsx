import { useEffect, useState } from "react";
import { api } from "../api.js";
import RegionSelect from "./RegionSelect.jsx";
import PaymentHistory from "./PaymentHistory.jsx";
import MergeCompany from "./MergeCompany.jsx";
import { ACCOUNT_SEGMENT_LABELS, ACCOUNT_SEGMENTS, STAGE_LABELS } from "../stages.js";

const BLACKLIST = ["do_not_pursue", "do_not_work_with"];

export default function CompanyDetail({ id, onClose, onChanged, canHotLead = true, can }) {
  // Role matrix — cosmetic; the worker enforces all of these.
  const canSegment = can?.segment ?? true;
  const canBlacklist = can?.blacklist ?? true;
  const isAdmin = can?.admin === true;
  const [blacklistReason, setBlacklistReason] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [hotLeadReason, setHotLeadReason] = useState("");

  function load() {
    api.getCompany(id).then((d) => {
      setData(d);
      setHotLeadReason(d.company.hot_lead_reason || "");
      setBlacklistReason(d.company.blacklist_reason || "");
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
        {can?.admin === true && <MergeCompany company={company} onMerged={() => { onChanged?.(); load(); }} />}

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
            <select
              value={company.account_segment}
              onChange={(e) => patch({ account_segment: e.target.value })}
              disabled={saving || BLACKLIST.includes(company.account_segment) || !canSegment}
              title={!canSegment ? "Only estimators and admins can change an account's segment" : BLACKLIST.includes(company.account_segment) ? "Blacklisted accounts are changed with the Blacklisted checkbox below" : undefined}
            >
              {ACCOUNT_SEGMENTS.filter((s) => !BLACKLIST.includes(s)).map((s) => <option key={s} value={s}>{ACCOUNT_SEGMENT_LABELS[s]}</option>)}
              {BLACKLIST.includes(company.account_segment) && <option value={company.account_segment} disabled>Blacklisted (see below)</option>}
            </select>
          </div>
          <div className="field">
            <label>Region</label>
            <RegionSelect value={company.region} disabled={saving} onChange={(v) => patch({ region: v })} />
          </div>
          <div className="field">
            <label>Vertical</label>
            <input defaultValue={company.vertical || ""} onBlur={(e) => patch({ vertical: e.target.value })} />
          </div>
        </div>

        <div className="card" style={{ background: "var(--bg-page)" }}>
          <div className="card-title">🔥 Priority client</div>
          <div className="field-help" style={{ marginBottom: 8 }}>
            Estimators proceed with this client's estimates whatever the RFQ scores. SCOUT shows the priority flag and lets a No Bid score
            through without an override. If an estimator declines one anyway, it goes to the admin review queue so an admin can follow up with
            the customer personally. A priority flag expires after 37 days unless it's renewed, or made permanent by an admin.
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <input type="checkbox" checked={company.hot_lead} onChange={(e) => patch({ hot_lead: e.target.checked, hot_lead_reason: hotLeadReason })} disabled={saving || !canHotLead} />
            Priority client
          </label>
          {company.hot_lead && (
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }} title={isAdmin ? "" : "Only admins can make a priority client permanent"}>
              <input type="checkbox" checked={Boolean(company.priority_permanent)} onChange={(e) => patch({ priority_permanent: e.target.checked })} disabled={saving || !isAdmin} />
              Permanent (never expires)
            </label>
          )}
          <div className="field">
            <label>Reason</label>
            <input
              value={hotLeadReason}
              onChange={(e) => setHotLeadReason(e.target.value)}
              onBlur={() => canHotLead && hotLeadReason !== (company.hot_lead_reason || "") && patch({ hot_lead_reason: hotLeadReason })}
              disabled={!canHotLead}
              placeholder="Why this client is a priority (relationship, strategic account, referral…)"
            />
          </div>
          {!canHotLead && <div className="field-help" style={{ marginTop: 6 }}>Only estimators and admins can add or change the priority designation.</div>}
          {company.hot_lead_set_by && (
            <div className="field-help" style={{ marginTop: 6 }}>
              Set by {company.hot_lead_set_by} on {new Date(company.hot_lead_set_at).toLocaleString()}
              {company.priority_permanent ? " · permanent" : ""}
              {company.netsuite_sync_status === "synced" ? " · mirrored to NetSuite" : ""}
            </div>
          )}
        </div>

        <div className="card" style={{ background: "var(--bg-page)", marginTop: 12, borderColor: company.blacklisted ? "var(--red)" : undefined }}>
          <div className="card-title">⛔ Blacklisted</div>
          <div className="field-help" style={{ marginBottom: 8 }}>
            A blacklisted client shows a warning in SCOUT and ticks SCOUT's "Blacklisted client" disqualifier for the estimator. Only admins can
            add or remove it.
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <input type="checkbox" checked={Boolean(company.blacklisted)} onChange={(e) => patch({ blacklisted: e.target.checked, blacklist_reason: blacklistReason })} disabled={saving || !isAdmin} />
            Blacklisted
          </label>
          <div className="field">
            <label>Reason</label>
            <input
              value={blacklistReason}
              onChange={(e) => setBlacklistReason(e.target.value)}
              onBlur={() => isAdmin && blacklistReason !== (company.blacklist_reason || "") && patch({ blacklist_reason: blacklistReason })}
              disabled={!isAdmin}
              placeholder="Why (non-payment, scope, conduct…)"
            />
          </div>
          {company.blacklisted_by && (
            <div className="field-help" style={{ marginTop: 6 }}>Blacklisted by {company.blacklisted_by}{company.blacklisted_at ? " on " + new Date(company.blacklisted_at).toLocaleString() : ""}</div>
          )}
        </div>

        <div style={{ marginTop: 12 }}><PaymentHistory payment={data.payment} /></div>

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
