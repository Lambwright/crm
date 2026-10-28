import { busyText } from "../festive.js";
import { useState } from "react";
import { api } from "../api.js";
import { parseCsv } from "../csv.js";

// Admin: bring SCOUT's earlier history into CRM from a normalized CSV (the Excel
// log and the earlier scoring sheet). Safe to run again: rows already imported are
// skipped. Preview first.
const NEEDED = ["source", "ext_id", "run_at", "client"];

export default function ScoutImport({ onImported }) {
  const [rows, setRows] = useState(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null); setPreview(null); setDone(null);
    const table = parseCsv(await file.text());
    const header = (table[0] || []).map((h) => h.trim().toLowerCase());
    const missing = NEEDED.filter((n) => !header.includes(n));
    if (table.length < 2 || missing.length) { setError(`That doesn't look like the SCOUT history file (missing: ${missing.join(", ") || "rows"}).`); return; }
    setFileName(file.name);
    setRows(table.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()]))));
  }

  async function run(label, fn) {
    setBusy(label); setError(null);
    try { await fn(); } catch (e) { setError(e.data?.detail || e.message); } finally { setBusy(null); }
  }

  const doPreview = () => run("preview", async () => {
    // Previews in slices (the server accepts up to 600 rows at a time) and adds them up.
    const total = { rows: 0, new: 0, already_imported: 0, company_in_crm: 0, company_not_in_crm: 0, invalid: 0 };
    for (let i = 0; i < rows.length; i += 400) {
      const r = await api.previewScoutImport(rows.slice(i, i + 400));
      for (const k of Object.keys(total)) total[k] += r.summary[k] || 0;
    }
    setDone(null);
    setPreview(total);
  });

  const doApply = () => run("apply", async () => {
    let added = 0;
    for (let i = 0; i < rows.length; i += 400) {
      const r = await api.applyScoutImport(rows.slice(i, i + 400));
      added += r.summary.new;
    }
    setDone(`Imported ${added} scoring runs.`);
    setPreview(null);
    onImported?.();
  });

  return (
    <details className="card" style={{ background: "var(--bg-page)" }}>
      <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Import SCOUT history (admin)</summary>
      <div style={{ marginTop: 10 }}>
        <p className="field-help" style={{ marginBottom: 10, maxWidth: 720 }}>
          Upload the prepared history file (the Excel log plus the earlier scoring sheet, test entries removed). New runs are added;
          anything already imported is skipped, so running it twice is harmless. Companies that aren't in CRM are still kept, because
          the counts don't need a company.
        </p>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
          <input type="file" accept=".csv,text/csv" onChange={onFile} />
          {rows && <button className="btn btn-accent btn-sm" disabled={!!busy} onClick={doPreview}>{busy === "preview" ? busyText("Checking…") : `Preview ${rows.length} rows`}</button>}
          {preview && preview.new > 0 && <button className="btn btn-accent btn-sm" disabled={!!busy} onClick={doApply}>{busy === "apply" ? "Importing…" : `Import ${preview.new} new runs`}</button>}
        </div>
        {error && <div className="login-error" style={{ marginBottom: 8 }}>{error}</div>}
        {done && <div className="field-help" style={{ color: "var(--green)" }}>{done}</div>}
        {preview && (
          <div className="kv-grid">
            <div className="kv"><span className="kv-label">Rows in {fileName}</span><span className="kv-value">{preview.rows}</span></div>
            <div className="kv"><span className="kv-label">New</span><span className="kv-value">{preview.new}</span></div>
            <div className="kv"><span className="kv-label">Already imported</span><span className="kv-value">{preview.already_imported}</span></div>
            <div className="kv"><span className="kv-label">Company in CRM</span><span className="kv-value">{preview.company_in_crm}</span></div>
            <div className="kv"><span className="kv-label">Company not in CRM</span><span className="kv-value">{preview.company_not_in_crm}</span></div>
            <div className="kv"><span className="kv-label">Unusable rows</span><span className="kv-value">{preview.invalid}</span></div>
          </div>
        )}
      </div>
    </details>
  );
}
