// A label with a hover explanation — the formula in plain language plus the
// actual numbers behind the current figure, so nobody has to take a number on
// faith (Ben, 2026-09-29: "someone off the street should be able to log on
// and, based on the tooltips and info here, understand how we came to these
// numbers"). Pure CSS hover, see .stat-tooltip-* in theme.css.
export default function Tip({ label, children, className = "kv-label" }) {
  return (
    <div className={`${className} stat-tooltip-wrap`}>
      {label}
      <span className="stat-tooltip-icon">?</span>
      <div className="stat-tooltip-popup">{children}</div>
    </div>
  );
}
