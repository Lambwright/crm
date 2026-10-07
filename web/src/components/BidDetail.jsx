import { useEffect, useState } from "react";
import { api, buildMailto } from "../api.js";
import { buildFollowUpDraft, variantCount } from "../followupTemplates.js";
import { HANDOFF_STATUS_LABELS, STAGE_LABELS, STAGE_ORDER, STAGE_REQUIREMENTS } from "../stages.js";

export default function BidDetail({ id, user, onClose, onChanged, prefillEmail, assignableUsers = [], initialToStage, autoHandoffOnComplete, can }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  // Set when a kanban drag-and-drop landed on a stage that needs required
  // fields (STAGE_REQUIREMENTS) — the drop itself can't collect those, so it
  // opens the bid here instead, already pointed at the target stage.
  const [toStage, setToStage] = useState(initialToStage || "");
  const [stageFields, setStageFields] = useState({});
  const [stageError, setStageError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [emailDraft, setEmailDraft] = useState(
    prefillEmail
      ? { direction: "outbound", subject: prefillEmail.subject || "", to_addresses: prefillEmail.to || "", body: prefillEmail.body || "" }
      : { direction: "outbound", subject: "", to_addresses: "", body: "" }
  );
  const [expandedEmailId, setExpandedEmailId] = useState(null);
  // Which wording the follow-up draft is on (the "Different wording" button cycles it).
  const [variant, setVariant] = useState(() => Math.floor(Math.random() * 1000));
  // Role matrix (GET /access). Cosmetic only — the worker enforces both of
  // these regardless. Undefined (legacy mode, or /access not loaded) = allowed.
  const canMove = can?.move_stages ?? true;
  const canAssign = can?.assign ?? true;

  function load() {
    api.getBid(id).then((d) => {
      setData(d);
      // The bid's own contact is the natural recipient: fill it in unless
      // someone already typed one (or the Follow-ups page pre-filled it).
      const email = d.bid.contact_email;
      if (email) setEmailDraft((cur) => (cur.to_addresses ? cur : { ...cur, to_addresses: email }));
    }).catch((e) => setError(e.message));
  }

  // A fresh wording for the follow-up (Ben, 2026-10-07: so they don't sound canned).
  function randomizeDraft() {
    const b = data.bid;
    const next = variant + 1 + Math.floor(Math.random() * Math.max(1, variantCount(b) - 1));
    setVariant(next);
    const draft = buildFollowUpDraft(b, { contactFirstName: b.contact_first_name, contactEmail: "" }, next);
    setEmailDraft((cur) => ({ ...cur, direction: "outbound", subject: draft.subject, body: draft.body }));
  }

  // Add a customer-directory contact to the recipient list.
  function addRecipient(email) {
    if (!email) return;
    setEmailDraft((cur) => {
      const have = (cur.to_addresses || "").split(/[,;]\s*/).filter(Boolean);
      if (have.some((a) => a.toLowerCase() === email.toLowerCase())) return cur;
      return { ...cur, to_addresses: [...have, email].join(", ") };
    });
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
  const directory = (data.company_contacts || []).filter((c) => c.email);
  const requirements = toStage ? STAGE_REQUIREMENTS[toStage] || [] : [];

  async function assignField(field, value) {
    setStageError(null);
    try {
      await api.patchBid(id, { [field]: value || null });
      load();
      onChanged?.();
    } catch (e) {
      setStageError(e.data?.detail || e.message);
    }
  }

  function assignSelect(field, currentValue) {
    if (!canAssign) {
      const who = assignableUsers.find((u) => u.username === currentValue);
      return <span>{currentValue ? who?.displayName || currentValue : "— unassigned —"}</span>;
    }
    if (!assignableUsers.length) {
      return (
        <input
          defaultValue={currentValue || ""}
          onBlur={(e) => e.target.value !== (currentValue || "") && assignField(field, e.target.value)}
          style={{ fontSize: 12, padding: "2px 6px" }}
        />
      );
    }
    const options = assignableUsers.some((u) => u.username === currentValue) || !currentValue
      ? assignableUsers
      : [{ username: currentValue, displayName: currentValue }, ...assignableUsers];
    return (
      <select value={currentValue || ""} onChange={(e) => assignField(field, e.target.value)} style={{ fontSize: 12, padding: "2px 4px" }}>
        <option value="">— unassigned —</option>
        {options.map((u) => (
          <option key={u.username} value={u.username}>{u.displayName || u.username}</option>
        ))}
      </select>
    );
  }

  async function handleMoveStage() {
    if (!toStage) return;
    setBusy(true);
    setStageError(null);
    try {
      await api.moveBidStage(id, toStage, stageFields);
      // "Start Handoff" on a Pipeline card (Ben, 2026-10-01): one action —
      // move to Awarded, then straight into HANDOFF's purgatory — not
      // "move it, then notice a link appeared, then click that too."
      if (autoHandoffOnComplete && toStage === "complete" && bid.procore_bid_board_id) {
        window.open(`https://lambwright.github.io/handoff/#/bids?open=${encodeURIComponent(bid.procore_bid_board_id)}`, "_blank");
      }
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

  // One action, not two: opening the mail app now logs the email at the same
  // time, rather than requiring a separate "Log this email" click afterward.
  // Real tradeoff, not a hidden one: a mailto: link can't tell us whether the
  // user actually hit send in their mail client, so this can produce a
  // false-positive record if they cancel or change their mind after
  // composing. Ben's call, given a two-step flow was judged unlikely to get
  // followed through consistently — see the 2026-09 conversation.
  async function handleComposeAndLog() {
    if (!emailDraft.to_addresses && !emailDraft.subject && !emailDraft.body) return;
    setBusy(true);
    try {
      await api.logEmail(id, { ...emailDraft, from_address: emailDraft.direction === "outbound" ? user.username : undefined, sent_at: new Date().toISOString() });
      // Refresh before handing off to the mail client — setting
      // window.location to a mailto: URI is usually intercepted without a
      // real navigation, but doing it first risks this fetch getting cut
      // short in browsers that treat it as one anyway.
      load();
      const mailto = buildMailto({ to: emailDraft.to_addresses, subject: emailDraft.subject, body: emailDraft.body });
      window.location.href = mailto;
      setEmailDraft({ direction: "outbound", subject: "", to_addresses: "", body: "" });
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
        <div className="row-secondary" style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 10 }}>
          {bid.company_name || "—"}
          {bid.procore_bid_board_id && (
            <a
              href={`https://us02.procore.com/webclients/host/companies/562949953508586/tools/bid-board/project/${bid.procore_bid_board_id}/details`}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)", fontSize: 11 }}
            >
              ↗ View in Procore
            </a>
          )}
        </div>

        <div className="kv-grid" style={{ marginBottom: 16 }}>
          <div className="kv"><span className="kv-label">Stage</span><span className="kv-value">{STAGE_LABELS[bid.stage]}</span></div>
          <div className="kv"><span className="kv-label">SCOUT Tier</span><span className="kv-value">{bid.scout_tier || "—"}{bid.hot_lead_applied ? " (hot-lead bump)" : ""}</span></div>
          <div className="kv"><span className="kv-label">Owner</span><span className="kv-value">{assignSelect("owner_username", bid.owner_username)}</span></div>
          <div className="kv"><span className="kv-label">Estimator</span><span className="kv-value">{assignSelect("estimator_username", bid.estimator_username)}</span></div>
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
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <select
                value={bid.handoff_status || "pending"}
                disabled={!(can?.handoff_status ?? true)}
                onChange={async (e) => { await api.patchBid(id, { handoff_status: e.target.value }); load(); onChanged?.(); }}
              >
                {Object.entries(HANDOFF_STATUS_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
              {bid.procore_bid_board_id ? (
                <a
                  className="btn btn-accent btn-sm"
                  href={`https://lambwright.github.io/handoff/#/bids?open=${encodeURIComponent(bid.procore_bid_board_id)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Start Handoff →
                </a>
              ) : (
                <span className="field-help">No Procore Bid Board ID on this bid — can't deep-link into HANDOFF.</span>
              )}
            </div>
          </div>
        )}

        {canMove ? (
        <>
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
        </>
        ) : (
          <div className="field-help" style={{ marginBottom: 12 }}>Only estimators and admins can move a bid between stages.</div>
        )}
        {stageError && <div className="login-error" style={{ marginBottom: 8 }}>{stageError}</div>}
        {canMove && toStage && (
          <button className="btn btn-accent btn-sm" onClick={handleMoveStage} disabled={busy} style={{ marginBottom: 16 }}>
            Move to {STAGE_LABELS[toStage]}
          </button>
        )}

        <div className="card-title">Tender emails ({emails.length})</div>
        <div className="row-list" style={{ marginBottom: 10, maxHeight: 260, overflowY: "auto", border: emails.length > 3 ? "1px solid var(--border-color)" : "none", borderRadius: "var(--radius-sm)", padding: emails.length > 3 ? 4 : 0 }}>
          {emails.map((e) => {
            const expanded = expandedEmailId === e.id;
            return (
              <div
                className="card"
                key={e.id}
                style={{ padding: 10, marginBottom: 0, cursor: "pointer" }}
                onClick={() => setExpandedEmailId(expanded ? null : e.id)}
              >
                <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                  {e.direction === "outbound" ? "→ sent" : "← received"} · {new Date(e.sent_at).toLocaleString()}
                  {e.logged_by ? ` · by ${e.logged_by}` : ""}
                  <span style={{ float: "right" }}>{expanded ? "▲ collapse" : "▼ view"}</span>
                </div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{e.subject || "(no subject)"}</div>
                {expanded && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border-color)" }} onClick={(ev) => ev.stopPropagation()}>
                    {e.to_addresses && <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>To: {e.to_addresses}</div>}
                    {e.from_address && <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>From: {e.from_address}</div>}
                    {e.cc_addresses && <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>Cc: {e.cc_addresses}</div>}
                    <div style={{ fontSize: 13, whiteSpace: "pre-wrap", marginTop: 6 }}>{e.body || "(no body logged)"}</div>
                  </div>
                )}
              </div>
            );
          })}
          {emails.length === 0 && <div className="empty-state">No tender emails logged yet.</div>}
        </div>
        {emails.length > 3 && <div className="field-help" style={{ marginTop: -6, marginBottom: 10 }}>Scroll above to see all {emails.length}.</div>}
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
            {directory.length > 0 && (
              <select value="" onChange={(e) => addRecipient(e.target.value)} style={{ marginTop: 4, fontSize: 12 }}>
                <option value="">+ Add from {bid.company_name || "client"} directory…</option>
                {directory.map((c) => (
                  <option key={c.id} value={c.email}>
                    {[c.first_name, c.last_name].filter(Boolean).join(" ") || c.email}{c.title ? ` — ${c.title}` : ""} ({c.email})
                  </option>
                ))}
              </select>
            )}
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
          <button className="btn btn-accent btn-sm" onClick={handleComposeAndLog} disabled={busy}>✉ Open in mail app &amp; log</button>
          <button className="btn btn-ghost btn-sm" onClick={randomizeDraft} disabled={busy} title="Replace the subject and body with a differently-worded follow-up">🎲 Different wording</button>
        </div>
        <div className="field-help" style={{ marginTop: -10, marginBottom: 16 }}>
          Logs immediately, before you actually send — can't verify send from here (a mailto: link has no way to know).
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
