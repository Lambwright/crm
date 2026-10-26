import { useCallback, useEffect, useState } from "react";
import { getStoredToken, verify, logout as doLogout } from "./auth.js";
import { api } from "./api.js";
import Header from "./components/Header.jsx";
import LoginScreen from "./components/LoginScreen.jsx";
import BidBoard from "./components/BidBoard.jsx";
import CompanyList from "./components/CompanyList.jsx";
import Dashboard from "./components/Dashboard.jsx";
import Followups from "./components/Followups.jsx";
import ScoutStats from "./components/ScoutStats.jsx";
import AdminReview from "./components/AdminReview.jsx";
import FollowupManager from "./components/FollowupManager.jsx";

// "PM" here is CRM's assignable-users list (HELM → CRM Options), not a real
// role — anyone on it gets Follow-ups first in the nav, since they're the
// ones actually expected to work that list day to day.
const BASE_TABS = [
  { key: "dashboard", label: "Dashboard" },
  { key: "pipeline", label: "Pipeline" },
  { key: "followups", label: "Follow-ups" },
  { key: "companies", label: "Companies" },
  { key: "scout", label: "SCOUT" },
];

// A PM sees the Dashboard and the follow-ups assigned to them, nothing else
// (Ben, 2026-10-07). The server enforces all of this; here it only decides which tabs to draw.
function visibleTabs(access) {
  let tabs = BASE_TABS;
  if (access && access.can && access.can.all_bids === false) {
    tabs = tabs.filter((t) => t.key === "dashboard" || t.key === "followups" || t.key === "scout");
  }
  // The follow-up dashboard exists only for admins, estimators and follow-up managers.
  if (access && access.can && access.can.followup_dashboard) tabs = [...tabs, { key: "followupmgr", label: "Follow-up manager" }];
  if (access && access.can && access.can.admin) tabs = [...tabs, { key: "admin", label: "Admin" }];
  return tabs;
}

// Who gets Follow-ups first: the people who actually work follow-ups, estimators and PMs;
// admins keep the default order. Levels come from the role matrix (HELM).
function tabsFor(access) {
  const base = visibleTabs(access);
  const leadsWithFollowups = access && (access.level === "estimator" || access.level === "pm");
  if (!leadsWithFollowups) return base;
  const followups = base.find((t) => t.key === "followups");
  return followups ? [followups, ...base.filter((t) => t.key !== "followups")] : base;
}

export default function App() {
  const [authState, setAuthState] = useState("checking"); // checking | out | in
  const [user, setUser] = useState(null);
  const [loginNotice, setLoginNotice] = useState(null);
  const [tab, setTab] = useState("dashboard");
  // Badges on the Follow-ups and Follow-up manager tabs (the old alert count is gone)
  const [counts, setCounts] = useState(null);
  const [settings, setSettings] = useState(null);
  const [access, setAccess] = useState(null);

  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setAuthState("out");
      return;
    }
    verify(token).then((data) => {
      if (data.valid) {
        setUser(data.user);
        setAuthState("in");
      } else {
        if (data.error === "no_app_access") {
          setLoginNotice("Your account doesn't have access to any apps yet. Ask an admin to grant you access in HELM.");
        }
        setAuthState("out");
      }
    });
  }, []);

  const refreshNotificationCount = useCallback(() => {
    if (authState !== "in") return;
    api.getFollowupCounts().then((c) => setCounts(c)).catch(() => {});
  }, [authState]);

  useEffect(() => {
    refreshNotificationCount();
  }, [refreshNotificationCount]);

  useEffect(() => {
    if (authState !== "in") return;
    api.getSettings().then(setSettings).catch(() => {});
    // If this fails the UI behaves as legacy (everything shown); the server
    // still enforces every privileged action regardless.
    api.getAccess().then(setAccess).catch(() => {});
  }, [authState]);

  function handleLoggedIn(u) {
    setUser(u);
    setAuthState("in");
  }
  function handleLogout() {
    doLogout();
    setUser(null);
    setAuthState("out");
  }

  // Who can be picked as an owner/estimator. Live (role matrix): everyone with
  // CRM access at PM level or above, read from auth-worker via /access.
  // Legacy (CRM not switched yet): the HELM assignable-users list, as before.
  const assignableUsers = access ? access.people || [] : [];

  if (authState === "checking") {
    return (
      <div className="login-screen">
        <span className="spinner-inline">Checking session…</span>
      </div>
    );
  }
  if (authState === "out") {
    return <LoginScreen onLoggedIn={handleLoggedIn} initialError={loginNotice} />;
  }

  return (
    <>
      <Header user={user} onLogout={handleLogout} />
      <div className="container">
        <div className="tabs">
          {tabsFor(access).map((t) => (
            <button key={t.key} className={`tab ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>
              {t.label}
              {t.key === "followups" && counts && counts.mine_due > 0 && <span className="tab-count" style={counts.mine_overdue > 0 ? { color: "var(--red)" } : undefined}>({counts.mine_due})</span>}
              {t.key === "followupmgr" && counts && (counts.unassigned > 0 || counts.all_overdue > 0) && <span className="tab-count" style={{ color: "var(--red)" }}>({counts.unassigned || 0} unassigned · {counts.all_overdue || 0} overdue)</span>}
            </button>
          ))}
        </div>
        {tab === "pipeline" && <BidBoard user={user} access={access} assignableUsers={assignableUsers} onNotificationsChanged={refreshNotificationCount} />}
        {tab === "followups" && <Followups user={user} access={access} assignableUsers={assignableUsers} onNotificationsChanged={refreshNotificationCount} />}
        {tab === "companies" && <CompanyList access={access} />}
        {tab === "dashboard" && <Dashboard />}
        {tab === "scout" && <ScoutStats access={access} />}
        {tab === "followupmgr" && <FollowupManager />}
        {tab === "admin" && <AdminReview />}
      </div>
    </>
  );
}
