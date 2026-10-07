import { useCallback, useEffect, useState } from "react";
import { getStoredToken, verify, logout as doLogout } from "./auth.js";
import { api } from "./api.js";
import Header from "./components/Header.jsx";
import LoginScreen from "./components/LoginScreen.jsx";
import BidBoard from "./components/BidBoard.jsx";
import CompanyList from "./components/CompanyList.jsx";
import Dashboard from "./components/Dashboard.jsx";
import Followups from "./components/Followups.jsx";

// "PM" here is CRM's assignable-users list (HELM → CRM Options), not a real
// role — anyone on it gets Follow-ups first in the nav, since they're the
// ones actually expected to work that list day to day.
const BASE_TABS = [
  { key: "dashboard", label: "Dashboard" },
  { key: "pipeline", label: "Pipeline" },
  { key: "followups", label: "Follow-ups" },
  { key: "companies", label: "Companies" },
];

// Who gets Follow-ups first. Live (role matrix): the people who actually work
// follow-ups — estimators and PMs; admins keep the default order. Legacy (CRM
// not switched yet): unchanged — anyone on the HELM assignable-users list.
function tabsFor(username, access, assignableUsernames) {
  const leadsWithFollowups = access && access.mode === "live"
    ? access.level === "estimator" || access.level === "pm"
    : (assignableUsernames || []).some((u) => u.username === username);
  if (!leadsWithFollowups) return BASE_TABS;
  const followups = BASE_TABS.find((t) => t.key === "followups");
  return [followups, ...BASE_TABS.filter((t) => t.key !== "followups")];
}

export default function App() {
  const [authState, setAuthState] = useState("checking"); // checking | out | in
  const [user, setUser] = useState(null);
  const [loginNotice, setLoginNotice] = useState(null);
  const [tab, setTab] = useState("dashboard");
  const [notificationCount, setNotificationCount] = useState(0);
  const [followupCount, setFollowupCount] = useState(0);
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
    api.listNotifications("pending").then((data) => setNotificationCount((data.notifications || []).length)).catch(() => {});
    api.listFollowups(true).then((data) => setFollowupCount((data.bids || []).length)).catch(() => {});
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
  const assignableUsers = access && access.mode === "live"
    ? access.people || []
    : settings?.assignableUsernames || [];

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
          {tabsFor(user.username, access, settings?.assignableUsernames).map((t) => (
            <button key={t.key} className={`tab ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>
              {t.label}
              {t.key === "pipeline" && notificationCount > 0 && <span className="tab-count">({notificationCount})</span>}
              {t.key === "followups" && followupCount > 0 && <span className="tab-count">({followupCount})</span>}
            </button>
          ))}
        </div>
        {tab === "pipeline" && <BidBoard user={user} access={access} assignableUsers={assignableUsers} onNotificationsChanged={refreshNotificationCount} />}
        {tab === "followups" && <Followups user={user} access={access} assignableUsers={assignableUsers} onNotificationsChanged={refreshNotificationCount} />}
        {tab === "companies" && <CompanyList access={access} />}
        {tab === "dashboard" && <Dashboard />}
        {tab === "access" && <Access />}
      </div>
    </>
  );
}
