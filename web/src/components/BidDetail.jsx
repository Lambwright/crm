import { useEffect, useState } from "react";
import { api, buildMailto } from "../api.js";
import Loading from "./Loading.jsx";
import ScoutRecord from "./ScoutRecord.jsx";
import { buildFollowUpDraft, variantCount } from "../followupTemplates.js";
import { HANDOFF_STATUS_LABELS, STAGE_LABELS, STAGE_ORDER, STAGE_REQUIREMENTS } from "../stages.js";

const CONTACT_LABEL = { call: "Phone call", meeting: "In person", text: "Text / chat", other: "Other contact" };
const CONTACT_ICON = { call: "📞", meeting: "🤝", text: "💬", other: "•" };

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
  // "Other contact" (call, in person, text...) stays folded away until asked for, to keep the screen clean.
  const [otherOpen, setOtherOpen] = useState(false);
  const [other, setOther] = useState({ contact_type: "call", direction: "outbound", spoke_with: "", body: "", next_date: "" });
  // "Is this client answering you?" after the 4th unanswered contact
  const [chasePrompt, setChasePrompt] = useState(null);
  // The client's contacts from Procore's Directory, asked for when the form opens (never blocks it)
  const [procoreContacts, setProcoreContacts] = useState(null); // { linked, refreshed, synced_at, error, contacts }
  const [refreshingContacts, setRefreshingContacts] = useState(false);
  const [chaseHelp, setChaseHelp] = useState({ to: "", note: "" });
  // Moving the follow-up date because the client asked.
  const [dateOpen, setDateOpen] = useState(false);
  const [dateDraft, setDateDraft] = useState({ date: "", reason: "" });
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

  async function loadProcoreContacts(force) {
    setRefreshingContacts(true);
    try { setProcoreContacts(await api.refreshContacts(id, force)); } catch (e) { setProcoreContacts({ error: e.message, contacts: null }); } finally { setRefreshingContacts(false); }
  }

  useEffect(() => {
    loadProcoreContacts(false);
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
  if (!data) return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}><Loading /></div>
    </div>
  );

  const { bid, stage_history, emails } = data;
  const directory = ((procoreContacts && procoreContacts.contacts) || data.company_contacts || []).filter((c) => c.email);
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

  // `only` narrows who is offered (e.g. the bid estimator picker lists job role "estimator" only);
  // the bid's current value always stays selectable so an existing assignment is never blanked.
  function assignSelect(field, currentValue, only) {
    if (!canAssign) {
      const who = assignableUsers.find((u) => u.username === currentValue);
      return <span>{currentValue ? who?.displayName || currentValue : "— unassigned —"}</span>;
    }
    const pool = only ? assignableUsers.filter(only) : assignableUsers;
    if (!assignableUsers.length) {
      return (
        <input
          defaultValue={currentValue || ""}
          onBlur={(e) => e.target.value !== (currentValue || "") && assignField(field, e.target.value)}
          style={{ fontSize: 12, padding: "2px 6px" }}
        />
      );
    }
    const options = pool.some((u) => u.username === currentValue) || !currentValue
      ? pool
      : [{ username: currentValue, displayName: assignableUsers.find((u) => u.username === currentValue)?.displayName || currentValue }, ...pool];
    return (
      <select value={currentValue || ""} onChange={(e) => assignField(field, e.target.value)} style={{ fontSize: 12, padding: "2px 4px" }}>
        <option value="">— unassigned —</option>
        {options.map((u) => (
          <option key={u.username} value={u.username}>{u.displayName || u.username}</option>
        ))}
      </select>
    );
  }

  // After logging a contact the server may ask "is this client answering?" (4th unanswered contact, then every 4th).
  function afterLog(result) {
    load();
    onChanged?.();
    if (result?.chase?.prompt) {
      setChaseHelp({ to: "", note: "" });
      setChasePrompt(result.chase);
    }
  }

  async function answerChase(responsive) {
    setBusy(true);
    setStageError(null);
    try {
      await api.answerChase(id, { responsive, help_to: chaseHelp.to || undefined, help_note: chaseHelp.note || undefined });
      setChasePrompt(null);
      load();
      onChanged?.();
    } catch (e) {
      setStageError(e.data?.detail || e.data?.error || e.message);
      setChasePrompt(null);
    } finally {
      setBusy(false);
    }
  }

  async function togglePriority() {
    setBusy(true);
    setStageError(null);
    try {
      await api.setBidPriority(id, !bid.priority_bid);
      load();
      onChanged?.();
    } catch (e) {
      setStageError(e.data?.detail || e.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  }

  async function resolveHelp(helpId, status) {
    try { await api.resolveHelp(helpId, status); load(); onChanged?.(); } catch (e) { setStageError(e.message); }
  }

  async function handleLogOther() {
    setBusy(true);
    setStageError(null);
    try {
      const res = await api.logEmail(id, { ...other, next_date: other.next_date || undefined, from_address: other.direction === "outbound" ? user.username : undefined, sent_at: new Date().toISOString() });
      setOther({ contact_type: "call", direction: "outbound", spoke_with: "", body: "", next_date: "" });
      setOtherOpen(false);
      afterLog(res);
    } catch (e) {
      setStageError(e.data?.detail || e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSetDate() {
    setBusy(true);
    setStageError(null);
    try {
      await api.setFollowupDate(id, dateDraft.date, dateDraft.reason);
      setDateOpen(false);
      setDateDraft({ date: "", reason: "" });
      load();
      onChanged?.();
    } catch (e) {
      setStageError(e.data?.detail || e.data?.error || e.message);
    } finally {
      setBusy(false);
    }
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
      const res = await api.logEmail(id, { ...emailDraft, from_address: emailDraft.direction === "outbound" ? user.username : undefined, sent_at: new Date().toISOString() });
      // Refresh before handing off to the mail client — setting
      // window.location to a mailto: URI is usually intercepted without a
      // real navigation, but doing it first risks this fetch getting cut
      // short in browsers that treat it as one anyway.
      afterLog(res);
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
          <div className="kv"><span className="kv-label">Estimator</span><span className="kv-value">{assignSelect("estimator_username", bid.estimator_username, (u) => u.jobRole === "estimator")}</span></div>
          <div className="kv"><span className="kv-label">Bid Due</span><span className="kv-value">{bid.bid_due_date || "—"}</span></div>
          <div className="kv">
            <span className="kv-label">Follow-up date</span>
            <span className="kv-value">
              {bid.next_action_date ? String(bid.next_action_date).slice(0, 10) : "not set"}
              {!["complete", "lost", "no_bid"].includes(bid.stage) && (
                <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} onClick={() => setDateOpen((o) => !o)}>{dateOpen ? "Cancel" : "Change"}</button>
              )}
            </span>
          </div>
          {!bid.stage || ["complete", "lost", "no_bid"].includes(bid.stage) ? null : (
            <div className="kv"><span className="kv-label">Priority bid</span><span className="kv-value"><label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={Boolean(bid.priority_bid)} disabled={busy} onChange={togglePriority} /> flag by hand</label></span></div>
          )}
          <div className="kv"><span className="kv-label">Next Action</span><span className="kv-value">{bid.next_action ? `${bid.next_action} (${bid.next_action_date || "no date"})` : "—"}</span></div>
        </div>

        {dateOpen && (
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="card-title">Move the follow-up date</div>
            <div className="field-row" style={{ flexWrap: "wrap", gap: 10 }}>
              <div className="field"><label>New date</label><input type="date" value={dateDraft.date} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setDateDraft((d) => ({ ...d, date: e.target.value }))} /></div>
              <div className="field" style={{ flex: 1, minWidth: 220 }}><label>Why (required)</label><input value={dateDraft.reason} onChange={(e) => setDateDraft((d) => ({ ...d, reason: e.target.value }))} placeholder="e.g. Client asked us to call after the 20th" /></div>
              <div className="field" style={{ alignSelf: "flex-end" }}><button className="btn btn-accent btn-sm" onClick={handleSetDate} disabled={busy || !dateDraft.date || dateDraft.reason.trim().length < 3}>Save date</button></div>
            </div>
          </div>
        )}
        {(bid.priority_reasons || []).length > 0 || bid.priority_bid ? (
          <div className="field-help" style={{ marginBottom: 6 }}>
            🔥 Priority bid: {(bid.priority_reasons || []).join(", ")}. It is chased on the shorter priority schedule.
          </div>
        ) : null}
        {bid.chase_slowed && (
          <div className="field-help" style={{ marginBottom: 6 }}>
            ⏳ The client hasn't been answering, so reminders for this bid are spaced out. A reply puts them back to normal.
          </div>
        )}
        {(data.help_requests || []).map((h) => (
          <div className="notification-banner" key={h.id} style={{ marginBottom: 8 }}>
            <span>
              {h.to_user === user.username
                ? `${h.from_user} asked you to try this client${h.note ? ": " + h.note : "."}`
                : `${h.from_user} asked ${h.to_user} to try this client${h.note ? ": " + h.note : "."}`}
            </span>
            {(h.to_user === user.username || h.from_user === user.username) && (
              <button className="btn btn-ghost btn-sm" onClick={() => resolveHelp(h.id, "dismissed")}>{h.to_user === user.username ? "Not needed" : "Withdraw"}</button>
            )}
          </div>
        ))}
        {(data.followup_events || []).length > 0 && (
          <div className="field-help" style={{ marginBottom: 10 }}>
            {data.followup_events.slice(0, 4).map((ev) => (
              <div key={ev.id}>
                {new Date(ev.created_at).toLocaleDateString()} · {ev.by_username}:{" "}
                {ev.kind === "assign"
                  ? `${ev.to_user ? "owner set to " + ev.to_user : "owner cleared"}${ev.from_user ? " (was " + ev.from_user + ")" : ""}${ev.reason ? " — " + ev.reason : ""}`
                  : ev.kind === "slowdown"
                    ? `reminders slowed, next follow-up ${String(ev.to_date).slice(0, 10)}`
                    : ev.kind === "help"
                      ? `asked ${ev.to_user} to try this client${ev.reason ? ": " + ev.reason : ""}`
                      : ev.kind === "priority"
                        ? ev.reason
                        : `follow-up date moved to ${String(ev.to_date).slice(0, 10)}: ${ev.reason}`}
              </div>
            ))}
          </div>
        )}

        <ScoutRecord run={data.scout_latest} count={data.scout_run_count} />

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

        <div className="card-title">Contact log ({emails.length})</div>
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
                  {(e.contact_type || "email") === "email"
                    ? (e.direction === "outbound" ? "→ sent" : "← received")
                    : `${CONTACT_ICON[e.contact_type] || "•"} ${CONTACT_LABEL[e.contact_type] || e.contact_type} · ${e.direction === "outbound" ? "we reached out" : "they contacted us"}`} · {new Date(e.sent_at).toLocaleString()}
                  {e.logged_by ? ` · by ${e.logged_by}` : ""}
                  <span style={{ float: "right" }}>{expanded ? "▲ collapse" : "▼ view"}</span>
                </div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{e.subject || "(no subject)"}</div>
                {expanded && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border-color)" }} onClick={(ev) => ev.stopPropagation()}>
                    {e.spoke_with && <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>Spoke with: {e.spoke_with}</div>}
                    {e.to_addresses && <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>To: {e.to_addresses}</div>}
                    {e.from_address && <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>From: {e.from_address}</div>}
                    {e.cc_addresses && <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 4 }}>Cc: {e.cc_addresses}</div>}
                    <div style={{ fontSize: 13, whiteSpace: "pre-wrap", marginTop: 6 }}>{e.body || ((e.contact_type || "email") === "email" ? "(no body logged)" : "(no note)")}</div>
                  </div>
                )}
              </div>
            );
          })}
          {emails.length === 0 && <div className="empty-state">No contact logged yet.</div>}
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
            <div className="field-help" style={{ marginTop: 4 }}>
              {procoreContacts && procoreContacts.linked === false
                ? "This client isn't linked to Procore yet, so only the contacts already in CRM are listed."
                : procoreContacts && procoreContacts.error
                  ? "Couldn't refresh from Procore just now; showing the contacts CRM already has."
                  : procoreContacts && procoreContacts.synced_at
                    ? "Contacts from Procore's Directory, updated " + new Date(procoreContacts.synced_at).toLocaleDateString() + "."
                    : refreshingContacts ? "Checking Procore for this client's contacts…" : ""}
              {procoreContacts && procoreContacts.linked !== false && (
                <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} disabled={refreshingContacts} onClick={() => loadProcoreContacts(true)}>{refreshingContacts ? "…" : "↻ Refresh from Procore"}</button>
              )}
            </div>
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
        <div style={{ marginBottom: 16 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setOtherOpen((o) => !o)}>{otherOpen ? "− Other contact" : "+ Other contact (call, in person, text…)"}</button>
          {otherOpen && (
            <div className="card" style={{ marginTop: 8 }}>
              <div className="field-help" style={{ marginBottom: 8 }}>For when you spoke with someone another way. It restarts the follow-up clock like an email does.</div>
              <div className="field-row" style={{ flexWrap: "wrap", gap: 10, marginBottom: 6 }}>
                <div className="field">
                  <label>How</label>
                  <select value={other.contact_type} onChange={(e) => setOther((o) => ({ ...o, contact_type: e.target.value }))}>
                    <option value="call">Phone call</option>
                    <option value="meeting">In-person conversation</option>
                    <option value="text">Text / chat message</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div className="field">
                  <label>Who started it</label>
                  <select value={other.direction} onChange={(e) => setOther((o) => ({ ...o, direction: e.target.value }))}>
                    <option value="outbound">I reached out</option>
                    <option value="inbound">They contacted me</option>
                  </select>
                </div>
                <div className="field" style={{ flex: 1, minWidth: 180 }}>
                  <label>Spoke with</label>
                  <input value={other.spoke_with} onChange={(e) => setOther((o) => ({ ...o, spoke_with: e.target.value }))} placeholder="Name of the person" />
                  {directory.length > 0 && (
                    <select value="" onChange={(e) => e.target.value && setOther((o) => ({ ...o, spoke_with: e.target.value }))} style={{ marginTop: 4, fontSize: 12 }}>
                      <option value="">+ Pick from {bid.company_name || "client"} directory…</option>
                      {directory.map((c) => {
                        const nm = [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email;
                        return <option key={c.id} value={nm}>{nm}{c.title ? ` — ${c.title}` : ""}</option>;
                      })}
                    </select>
                  )}
                </div>
              </div>
              <div className="field" style={{ marginBottom: 8 }}>
                <label>Next follow-up date (optional; leave blank to use the usual gap)</label>
                <input type="date" value={other.next_date} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setOther((o) => ({ ...o, next_date: e.target.value }))} style={{ maxWidth: 200 }} />
              </div>
              <div className="field" style={{ marginBottom: 8 }}>
                <label>What was discussed (a line or two)</label>
                <textarea rows={2} value={other.body} onChange={(e) => setOther((o) => ({ ...o, body: e.target.value }))} />
              </div>
              <button className="btn btn-accent btn-sm" onClick={handleLogOther} disabled={busy || other.body.trim().length < 3}>Log contact</button>
            </div>
          )}
        </div>

        {chasePrompt && (
          <div className="modal-backdrop" style={{ zIndex: 60 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal" style={{ width: 480 }} onClick={(e) => e.stopPropagation()}>
              <h2 style={{ marginBottom: 8 }}>Is this client answering you?</h2>
              <p style={{ fontSize: 14, marginBottom: 10 }}>
                You've now reached out {chasePrompt.unanswered} times on this bid without hearing back.
              </p>
              <p className="field-help" style={{ marginBottom: 12 }}>
                If they've gone quiet, say so and CRM will wait a little longer before reminding you about this bid, so you aren't chasing at the same pace
                (about 1½ times the usual gap, and double after 7 tries). When they reply, the reminders go back to normal on their own.
              </p>
              <div className="card" style={{ background: "var(--bg-page)", marginBottom: 12 }}>
                <div className="card-title">Want someone else to try?</div>
                <div className="field-help" style={{ marginBottom: 6 }}>A manager or colleague may have a better way in. They'll see this bid on their Follow-ups list with your note.</div>
                <select value={chaseHelp.to} onChange={(e) => setChaseHelp((h) => ({ ...h, to: e.target.value }))} style={{ marginBottom: 6, width: "100%" }}>
                  <option value="">No, I'll keep trying</option>
                  {assignableUsers.filter((u) => u.username !== user.username).map((u) => <option key={u.username} value={u.username}>{u.displayName || u.username}</option>)}
                </select>
                {chaseHelp.to && <input placeholder="Note for them (optional)" value={chaseHelp.note} onChange={(e) => setChaseHelp((h) => ({ ...h, note: e.target.value }))} style={{ width: "100%" }} />}
              </div>
              <div className="modal-actions">
                <button className="btn btn-ghost" disabled={busy} onClick={() => answerChase(true)}>Yes, they're responding</button>
                <button className="btn btn-accent" disabled={busy} onClick={() => answerChase(false)}>No, slow my reminders down</button>
              </div>
            </div>
          </div>
        )}

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
