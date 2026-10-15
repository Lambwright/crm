import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";

// Admin tool (Companies tab): upload a NetSuite customer export (CSV) and link
// or create a CRM company for each customer. Always preview first; nothing
// changes until "Apply". Existing companies keep their segment, region and
// flags; the import only adds the NetSuite id (and the Procore company id where
// CRM lacks it).

// --- tiny CSV reader (quotes, commas or tabs, Excel's BOM) ---------------------
function parseCsv(text) {
  const t = text.replace(/^﻿/, "");
  const firstLine = t.split(/\r?\n/, 1)[0] || "";
  const delim = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? "\t" : ",";
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) {
      if (c === '"') { if (t[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

const squash = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const GUESS = {
  ns_id: ["internalid", "netsuiteid", "nsid", "internalidnumber", "customerinternalid", "nscustomerid"],
  companyname: ["companyname", "company"],
  name: ["name", "customer", "customername"],
  entityid: ["entityid", "customerid", "id"],
  procore: ["procoreid", "procorecompanyid", "procorevendorid", "procore", "pcid", "procorecompany", "procorecompanyidnumber"],
  stage: ["stage", "entitystage", "status"],
  inactive: ["inactive", "isinactive"],
};
function guessColumns(header) {
  const h = header.map(squash);
  const out = {};
  for (const [field, names] of Object.entries(GUESS)) {
    const i = h.findIndex((x) => names.includes(x));
    out[field] = i === -1 ? "" : String(i);
  }
  return out;
}
const FIELD_LABELS = {
  ns_id: "NetSuite internal ID (required)",
  companyname: "Company name",
  name: "Name (used if there's no company name)",
  entityid: "Entity ID (for individuals)",
  procore: "Procore ID (project IDs are fine; used as evidence only)",
  stage: "Stage (optional; only 'Customer' rows are used)",
  inactive: "Inactive (optional; inactive rows are skipped)",
};

function buildRows(table, map) {
  const get = (r, f) => (map[f] === "" ? "" : (r[Number(map[f])] ?? "").trim());
  const rows = [];
  let skippedStage = 0, skippedInactive = 0;
  for (const r of table.slice(1)) {
    const stage = get(r, "stage");
    if (map.stage !== "" && stage && !/^customer/i.test(stage)) { skippedStage++; continue; }
    const inactive = get(r, "inactive");
    if (map.inactive !== "" && /^(t|true|yes|y|1)$/i.test(inactive)) { skippedInactive++; continue; }
    const ns_id = get(r, "ns_id");
    if (!ns_id) continue;
    rows.push({
      ns_id,
      companyname: get(r, "companyname"),
      name: get(r, "name"),
      entityid: get(r, "entityid"),
      procore_ids: get(r, "procore").split(/[,;|\s]+/).filter(Boolean),
    });
  }
  return { rows, skippedStage, skippedInactive };
}

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
  const [table, setTable] = useState(null); // parsed CSV, header row first
  const [fileName, setFileName] = useState("");
  const [map, setMap] = useState(null);
  const fileRef = useRef(null);

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

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    const text = await file.text();
    const t = parseCsv(text);
    if (t.length < 2) { setError("That file has no data rows."); return; }
    setFileName(file.name);
    setTable(t);
    setMap(guessColumns(t[0]));
  }

  const built = table && map ? buildRows(table, map) : null;

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
    <div style={{ marginBottom: 24 }}>
      <div className="card-title">Import customers from NetSuite (CSV)</div>
      <p className="field-help" style={{ marginBottom: 10, maxWidth: 720 }}>
        Export your NetSuite customers to a CSV with the internal ID, company name and (optionally) Procore IDs, and drop it here. Each
        customer is lined up with a CRM company (first by a Procore project that one of its bids points at, then by the same name); missing ones are created with the
        segment "Customer". Close-but-not-identical names are never linked automatically; they wait for you. Nothing changes until
        you press Apply.
      </p>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv" onChange={onFile} />
        {built && (
          <button
            className="btn btn-accent btn-sm"
            disabled={!!busy || !built.rows.length || map.ns_id === ""}
            onClick={() => run("preview", () => api.previewNsSync(built.rows))}
          >
            {busy === "preview" ? "Matching…" : `Preview ${built.rows.length} customers`}
          </button>
        )}
        {data?.run && toApply > 0 && (
          <button className="btn btn-accent btn-sm" disabled={!!busy} onClick={applyAll}>
            {busy === "apply" ? `Applying… ${progress || ""}` : `Apply ${toApply} change${toApply === 1 ? "" : "s"}`}
          </button>
        )}
      </div>

      {table && map && (
        <details open style={{ marginBottom: 12 }}>
          <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
            {fileName}: {table.length - 1} rows. Check the columns I picked
          </summary>
          <div className="field-row" style={{ flexWrap: "wrap", marginTop: 8 }}>
            {Object.entries(FIELD_LABELS).map(([f, label]) => (
              <div className="field" key={f} style={{ minWidth: 240 }}>
                <label>{label}</label>
                <select value={map[f]} onChange={(e) => setMap((m) => ({ ...m, [f]: e.target.value }))}>
                  <option value="">— none —</option>
                  {table[0].map((h, i) => <option key={i} value={String(i)}>{h || `(column ${i + 1})`}</option>)}
                </select>
              </div>
            ))}
          </div>
          {built && (
            <div className="field-help">
              Using {built.rows.length} rows
              {built.skippedStage ? `, skipping ${built.skippedStage} that aren't customers` : ""}
              {built.skippedInactive ? `, ${built.skippedInactive} inactive` : ""}.
              {map.ns_id === "" ? " Pick the NetSuite internal ID column to continue." : ""}
            </div>
          )}
        </details>
      )}

      {error && <div className="login-error" style={{ marginBottom: 8 }}>{error}</div>}
      {!data && !error && <div className="spinner-inline">Loading…</div>}
      {s && (
        <>
          <div className="field-help" style={{ marginBottom: 8 }}>
            Latest preview from {new Date(data.run.created_at).toLocaleString()}{data.run.created_by ? ` by ${data.run.created_by}` : ""}.
          </div>
          <div className="kv-grid" style={{ marginBottom: 12 }}>
            <div className="kv"><span className="kv-label">Customers in file</span><span className="kv-value">{s.netsuite_customers}</span></div>
            <div className="kv"><span className="kv-label">Already linked</span><span className="kv-value">{s.already_linked}</span></div>
            <div className="kv"><span className="kv-label">Link by Procore project</span><span className="kv-value">{s.link_by_procore_id}</span></div>
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
