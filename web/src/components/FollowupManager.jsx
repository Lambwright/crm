import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { STAGE_LABELS } from "../stages.js";
import RegionSelect from "./RegionSelect.jsx";

// Follow-up manager dashboard (Ben, 2026-10-21): progress, bulk assignment and the
// auto-assignment rules. For admins, estimators and follow-up managers only. The rules
// belong to the follow-up managers: everyone else sees them read-only and has to confirm
// before editing (a prompt, not a block).
const name = (people, u) => people.find((p) => p.username === u)?.displayName || u || "";

function describe(rule, people) {
  const who = name(people, rule.assignee_username);
  if (rule.kind === "client") return <>Client <strong>{rule.company_name || "(removed company)"}</strong> goes to <strong>{who}</strong></>;
  if (rule.kind === "region") return <>Clients in region <strong>{rule.value}</strong> go to <strong>{who}</strong></>;
  if (rule.kind === "province") return <>Projects in <strong>{rule.value}</strong> (from the "{rule.value} –" in the project name) go to <strong>{who}</strong></>;
  if (rule.kind === "relationship") return <>Whoever last handled this client's bids</>;
  const pool = (Array.isArray(rule.pool) ? rule.pool : []).map((u) => name(people, u)).join(", ");
  return <>Spread across <strong>{pool}</strong> by current workload</>;
}

const statsText = (m) => m.matched + " match · " + m.will_assign + " to assign · " + m.already_theirs + " already theirs · " + m.owned_by_others + " owned by others · " + m.in_estimating_hold + " still with estimating";

function ConfirmEditModal({ managers, noun = "rules", onCancel, onConfirm }) {
  const list = managers.map((m) => m.displayName || m.username).join(", ");
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginBottom: 8 }}>{noun === "rules" ? "Edit the assignment rules?" : "Change the follow-up cadence?"}</h2>
        <p style={{ fontSize: 14, marginBottom: 14 }}>
          {managers.length > 0
            ? <>The {noun === "rules" ? "rules are" : "cadence is"} managed by <strong>{list}</strong>. Confirm you want to proceed with adjusting {noun === "rules" ? "these rules" : "the cadence"}.</>
            : <>The {noun === "rules" ? "rules are" : "cadence is"} managed by the Follow-up Manager role, and nobody has it yet. Confirm you want to proceed with adjusting {noun === "rules" ? "these rules" : "the cadence"}.</>}
        </p>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn btn-accent" onClick={onConfirm}>{noun === "rules" ? "Yes, edit the rules" : "Yes, change the cadence"}</button>
        </div>
      </div>
    </div>
  );
}

function AddRule({ people, onAdded }) {
  const [kind, setKind] = useState("client");
  const [assignee, setAssignee] = useState("");
  const [value, setValue] = useState("");
  const [pool, setPool] = useState([]);
  const [company, setCompany] = useState(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function search(text) {
    setQ(text); setCompany(null);
    if (text.trim().length < 2) { setResults([]); return; }
    try { setResults(((await api.listCompanies({ q: text.trim() })).companies || []).slice(0, 8)); } catch (e) { setError(e.message); }
  }
  async function add() {
    setBusy(true); setError(null);
    try {
      await api.followupRule({ action: "create", kind, assignee_username: assignee || null, value, pool, company_id: company?.id || null });
      setQ(""); setCompany(null); setValue(""); setPool([]); setAssignee("");
      onAdded();
    } catch (e) { setError(e.data?.detail || e.data?.error || e.message); } finally { setBusy(false); }
  }
  const needsAssignee = kind === "client" || kind === "region" || kind === "province";
  return (
    <div className="card" style={{ background: "var(--bg-page)", marginTop: 10 }}>
      <div className="card-title">Add a rule (it goes to the bottom; reorder it afterward)</div>
      <div className="field-row" style={{ flexWrap: "wrap", gap: 10 }}>
        <div className="field">
          <label>Type</label>
          <select value={kind} onChange={(e) => { setKind(e.target.value); setError(null); }}>
            <option value="client">A specific client goes to someone</option>
            <option value="region">A region goes to someone</option>
            <option value="province">A province (from the project name) goes to someone</option>
            <option value="relationship">Whoever last handled the client</option>
            <option value="balance">Spread across people by workload</option>
          </select>
        </div>
        {kind === "client" && (
          <div className="field" style={{ minWidth: 240 }}>
            <label>Client</label>
            <input placeholder="Search…" value={company ? company.name : q} onChange={(e) => search(e.target.value)} />
            {!company && results.length > 0 && (
              <div className="row-list" style={{ maxHeight: 140, overflowY: "auto" }}>
                {results.map((c) => <button key={c.id} className="btn btn-ghost btn-sm" style={{ textAlign: "left" }} onClick={() => { setCompany(c); setResults([]); }}>{c.name}{c.city ? ` · ${c.city}` : ""}</button>)}
              </div>
            )}
          </div>
        )}
        {kind === "region" && <div className="field"><label>Region</label><RegionSelect value={value} onChange={(v) => setValue(v || "")} /></div>}
        {kind === "province" && <div className="field"><label>Province code</label><input value={value} onChange={(e) => setValue(e.target.value.toUpperCase().slice(0, 2))} placeholder="ON" style={{ width: 70 }} /></div>}
        {needsAssignee && (
          <div className="field">
            <label>Assign to</label>
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">— pick —</option>
              {people.map((p) => <option key={p.username} value={p.username}>{p.displayName || p.username}</option>)}
            </select>
          </div>
        )}
        {kind === "balance" && (
          <div className="field" style={{ minWidth: 260 }}>
            <label>People to spread across</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {people.map((p) => (
                <label key={p.username} style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12 }}>
                  <input type="checkbox" checked={pool.includes(p.username)} onChange={(e) => setPool((cur) => (e.target.checked ? [...cur, p.username] : cur.filter((u) => u !== p.username)))} />
                  {p.displayName || p.username}
                </label>
              ))}
            </div>
          </div>
        )}
        <div className="field" style={{ alignSelf: "flex-end" }}>
          <button className="btn btn-accent btn-sm" disabled={busy} onClick={add}>{busy ? "…" : "Add rule"}</button>
        </div>
      </div>
      {error && <div className="login-error" style={{ marginTop: 6 }}>{error}</div>}
    </div>
  );
}

const CADENCE_STAGES = ["rfq", "invitation", "estimating", "bid_submitted", "to_do", "accepted", "in_progress", "delayed"];

function CadenceEditor({ cadence, priorityCadence, holdDays, canEditDirectly, managers, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState({});
  const [draftPriority, setDraftPriority] = useState({});
  const [draftHold, setDraftHold] = useState("15");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const start = () => {
    setDraft(Object.fromEntries(CADENCE_STAGES.map((k) => [k, String(cadence[k] ?? "")])));
    setDraftPriority(Object.fromEntries(CADENCE_STAGES.map((k) => [k, String((priorityCadence || {})[k] ?? "")])));
    setDraftHold(String(holdDays ?? 15));
    setError(null);
    setEditing(true);
  };
  async function save() {
    setBusy(true); setError(null);
    try {
      await api.saveCadence(
        Object.fromEntries(CADENCE_STAGES.map((k) => [k, Number(draft[k])])),
        Object.fromEntries(CADENCE_STAGES.map((k) => [k, Number(draftPriority[k])])),
        Number(draftHold),
      );
      setEditing(false);
      await onSaved();
    } catch (e) { setError(e.data?.detail || e.data?.error || e.message); } finally { setBusy(false); }
  }
  const cell = (draftMap, setMap, source, k) => (editing
    ? <input type="number" min="0" max="90" value={draftMap[k]} onChange={(e) => setMap((d) => ({ ...d, [k]: e.target.value }))} style={{ width: 56 }} />
    : (source || {})[k] ?? "—");
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <div className="card-title">Follow-up cadence</div>
        {!editing && <button className="btn btn-ghost btn-sm" onClick={() => (canEditDirectly ? start() : setConfirming(true))}>{canEditDirectly ? "Edit cadence" : "🔒 Edit cadence…"}</button>}
        {editing && <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>Cancel</button>}
      </div>
      <p className="field-help" style={{ marginBottom: 8, maxWidth: 720 }}>
        Days between follow-ups on an open bid, by stage. Logging a contact restarts the clock using these numbers. Changes apply to dates set from now on; dates already on bids stay as they are. 0 means no follow-ups at that stage.
        Priority bids (SCOUT Tier A, a priority client, or flagged by hand) use the shorter second row.
      </p>
      <table className="data-table">
        <thead><tr><th />{CADENCE_STAGES.map((k) => <th key={k} className="num">{STAGE_LABELS[k] || k}</th>)}</tr></thead>
        <tbody>
          <tr><td>Normal</td>{CADENCE_STAGES.map((k) => <td key={k} className="num">{cell(draft, setDraft, cadence, k)}</td>)}</tr>
          <tr><td>🔥 Priority</td>{CADENCE_STAGES.map((k) => <td key={k} className="num">{cell(draftPriority, setDraftPriority, priorityCadence, k)}</td>)}</tr>
        </tbody>
      </table>
      <p className="field-help" style={{ marginTop: 8 }}>
        New bids belong to estimating alone for their first{" "}
        {editing ? <input type="number" min="0" max="60" value={draftHold} onChange={(e) => setDraftHold(e.target.value)} style={{ width: 56 }} /> : <strong>{holdDays ?? 15}</strong>} days:
        they aren't flagged as unassigned and the auto-assignment rules leave them alone. After that they need an owner.
      </p>
      {editing && (
        <div style={{ marginTop: 8 }}>
          <button className="btn btn-accent btn-sm" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
          {error && <span className="login-error" style={{ marginLeft: 10 }}>{error}</span>}
        </div>
      )}
      {confirming && <ConfirmEditModal noun="cadence" managers={managers} onCancel={() => setConfirming(false)} onConfirm={() => { setConfirming(false); start(); }} />}
    </div>
  );
}

export default function FollowupManager() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("attention");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState(() => new Set());
  const [assignTo, setAssignTo] = useState("");
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [preview, setPreview] = useState(null);
  const [includeOwned, setIncludeOwned] = useState(false);

  const load = useCallback(() => api.getFollowupDashboard().then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const work = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.work.filter((w) => {
      if (filter === "unassigned" && !w.unassigned) return false;
      if (filter === "overdue" && !(w.days_overdue != null && w.days_overdue > 0)) return false;
      if (q && !(`${w.project_name} ${w.company_name || ""}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [data, filter, search]);

  if (error) return <div className="card" style={{ color: "var(--red)" }}>{error}</div>;
  if (!data) return <div className="spinner-inline">Loading…</div>;

  const { summary, team, rules, managers, people } = data;
  const people2 = people || [];

  async function run(label, fn) {
    setBusy(label); setMsg(null);
    try { await fn(); } catch (e) { setMsg(e.data?.detail || e.data?.error || e.message); } finally { setBusy(null); }
  }
  const toggle = (id) => setPicked((cur) => { const n = new Set(cur); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allPicked = work.length > 0 && work.every((w) => picked.has(w.id));

  const assign = (owner) => run("assign", async () => {
    const r = await api.bulkAssignFollowups([...picked], owner);
    setMsg(`${r.assigned} bid${r.assigned === 1 ? "" : "s"} ${owner ? "assigned to " + name(people2, owner) : "unassigned"}.`);
    setPicked(new Set());
    await load();
  });
  const rule = (body) => run("rule", async () => { await api.followupRule(body); await load(); setPreview(await api.previewFollowupRules(includeOwned)); });
  const startEdit = () => (data.can.edit_rules_directly ? setEditing(true) : setConfirming(true));

  return (
    <>
      <div className="kv-grid" style={{ marginBottom: 16 }}>
        <div className="card"><div className="kv-label">Open bids</div><div className="kv-value mono stat">{summary.open_bids}</div></div>
        <div className="card"><div className="kv-label">Overdue</div><div className="kv-value mono stat" style={{ color: summary.overdue ? "var(--red)" : undefined }}>{summary.overdue}</div></div>
        <div className="card"><div className="kv-label">Due today</div><div className="kv-value mono stat">{summary.due_today}</div></div>
        <div className="card"><div className="kv-label">No follow-up date</div><div className="kv-value mono stat">{summary.never_set}</div></div>
        <div className="card"><div className="kv-label">Unassigned</div><div className="kv-value mono stat">{summary.unassigned}</div></div>
        <div className="card"><div className="kv-label">New, with estimating</div><div className="kv-value mono stat">{summary.estimating_hold}</div></div>
      </div>

      <div className="card-title">Team progress</div>
      <p className="field-help" style={{ marginBottom: 8 }}>Open bids assigned to each person, how many are overdue, and the contacts (emails, calls, meetings) they logged recently.</p>
      <table className="data-table" style={{ marginBottom: 24 }}>
        <thead><tr><th>Person</th><th className="num">Open</th><th className="num">Overdue</th><th className="num">Due today</th><th className="num">Contacts logged (7 days)</th><th className="num">(30 days)</th></tr></thead>
        <tbody>
          {team.map((t) => (
            <tr key={t.username}><td>{t.displayName || t.username} <span className="row-secondary">{t.level}</span></td><td className="num">{t.open}</td><td className="num" style={{ color: t.overdue ? "var(--red)" : undefined }}>{t.overdue}</td><td className="num">{t.due_today}</td><td className="num">{t.logged_7d}</td><td className="num">{t.logged_30d}</td></tr>
          ))}
        </tbody>
      </table>

      <div className="card-title">Assign follow-ups</div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <div className="tabs" style={{ marginBottom: 0 }}>
          {[["attention", "Needs attention"], ["unassigned", "Unassigned"], ["overdue", "Overdue"]].map(([k, l]) => (
            <button key={k} className={`tab ${filter === k ? "active" : ""}`} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
        <input placeholder="Search project or client…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 260 }} />
        <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
          <option value="">Assign selected to…</option>
          {people2.map((p) => <option key={p.username} value={p.username}>{p.displayName || p.username}</option>)}
        </select>
        <button className="btn btn-accent btn-sm" disabled={!!busy || !picked.size || !assignTo || !data.can.assign} onClick={() => assign(assignTo)}>Assign {picked.size || ""}</button>
        <button className="btn btn-ghost btn-sm" disabled={!!busy || !picked.size || !data.can.assign} onClick={() => assign(null)}>Unassign</button>
      </div>
      {msg && <div className="field-help" style={{ marginBottom: 8 }}>{msg}</div>}
      <div style={{ maxHeight: 360, overflowY: "auto", marginBottom: 24 }}>
        <table className="data-table">
          <thead><tr><th><input type="checkbox" checked={allPicked} onChange={(e) => setPicked(e.target.checked ? new Set(work.map((w) => w.id)) : new Set())} /></th><th>Project</th><th>Client</th><th>Stage</th><th>Assigned</th><th>Follow-up</th></tr></thead>
          <tbody>
            {work.map((w) => (
              <tr key={w.id}>
                <td><input type="checkbox" checked={picked.has(w.id)} onChange={() => toggle(w.id)} /></td>
                <td>{w.priority ? "🔥 " : ""}{w.project_name}{w.slowed ? <span className="row-secondary"> · slowed</span> : null}</td><td>{w.company_name || "—"}</td><td>{STAGE_LABELS[w.stage] || w.stage}</td>
                <td>{w.owner_username ? name(people2, w.owner_username) : w.estimating_hold ? <span className="row-secondary">estimating{w.estimator_username ? ` (${name(people2, w.estimator_username)})` : ""}</span> : <span className="row-secondary">unassigned</span>}</td>
                <td style={{ color: w.days_overdue != null && w.days_overdue > 0 ? "var(--red)" : undefined }}>
                  {w.days_overdue == null ? "no date" : w.days_overdue > 0 ? `${w.days_overdue} day${w.days_overdue === 1 ? "" : "s"} overdue` : w.days_overdue === 0 ? "due today" : `due in ${-w.days_overdue} days`}
                </td>
              </tr>
            ))}
            {work.length === 0 && <tr><td colSpan={6} className="empty-state">Nothing here.</td></tr>}
          </tbody>
        </table>
      </div>

      {data.cadence && <CadenceEditor cadence={data.cadence} priorityCadence={data.priority_cadence} holdDays={data.estimating_hold_days} canEditDirectly={data.can.edit_rules_directly} managers={managers} onSaved={load} />}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <div className="card-title">Auto-assignment rules</div>
        {!editing && <button className="btn btn-ghost btn-sm" onClick={startEdit}>{data.can.edit_rules_directly ? "Edit rules" : "🔒 Edit rules…"}</button>}
        {editing && <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>Done editing</button>}
      </div>
      <p className="field-help" style={{ marginBottom: 8, maxWidth: 720 }}>
        Rules run top to bottom for bids with nobody assigned; the first that names someone wins. Managed by {managers.length ? managers.map((m) => m.displayName || m.username).join(", ") : "the Follow-up Manager role (nobody has it yet)"}.
      </p>
      <table className="data-table">
        <thead><tr><th>#</th><th>Rule</th><th>Active</th>{preview && <th>Matches (open bids)</th>}{editing && <th />}</tr></thead>
        <tbody>
          {rules.map((r, i) => (
            <tr key={r.id} style={{ opacity: r.active ? 1 : 0.5 }}>
              <td>{i + 1}</td>
              <td>{describe(r, people2)}</td>
              <td>{editing ? <input type="checkbox" checked={r.active} onChange={(e) => rule({ action: "toggle", id: r.id, active: e.target.checked })} /> : r.active ? "Yes" : "Off"}</td>
              {preview && <td className="row-secondary">{preview.rule_stats && preview.rule_stats[r.id] ? statsText(preview.rule_stats[r.id]) : "—"}</td>}
              {editing && (
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="btn btn-ghost btn-sm" disabled={i === 0 || !!busy} onClick={() => rule({ action: "move", id: r.id, direction: "up" })}>↑</button>{" "}
                  <button className="btn btn-ghost btn-sm" disabled={i === rules.length - 1 || !!busy} onClick={() => rule({ action: "move", id: r.id, direction: "down" })}>↓</button>{" "}
                  <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => rule({ action: "delete", id: r.id })}>Delete</button>
                </td>
              )}
            </tr>
          ))}
          {rules.length === 0 && <tr><td colSpan={editing ? 4 : 3} className="empty-state">No rules yet.</td></tr>}
        </tbody>
      </table>
      {editing && <AddRule people={people2} onAdded={async () => { await load(); try { setPreview(await api.previewFollowupRules(includeOwned)); } catch (e) { setPreview(null); } }} />}

      <div style={{ marginTop: 14, display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn btn-accent btn-sm" disabled={!!busy || !rules.length} onClick={() => run("preview", async () => setPreview(await api.previewFollowupRules(includeOwned)))}>{busy === "preview" ? "Checking…" : "Preview who the rules would assign"}</button>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--text-secondary)" }}>
          <input type="checkbox" checked={includeOwned} onChange={(e) => { setIncludeOwned(e.target.checked); setPreview(null); }} />
          Also move bids that already have another owner (client, region and province rules only)
        </label>
      </div>
      {preview && (
        <div className="card" style={{ marginTop: 10 }}>
          <div className="field-help" style={{ marginBottom: 6 }}>
            {preview.assignments.length} bid{preview.assignments.length === 1 ? "" : "s"} would be assigned; {preview.unmatched} with no owner match no rule.
            {preview.skipped && preview.skipped.already_owned > 0 ? ` ${preview.skipped.already_owned} already have an owner and are left alone.` : ""}
            {preview.skipped && preview.skipped.estimating_hold > 0 ? ` ${preview.skipped.estimating_hold} are new and still with estimating.` : ""}
          </div>
          {preview.assignments.length > 0 && (
            <>
              <div style={{ maxHeight: 220, overflowY: "auto" }}>
                <table className="data-table">
                  <thead><tr><th>Project</th><th>Client</th><th>Goes to</th><th>Was</th><th>Rule</th></tr></thead>
                  <tbody>{preview.assignments.map((a) => <tr key={a.bid_id}><td>{a.project_name}</td><td>{a.company_name || "—"}</td><td>{name(people2, a.assignee)}</td><td>{a.from ? name(people2, a.from) : <span className="row-secondary">no owner</span>}</td><td>{a.rule_kind}</td></tr>)}</tbody>
                </table>
              </div>
              <button className="btn btn-accent btn-sm" style={{ marginTop: 8 }} disabled={!!busy || !data.can.assign} onClick={() => run("apply", async () => { const r = await api.applyFollowupRules(includeOwned); setMsg(`Assigned ${r.assigned} bid${r.assigned === 1 ? "" : "s"}; ${r.unmatched} matched no rule.`); setPreview(null); await load(); })}>
                {busy === "apply" ? "Assigning…" : `Assign these ${preview.assignments.length}`}
              </button>
            </>
          )}
        </div>
      )}
      {confirming && <ConfirmEditModal managers={managers} onCancel={() => setConfirming(false)} onConfirm={() => { setConfirming(false); setEditing(true); }} />}
    </>
  );
}
