import { useEffect, useState } from "react";
import { api, buildMailto } from "../api.js";
import { HANDOFF_STATUS_LABELS, STAGE_LABELS, STAGE_ORDER, STAGE_REQUIREMENTS } from "../stages.js";

export default function BidDetail({ id, user, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [toStage, setToStage] = useState("");
  const [stageFields, setStageFields] = useState({});
  const [stageError, setStageError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [emailDraft, setEmailDraft] = useState({ direction: "outbound", subject: "", to_addresses: "", body: "" });

  function load() {
    api.getBid(id).then(setData).catch((e) => setError(e.message));
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

  const { bid, stage_history, emails } = data;
  const requirements = toStage ? STAGE_REQUIREMENTS[toStage] || [] : [];

  async function handleMoveStage() {
    if (!toStage) return;
    setBusy(true);
    setStageError(null);
    try {
      await api.moveBidStage(id, toStage, stageFields);
      setToStage("");
      setStageFields({});
      load();
      onChanged?.();
    } catch (e) {
      if (e.data?.missing) setStageError(`Missing: ${e.data.missing.join(", ")}`);
      else setStageError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function handleCompose() {
    const mailto = buildMailto({ to: emailDraft.to_addresses, subject: emailDraft.subject, body: emailDraft.body });
    window.location.href = mailto;
  }

  async function handleLogEmail() {
    if (!emailDraft.subject && !emailDraft.body) return;
    setBusy(true);
    try {
      await api.logEmail(id, { ...emailDraft, from_address: emailDraft.direction === "outbound" ? user.username : undefined, sent_at: new Date().toISOString() });
      setEmailDraft({ direction: "outbound", subject: "", to_addresses: "", body: "" });
      load();
    } catch (e) {
      setStageError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="card-title">{bid.rfq_ref}</div>
        <h2 style={{ marginBottom: 4 }}>{bid.project_name}</h2>
        <div className="row-secondary" style={{ marginBottom: 16 }}>{bid.company_name || "—"}</div>

        <div className="kv-grid" style={{ marginBottom: 16 }}>
          <div className="kv"><span className="kv-label">Stage</span><span className="kv-value">{STAGE_LABELS[bid.stage]}</span></div>
          <div className="kv"><span className="kv-label">SCOUT Tier</span><span className="kv-value">{bid.scout_tier || "—"}{bid.hot_lead_applied ? " (hot-lead bump)" : ""}</span></div>
          <div className="kv"><span className="kv-label">Owner</span><span className="kv-value">{bid.owner_username || "—"}</span></div>
          <div className="kv"><span className="kv-label">Estimator</span><span className="kv-value">{bid.estimator_username || "—"}</span></div>
          <div className="kv"><span className="kv-label">Bid Due</span><span className="kv-value">{bid.bid_due_date || "—"}</span></div>
          <div className="kv"><span className="kv-label">Next Action</span><span className="kv-value">{bid.next_action ? `${bid.next_action} (${bid.next_action_date || "no date"})` : "—"}</span></div>
        </div>

        {bid.stage === "complete" && (
          <div className="card" style={{ background: "var(--bg-page)", marginBottom: 16 }}>
            <div className="card-title">Handoff status</div>
            <div className="field-help" style={{ marginBottom: 8 }}>
              Not a pipeline stage — Procore's own Bid Board has no "handoff pending" concept, so
              this tracks it separately on Awarded bids instead.
            </div>
            <select
              value={bid.handoff_status || "pending"}
              onChange={async (e) => { await api.patchBid(id, { handoff_status: e.target.value }); load(); onChanged?.(); }}
            >
              {Object.entries(HANDOFF_STATUS_LABELS).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          </div>
        )}

        <div className="card-title">Move stage</div>
        <div className="field-row" style={{ marginBottom: 8 }}>
          <div className="field">
            <label>To stage</label>
            <select value={toStage} onChange={(e) => { setToStage(e.target.value); setStageFields({}); setStageError(null); }}>
              <option value="">— select —</option>
              {STAGE_ORDER.filter((s) => s !== bid.stage).map((s) => (
                <option key={s} value={s}>{STAGE_LABELS[s]}</option>
              ))}
            </select>
          </div>
        </div>
        {requirements.length > 0 && (
          <div className="field-row" style={{ marginBottom: 8 }}>
            {requirements.map(([field, label, type]) => (
              <div className="field" key={field}>
                <label>{label}</label>
                <input
                  type={type === "number" ? "number" : type === "date" ? "date" : "text"}
                  value={stageFields[field] ?? bid[field] ?? ""}
                  onChange={(e) => setStageFields((f) => ({ ...f, [field]: e.target.value }))}
                />
              </div>
            ))}
          </div>
        )}
        {stageError && <div className="login-error" style={{ marginBottom: 8 }}>{stageError}</div>}
        {toStage && (
          <button className="btn btn-accent btn-sm" onClick={handleMoveStage} disabled={busy} style={{ marginBottom: 16 }}>
            Move to {STAGE_LABELS[toStage]}
          </button>
        )}

        <div className="card-title">Tender emails ({emails.length})</div>
        <div className="row-list" style={{ marginBottom: 10, maxHeight: 140, overflowY: "auto" }}>
          {emails.map((e) => (
            <div className="card" key={e.id} style={{ padding: 10, marginBottom: 0 }}>
              <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{e.direction === "outbound" ? "→ sent" : "← received"} · {new Date(e.sent_at).toLocaleString()}</div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{e.subject || "(no subject)"}</div>
            </div>
          ))}
          {emails.length === 0 && <div className="empty-state">No tender emails logged yet.</div>}
        </div>
        <div className="field-row" style={{ marginBottom: 6 }}>
          <div className="field">
            <label>Direction</label>
            <select value={emailDraft.direction} onChange={(e) => setEmailDraft((d) => ({ ...d, direction: e.target.value }))}>
              <option value="outbound">Sent</option>
              <option value="inbound">Received</option>
            </select>
          </div>
          <div className="field" style={{ flex: 2 }}>
            <label>To / From</label>
            <input value={emailDraft.to_addresses} onChange={(e) => setEmailDraft((d) => ({ ...d, to_addresses: e.target.value }))} placeholder="client@example.com" />
          </div>
        </div>
        <div className="field" style={{ marginBottom: 6 }}>
          <label>Subject</label>
          <input value={emailDraft.subject} onChange={(e) => setEmailDraft((d) => ({ ...d, subject: e.target.value }))} placeholder={`RE: ${bid.project_name}`} />
        </div>
        <div className="field" style={{ marginBottom: 10 }}>
          <label>Body</label>
          <textarea rows={3} value={emailDraft.body} onChange={(e) => setEmailDraft((d) => ({ ...d, body: e.target.value }))} />
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <button className="btn btn-ghost btn-sm" onClick={handleCompose}>✉ Open in mail app</button>
          <button className="btn btn-accent btn-sm" onClick={handleLogEmail} disabled={busy}>Log this email</button>
        </div>

        <div className="card-title">Stage history</div>
        <div className="row-list" style={{ maxHeight: 120, overflowY: "auto", marginBottom: 16 }}>
          {stage_history.map((h) => (
            <div key={h.id} style={{ fontSize: 11, color: "var(--text-secondary)" }}>
              {new Date(h.changed_at).toLocaleString()} — {h.from_stage ? STAGE_LABELS[h.from_stage] : "created"} → {STAGE_LABELS[h.to_stage]} ({h.changed_by})
            </div>
          ))}
        </div>

        <div className="modal-actions"><button className="btn btn-ghost" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
