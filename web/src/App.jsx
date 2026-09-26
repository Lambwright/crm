import { useCallback, useEffect, useState } from "react";
import { getStoredToken, verify, logout as doLogout } from "./auth.js";
import { api } from "./api.js";
import Header from "./components/Header.jsx";
import LoginScreen from "./components/LoginScreen.jsx";
import BidBoard from "./components/BidBoard.jsx";
import CompanyList from "./components/CompanyList.jsx";
import Dashboard from "./components/Dashboard.jsx";
import Followups from "./components/Followups.jsx";

// CRM has no "PM" role of its own (that's a HANDOFF/PUNCH-side distinction —
// see HANDOFF's users table) — this is purely a tab-ORDER nicety for people
// who open CRM mainly to work their follow-up list, not an access gate.
// TODO(ben): fill in the real Einbau usernames of the PMs who'll use this tab.
const PM_USERNAMES = [];

const BASE_TABS = [
  { key: "dashboard", label: "Dashboard" },
  { key: "pipeline", label: "Pipeline" },
  { key: "followups", label: "Follow-ups" },
  { key: "companies", label: "Companies" },
];

function tabsFor(username) {
  if (!PM_USERNAMES.includes(username)) return BASE_TABS;
  // For a PM, Follow-ups leads — everything else keeps its relative order.
  const followups = BASE_TABS.find((t) => t.key === "followups");
  return [followups, ...BASE_TABS.filter((t) => t.key !== "followups")];
}

export default function App() {
  const [authState, setAuthState] = useState("checking"); // checking | out | in
  const [user, setUser] = useState(null);
  const [tab, setTab] = useState("dashboard");
  const [notificationCount, setNotificationCount] = useState(0);
  const [followupCount, setFollowupCount] = useState(0);

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
          {tabsFor(user.username).map((t) => (
            <button key={t.key} className={`tab ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>
              {t.label}
              {t.key === "pipeline" && notificationCount > 0 && <span className="tab-count">({notificationCount})</span>}
              {t.key === "followups" && followupCount > 0 && <span className="tab-count">({followupCount})</span>}
            </button>
          ))}
        </div>
        {tab === "pipeline" && <BidBoard user={user} onNotificationsChanged={refreshNotificationCount} />}
        {tab === "followups" && <Followups user={user} onNotificationsChanged={refreshNotificationCount} />}
        {tab === "companies" && <CompanyList />}
        {tab === "dashboard" && <Dashboard />}
      </div>
    </>
  );
}
