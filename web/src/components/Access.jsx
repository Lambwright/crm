import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";

// Admin-only. The Einbau ID level (admin / estimator / PM) is set in HELM and
// decides the base of what someone can do; this tab adds the two extra
// capabilities on top of it — who manages follow-ups, who manages campaigns.
const CAP_LABELS = {
  followup_manager: {
    label: "Follow-up manager",
    help: "Sees every follow-up, assigns them in bulk, sets the auto-assignment rules and reviews progress.",
  },
  campaign_manager: {
    label: "Campaign manager",
    help: "Imports campaign lists, sees the Campaigns dashboard and works with the copilot.",
  },
};

const LEVEL_HELP = {
  admin: "Everything.",
  estimator: "Pipeline, Companies, stage moves, hot leads, assigning follow-ups.",
  pm: "Dashboard, plus follow-ups on bids assigned to them.",
};

export default function Access() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(null);

  const load = useCallback(() => {
    api.getGrants().then(setData).catch((e) => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function toggle(username, cap, on) {
    const current = data.grants[username] || [];
    const next = on ? [...new Set([...current, cap])] : current.filter((c) => c !== cap);
    setSaving(username);
    try {
      const res = await api.setGrants(username, next);
      setData((d) => ({ ...d, grants: res.grants }));
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(null);
    }
  }

  if (error) return <div className="card" style={{ color: "var(--red)" }}>{error}</div>;
  if (!data) return <div className="spinner-inline">Loading…</div>;

  return (
    <>
      <div className="card-title">Extra permissions</div>
      <p className="field-help" style={{ marginBottom: 12, maxWidth: 720 }}>
        Everyone's base level (Admin, Estimator, PM) comes from Einbau ID in HELM. These checkboxes add a
        capability on top of it. Admins always have both.
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th>Person</th>
            <th>Level (from HELM)</th>
            {Object.entries(CAP_LABELS).map(([k, c]) => <th key={k} title={c.help}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.people.map((p) => {
            const isAdmin = p.level === "admin";
            const caps = data.grants[p.username] || [];
            return (
              <tr key={p.username}>
                <td>{p.displayName || p.username}</td>
                <td title={LEVEL_HELP[p.level] || ""}>{p.level}</td>
                {Object.keys(CAP_LABELS).map((cap) => (
                  <td key={cap}>
                    <input
                      type="checkbox"
                      checked={isAdmin || caps.includes(cap)}
                      disabled={isAdmin || saving === p.username}
                      onChange={(e) => toggle(p.username, cap, e.target.checked)}
                    />
                  </td>
                ))}
              </tr>
            );
          })}
          {data.people.length === 0 && (
            <tr><td colSpan={2 + Object.keys(CAP_LABELS).length} className="empty-state">No one found — people with CRM access in HELM appear here.</td></tr>
          )}
        </tbody>
      </table>
      <div style={{ marginTop: 16 }}>
        <div className="card-title">What each level can do</div>
        {Object.entries(LEVEL_HELP).map(([k, v]) => (
          <div key={k} className="field-help"><strong>{k}</strong> — {v}</div>
        ))}
        {Object.entries(CAP_LABELS).map(([k, c]) => (
          <div key={k} className="field-help"><strong>{c.label}</strong> — {c.help}</div>
        ))}
      </div>
    </>
  );
}
