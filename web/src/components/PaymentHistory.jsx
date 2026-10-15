// Collapsed group on the company record: the payment score and facts exactly as
// netsuite-worker computed and pushed them (Ben, 2026-10-16). CRM never
// recalculates anything here — null stays "not enough history", never 0.
// The reading bands are the same ones SCOUT uses for its Payment record answer.
function band(score) {
  if (score == null) return null;
  if (score >= 7) return { label: "Good", color: "var(--green)" };
  if (score >= 4) return { label: "Average", color: "var(--yellow, #c9a227)" };
  return { label: "Poor", color: "var(--red)" };
}
const num = (v, digits = 1) => (v == null ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: digits }));

export default function PaymentHistory({ payment }) {
  const b = payment ? band(payment.score == null ? null : Number(payment.score)) : null;
  return (
    <details className="card" style={{ background: "var(--bg-page)", marginBottom: 12 }}>
      <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
        Payment history{" "}
        {payment && (
          <span className="row-secondary" style={{ fontWeight: 400 }}>
            {payment.score != null ? <>— <span style={{ color: b.color }}>{b.label}</span> ({num(payment.score)}/10)</> : `— ${payment.status || "no score yet"}`}
          </span>
        )}
      </summary>
      {!payment ? (
        <div className="field-help" style={{ marginTop: 8 }}>No payment data received from NetSuite for this company yet.</div>
      ) : (
        <div style={{ marginTop: 10 }}>
          <div className="kv-grid" style={{ marginBottom: 8 }}>
            <div className="kv"><span className="kv-label">Status</span><span className="kv-value">{payment.status || "—"}</span></div>
            <div className="kv"><span className="kv-label">Score (0–10)</span><span className="kv-value">{payment.score != null ? num(payment.score) : "— (not enough history)"}</span></div>
            <div className="kv"><span className="kv-label">Invoices judged</span><span className="kv-value">{num(payment.judged_invoices, 0)}</span></div>
            <div className="kv"><span className="kv-label">Avg days past terms (18 mo)</span><span className="kv-value">{num(payment.avg_days_past_terms_18m)}</span></div>
            <div className="kv"><span className="kv-label">Avg days past terms (6 mo)</span><span className="kv-value">{num(payment.avg_days_past_terms_6m)}</span></div>
            <div className="kv"><span className="kv-label">Paid late</span><span className="kv-value">{payment.late_pct != null ? `${num(payment.late_pct)}%` : "—"}</span></div>
            <div className="kv"><span className="kv-label">Invoices with credits</span><span className="kv-value">{payment.credit_pct != null ? `${num(payment.credit_pct)}%` : "—"}</span></div>
            <div className="kv"><span className="kv-label">Credit memos per invoice</span><span className="kv-value">{num(payment.credit_memos_per_invoice, 2)}</span></div>
            <div className="kv"><span className="kv-label">Overdue days</span><span className="kv-value">{num(payment.overdue_days, 0)}</span></div>
          </div>
          <div className="field-help">
            Calculated {payment.calc_date || "—"} in NetSuite and received {new Date(payment.received_at).toLocaleDateString()}. Shown as received; CRM does not recalculate it.
          </div>
        </div>
      )}
    </details>
  );
}
