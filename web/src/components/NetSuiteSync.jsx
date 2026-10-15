import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";

// Admin tool (Access tab): link or create a CRM company for every active NetSuite
// customer. Always preview first; nothing changes until "Apply". Existing
// companies keep their segment, region and flags; the sync only adds the
// NetSuite id (and the Procore company id where CRM lacks it).
function Section({ title, count, children, open }) {
  if (!count) return null;
  return (
    <details open={open} style={{ marginBottom: 10 }}>
      <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>{title} ({count})</summary>
      <div style={{ marginTop: 6, maxHeight: 280, overflowY: "auto" }}>{children}</div>
    </details>
  );
}

export default function NetSuiteSync() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null);

  const load = useCallback(() => api.getNsSync().then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  async function run(label, fn) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e.data?.detail || e.message);
    } finally {
      setBusy(null);
    }
  }

  const pendingCount = (op) => (data?.counts || []).filter((c) => c.op === op && c.status === "pending").reduce((s, c) => s + c.n, 0);
  const toApply = pendingCount("link") + pendingCount("create");

  async function applyAll() {
    await run("apply", async () => {
      let remaining = toApply;
      setProgress(`0 of ${remaining}`);
      for (let i = 0; i < 100 && remaining > 0; i++) {
        const r = await api.applyNsSync(data.run.id);
        remaining = r.remaining;
        setProgress(`${toApply - remaining} of ${toApply}`);
      }
      setProgress(null);
    });
  }

  const s = data?.run?.summary;
  return (
    <div style={{ marginTop: 28 }}>
      <div className="card-title">NetSuite customer sync</div>
      <p className="field-help" style={{ marginBottom: 10, maxWidth: 720 }}>
        Reads every active NetSuite customer and lines it up with CRM: existing companies are linked (by Procore company id, then by
        the same name), missing ones are created with the segment "Customer". Close-but-not-identical names are never linked
        automatically; they wait here for you. Nothing is changed until you press Apply.
      </p>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <button className="btn btn-accent btn-sm" disabled={!!busy} onClick={() => run("preview", () => api.previewNsSync())}>
          {busy === "preview" ? "Reading NetSuite…" : data?.run ? "↻ Preview again" : "Preview sync"}
        </button>
        {data?.run && toApply > 0 && (
          <button className="btn btn-accent btn-sm" disabled={!!busy} onClick={applyAll}>
            {busy === "apply" ? `Applying… ${progress || ""}` : `Apply ${toApply} change${toApply === 1 ? "" : "s"}`}
          </button>
        )}
        {data?.run && (
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)" }}>
            <input type="checkbox" checked={!!data.auto} disabled={!!busy} onChange={(e) => run("auto", () => api.setNsSyncAuto(e.target.checked))} />
            Keep syncing automatically every night (new matches are linked or created; unusual ones wait here)
          </label>
        )}
      </div>
      {error && <div className="login-error" style={{ marginBottom: 8 }}>{error}</div>}
      {!data && !error && <div className="spinner-inline">Loading…</div>}
      {data && !data.run && <div className="field-help">No preview yet.</div>}
      {s && (
        <>
          <div className="field-help" style={{ marginBottom: 8 }}>
            Preview from {new Date(data.run.created_at).toLocaleString()}{data.run.created_by ? ` by ${data.run.created_by}` : ""}.
          </div>
          <div className="kv-grid" style={{ marginBottom: 12 }}>
            <div className="kv"><span className="kv-label">NetSuite customers</span><span className="kv-value">{s.netsuite_customers}</span></div>
            <div className="kv"><span className="kv-label">Already linked</span><span className="kv-value">{s.already_linked}</span></div>
            <div className="kv"><span className="kv-label">Link by Procore id</span><span className="kv-value">{s.link_by_procore_id}</span></div>
            <div className="kv"><span className="kv-label">Link by same name</span><span className="kv-value">{s.link_by_name}</span></div>
            <div className="kv"><span className="kv-label">New companies</span><span className="kv-value">{s.create}{s.create_individuals ? ` (${s.create_individuals} individuals)` : ""}</span></div>
            <div className="kv"><span className="kv-label">Needs your review</span><span className="kv-value">{s.review}</span></div>
            <div className="kv"><span className="kv-label">Ambiguous</span><span className="kv-value">{s.ambiguous}</span></div>
          </div>

          <Section title="Needs your review: similar names" count={data.review.length} open>
            <table className="data-table">
              <thead><tr><th>NetSuite customer</th><th>Similar CRM company</th><th /></tr></thead>
              <tbody>
                {data.review.map((r) => (
                  <tr key={r.id}>
                    <td>{r.ns_name}</td>
                    <td>{r.company_name} <span className="row-secondary">{r.detail}</span></td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => run("r" + r.id, () => api.reviewNsSync(r.id, "link"))}>Same company</button>{" "}
                      <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => run("r" + r.id, () => api.reviewNsSync(r.id, "create"))}>Different, create</button>{" "}
                      <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => run("r" + r.id, () => api.reviewNsSync(r.id, "skip"))}>Skip</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
          <Section title="Ambiguous: fix in CRM (duplicates or already linked)" count={data.ambiguous.length} open>
            <table className="data-table">
              <thead><tr><th>NetSuite customer</th><th>Why</th></tr></thead>
              <tbody>{data.ambiguous.map((r) => <tr key={r.id}><td>{r.ns_name}</td><td>{r.detail}</td></tr>)}</tbody>
            </table>
          </Section>
          <Section title="Will create these companies" count={data.create.length}>
            <table className="data-table">
              <thead><tr><th>Name</th><th>NetSuite id</th><th>Procore id</th></tr></thead>
              <tbody>{data.create.map((r) => <tr key={r.id}><td>{r.ns_name}{r.detail === "individual" ? " (individual)" : ""}</td><td>{r.ns_id}</td><td>{r.procore_id || "—"}</td></tr>)}</tbody>
            </table>
          </Section>
          <Section title="Will link these existing companies" count={data.link.length}>
            <table className="data-table">
              <thead><tr><th>NetSuite customer</th><th>CRM company</th><th>Matched by</th></tr></thead>
              <tbody>{data.link.map((r) => <tr key={r.id}><td>{r.ns_name}</td><td>{r.company_name}</td><td>{r.detail}</td></tr>)}</tbody>
            </table>
          </Section>
        </>
      )}
    </div>
  );
}
