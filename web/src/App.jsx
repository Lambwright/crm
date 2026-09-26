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

function tabsFor(username, assignableUsernames) {
  if (!(assignableUsernames || []).some((u) => u.username === username)) return BASE_TABS;
  const followups = BASE_TABS.find((t) => t.key === "followups");
  return [followups, ...BASE_TABS.filter((t) => t.key !== "followups")];
}

export default function App() {
  const [authState, setAuthState] = useState("checking"); // checking | out | in
  const [user, setUser] = useState(null);
  const [tab, setTab] = useState("dashboard");
  const [notificationCount, setNotificationCount] = useState(0);
  const [followupCount, setFollowupCount] = useState(0);
  const [settings, setSettings] = useState(null);

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

  if (authState === "checking") {
    return (
      <div className="login-screen">
        <span className="spinner-inline">Checking session…</span>
      </div>
    );
  }
  if (authState === "out") {
    return <LoginScreen onLoggedIn={handleLoggedIn} />;
  }

  return (
    <>
      <Header user={user} onLogout={handleLogout} />
      <div className="container">
        <div className="tabs">
          {tabsFor(user.username, settings?.assignableUsernames).map((t) => (
            <button key={t.key} className={`tab ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>
              {t.label}
              {t.key === "pipeline" && notificationCount > 0 && <span className="tab-count">({notificationCount})</span>}
              {t.key === "followups" && followupCount > 0 && <span className="tab-count">({followupCount})</span>}
            </button>
          ))}
        </div>
        {tab === "pipeline" && <BidBoard user={user} assignableUsers={settings?.assignableUsernames || []} onNotificationsChanged={refreshNotificationCount} />}
        {tab === "followups" && <Followups user={user} assignableUsers={settings?.assignableUsernames || []} onNotificationsChanged={refreshNotificationCount} />}
        {tab === "companies" && <CompanyList />}
        {tab === "dashboard" && <Dashboard />}
      </div>
    </>
  );
}
