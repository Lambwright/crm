import { busyText } from "../festive.js";
import { useState } from "react";
import { api } from "../api.js";
import { parseCsv } from "../csv.js";

// Admin tool (Companies tab): add contacts and fill blank address fields from a
// NetSuite export, one row per contact. The customer import must have run first,
// because companies are found by their NetSuite ID. Preview first; nothing
// changes until Apply. Existing contacts and filled-in address fields are never
// overwritten, so it's safe to run again.
const REQUIRED = ["ns_id"];
const KNOWN = ["ns_id", "company_name", "address1", "address2", "city", "province", "postal_code", "country", "website", "category", "contact_first", "contact_last", "contact_name", "role", "phone", "email", "company_email"];

export default function ContactsImport() {
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
    if (table.length < 2) { setError("That file has no data rows."); return; }
    const header = table[0].map((h) => h.trim().toLowerCase());
    const missing = REQUIRED.filter((r) => !header.includes(r));
    if (missing.length) { setError(`The file needs a column named ${missing.join(", ")}. Columns I understand: ${KNOWN.join(", ")}.`); return; }
    const out = table.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
    setFileName(file.name);
    setRows(out);
  }

  async function run(label, fn) {
    setBusy(label); setError(null);
    try { await fn(); } catch (e) { setError(e.data?.detail || e.message); } finally { setBusy(null); }
  }

  const doPreview = () => run("preview", async () => { setDone(null); setPreview(await api.previewContactsImport(rows)); });

  // Applied in slices that never split a company across two requests.
  const doApply = () => run("apply", async () => {
    const groups = new Map();
    for (const r of rows) { const k = r.ns_id || ""; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    let slice = [], sent = 0;
    const totals = { contacts_to_add: 0, address_updates: 0 };
    const flush = async () => {
      if (!slice.length) return;
      const r = await api.applyContactsImport(slice);
      totals.contacts_to_add += r.summary.contacts_to_add;
      totals.address_updates += r.summary.address_updates;
      sent += slice.length;
      slice = [];
    };
    for (const g of groups.values()) {
      slice.push(...g);
      if (slice.length >= 250) await flush();
    }
    await flush();
    setDone(`Added ${totals.contacts_to_add} contacts and filled addresses on ${totals.address_updates} companies.`);
    setPreview(null);
  });

  const s = preview?.summary;
  return (
    <div style={{ marginBottom: 24 }}>
      <div className="card-title">Import contacts and addresses from NetSuite (CSV)</div>
      <p className="field-help" style={{ marginBottom: 10, maxWidth: 720 }}>
        One row per contact, with the company's NetSuite internal ID in a column named <code>ns_id</code>. Contacts are added to the
        matching company unless it already has that email; blank address fields and the vertical are filled in, and anything already
        filled is left alone. Run the customer import first.
      </p>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <input type="file" accept=".csv,.tsv,.txt,text/csv" onChange={onFile} />
        {rows && <button className="btn btn-accent btn-sm" disabled={!!busy} onClick={doPreview}>{busy === "preview" ? busyText("Checking…") : `Preview ${rows.length} rows`}</button>}
        {s && (s.contacts_to_add > 0 || s.address_updates > 0) && (
          <button className="btn btn-accent btn-sm" disabled={!!busy} onClick={doApply}>
            {busy === "apply" ? "Applying…" : `Apply: add ${s.contacts_to_add} contacts, fill ${s.address_updates} addresses`}
          </button>
        )}
      </div>
      {error && <div className="login-error" style={{ marginBottom: 8 }}>{error}</div>}
      {done && <div className="field-help" style={{ color: "var(--green)", marginBottom: 8 }}>{done}</div>}
      {s && (
        <>
          <div className="field-help" style={{ marginBottom: 8 }}>{fileName}</div>
          <div className="kv-grid" style={{ marginBottom: 12 }}>
            <div className="kv"><span className="kv-label">Rows in file</span><span className="kv-value">{s.rows}</span></div>
            <div className="kv"><span className="kv-label">Companies matched</span><span className="kv-value">{s.companies_matched}</span></div>
            <div className="kv"><span className="kv-label">Contacts to add</span><span className="kv-value">{s.contacts_to_add}</span></div>
            <div className="kv"><span className="kv-label">Already in CRM / repeats</span><span className="kv-value">{s.contacts_already_there}</span></div>
            <div className="kv"><span className="kv-label">Addresses to fill</span><span className="kv-value">{s.address_updates}</span></div>
            <div className="kv"><span className="kv-label">Rows with no contact</span><span className="kv-value">{s.rows_skipped_no_contact}</span></div>
            <div className="kv"><span className="kv-label">Companies not in CRM</span><span className="kv-value">{s.companies_unmatched}</span></div>
          </div>
          {preview.unmatched.length > 0 && (
            <details style={{ marginBottom: 10 }}>
              <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Companies in the file that aren't in CRM yet ({preview.unmatched.length})</summary>
              <div className="field-help" style={{ marginTop: 6 }}>Run the customer import for these first, then preview again. {preview.unmatched.map((u) => `${u.name} (${u.ns_id})`).join("; ")}</div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
