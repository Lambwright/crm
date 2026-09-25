import { useEffect, useRef, useState } from "react";

// Same suite switcher every other app carries. CRM isn't wired into the other
// apps' own switchers yet — that's a small addition to make in each sibling
// app's Header.jsx once this one is actually deployed, not done here.
function appLinks() {
  return [
    { name: "PUNCH", url: "https://lambwright.github.io/PUNCH/" },
    { name: "SCOUT", url: "https://lambwright.github.io/scout-addin/app.html" },
    { name: "INTAKE", url: "https://lambwright.github.io/scout-intake/" },
    { name: "TALLY", url: "https://lambwright.github.io/tally/" },
    { name: "HANDOFF", url: "https://lambwright.github.io/handoff/" },
    { name: "LEDGER", url: "https://lambwright.github.io/ledger/" },
    { name: "HELM", url: "https://lambwright.github.io/helm/" },
    { name: "CRM", url: "https://lambwright.github.io/crm/", current: true },
  ];
}

export default function Header({ user, onLogout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);

  return (
    <div className="header">
      <div className="header-badge app-switcher" ref={ref}>
        <span
          className="header-badge-name"
          style={{ cursor: "pointer" }}
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        >
          CRM<span className="app-switcher-caret">▾</span>
        </span>
        <span className="header-badge-sub">Einbau Customer &amp; Bid Pipeline</span>
        <span className="header-brand-tag">An Einbau Product</span>
        {open && (
          <div className="app-switcher-menu">
            {appLinks().map((app) => (
              <a className={`app-switcher-item${app.current ? " current" : ""}`} href={app.url} key={app.name}>
                {app.name}
              </a>
            ))}
          </div>
        )}
      </div>
      {user && (
        <div className="header-user">
          <span className="header-username">{user.displayName || user.username}</span>
          <button className="btn btn-ghost btn-sm" onClick={onLogout}>Log out</button>
        </div>
      )}
    </div>
  );
}
