import { useCallback, useEffect, useState } from "react";
import { getStoredToken, verify, logout as doLogout } from "./auth.js";
import { api } from "./api.js";
import Header from "./components/Header.jsx";
import LoginScreen from "./components/LoginScreen.jsx";
import BidBoard from "./components/BidBoard.jsx";
import CompanyList from "./components/CompanyList.jsx";
import Dashboard from "./components/Dashboard.jsx";

const TABS = [
  { key: "pipeline", label: "Pipeline" },
  { key: "companies", label: "Companies" },
  { key: "dashboard", label: "Dashboard" },
];

export default function App() {
  const [authState, setAuthState] = useState("checking"); // checking | out | in
  const [user, setUser] = useState(null);
  const [tab, setTab] = useState("pipeline");
  const [notificationCount, setNotificationCount] = useState(0);

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
          {TABS.map((t) => (
            <button key={t.key} className={`tab ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>
              {t.label}
              {t.key === "pipeline" && notificationCount > 0 && <span className="tab-count">({notificationCount})</span>}
            </button>
          ))}
        </div>
        {tab === "pipeline" && <BidBoard user={user} onNotificationsChanged={refreshNotificationCount} />}
        {tab === "companies" && <CompanyList />}
        {tab === "dashboard" && <Dashboard />}
      </div>
    </>
  );
}
