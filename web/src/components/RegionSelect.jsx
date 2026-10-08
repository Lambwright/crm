import { useEffect, useState } from "react";
import { api } from "../api.js";

// The one way to pick a region anywhere in CRM (Ben, 2026-10-07): a dropdown of
// Procore's project regions, never free text. The list is fetched once and
// shared. A saved value that isn't on the list (old free text) is shown as
// "(not on list) …" so it's visible and can be replaced, but can't be re-picked.
let cache = null;
function useRegions() {
  const [state, setState] = useState(cache);
  useEffect(() => {
    if (cache) return;
    let live = true;
    api.listRegions().then((d) => { cache = d; if (live) setState(d); }).catch(() => live && setState({ regions: [], note: "Couldn't load the region list." }));
    return () => { live = false; };
  }, []);
  return state;
}

export default function RegionSelect({ value, onChange, disabled, allowEmpty = true, emptyLabel = "— no region —" }) {
  const data = useRegions();
  if (!data) return <span className="spinner-inline">Loading…</span>;
  const names = data.regions.map((r) => r.name);
  const stray = value && !names.includes(value);
  return (
    <>
      <select value={value || ""} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
        {allowEmpty && <option value="">{emptyLabel}</option>}
        {stray && <option value={value} disabled>(not on list) {value}</option>}
        {data.regions.map((r) => <option key={r.id} value={r.name}>{r.name}</option>)}
      </select>
      {data.regions.length === 0 && <div className="field-help">Region list not connected yet{data.note ? ` — ${data.note}` : ""}.</div>}
    </>
  );
}
