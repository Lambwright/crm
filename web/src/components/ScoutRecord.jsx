// SCOUT's complete record for a bid, exactly as SCOUT sent it on its latest
// push (Ben, 2026-10-16: keep all fields; HANDOFF will rely on this too).
// Collapsed by default. Nothing here is recalculated by CRM.
const SECTION_LABELS = { section_1: "Client / GC qualification (of 30)", section_2: "Project fit (of 28)", section_3: "Commercial viability (of 22)", section_4: "Operational capacity (of 20)" };

function Block({ title, children }) {
  if (!children) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="kv-label">{title}</div>
      <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{children}</div>
    </div>
  );
}

export default function ScoutRecord({ run, count }) {
  if (!run) return null;
  const dq = Array.isArray(run.disqualifiers) ? run.disqualifiers : [];
  const labels = run.scoring_labels && typeof run.scoring_labels === "object" ? Object.entries(run.scoring_labels).filter(([, v]) => v) : [];
  const sections = run.section_scores && typeof run.section_scores === "object" ? Object.entries(run.section_scores) : [];
  return (
    <details className="card" style={{ background: "var(--bg-page)", marginBottom: 16 }}>
      <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
        SCOUT record{" "}
        <span className="row-secondary" style={{ fontWeight: 400 }}>
          — {run.tier || "no tier"}{run.total_score != null ? ` · ${Number(run.total_score)}/100` : ""}
          {run.submitted_at ? ` · ${new Date(run.submitted_at).toLocaleDateString()}` : ""}
          {count > 1 ? ` · ${count} pushes` : ""}
        </span>
      </summary>
      <div style={{ marginTop: 10 }}>
        <div className="kv-grid" style={{ marginBottom: 10 }}>
          <div className="kv"><span className="kv-label">Tier</span><span className="kv-value">{run.tier || "—"}</span></div>
          <div className="kv"><span className="kv-label">Total score</span><span className="kv-value">{run.total_score != null ? Number(run.total_score) : "—"}</span></div>
          <div className="kv"><span className="kv-label">Outcome</span><span className="kv-value">{run.outcome || "—"}</span></div>
          <div className="kv"><span className="kv-label">Estimator</span><span className="kv-value">{run.estimator || "—"}</span></div>
          <div className="kv"><span className="kv-label">Override approved by</span><span className="kv-value">{run.override_approver || "—"}</span></div>
        </div>
        {sections.length > 0 && (
          <Block title="Zone scores">
            {sections.map(([k, v]) => `${SECTION_LABELS[k] || k}: ${v}`).join("\n")}
          </Block>
        )}
        {dq.length > 0 && <Block title="Disqualifiers triggered">{dq.join("\n")}</Block>}
        <Block title="Override reason">{run.override_reason}</Block>
        <Block title="Notes">{run.notes}</Block>
        <Block title="Risks">{run.risks}</Block>
        <Block title="Copilot summary">{run.copilot_summary}</Block>
        {labels.length > 0 && (
          <Block title="Answers given">{labels.map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join("\n")}</Block>
        )}
        <div className="field-help">As received from SCOUT {run.received_at ? `on ${new Date(run.received_at).toLocaleString()}` : ""}; CRM keeps every push.</div>
      </div>
    </details>
  );
}
