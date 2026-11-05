import { RedirectToLogin, RequiredAuthProvider, useAuthInfo, useLogoutFunction } from "@propelauth/react";
import { useEffect, useRef, useState } from "react";
import { App } from "./App.js";
import { api, configureApi } from "./api.js";

type AuthConfig = { mode: "development" } | { mode: "propelauth"; authUrl: string };

function SignedInApp() {
  const auth = useAuthInfo();
  const logout = useLogoutFunction();
  const token = useRef(auth.accessToken);
  token.current = auth.accessToken;
  const [organizations, setOrganizations] = useState<{ id: string; name: string }[]>();
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const organization = useRef(selected);
  organization.current = selected;
  useEffect(() => {
    let active = true;
    configureApi(() => ({ token: token.current ?? "", organizationId: organization.current }));
    api.me().then(principal => {
      if (!active) return;
      setOrganizations(principal.organizations);
      const saved = localStorage.getItem(`excalibur:org:${principal.userId}`);
      setSelected(principal.organizations.find(org => org.id === saved)?.id ?? principal.organizations[0]?.id ?? "");
    }).catch((error: Error) => { if (active) setError(error.message); });
    return () => { active = false; configureApi(); };
  }, [auth.user?.userId]);

  function select(id: string) {
    // A full navigation uses the editor's beforeunload protection for unsaved edits.
    if (!window.confirm("Switch organization? Export any unsaved drawing before continuing.")) return;
    localStorage.setItem(`excalibur:org:${auth.user!.userId}`, id);
    window.location.assign("/");
  }

  return <div className="authenticated-app">
    <header className="auth-header">
      <span>{auth.user?.email}</span>
      {organizations && organizations.length > 0 && <label>Organization <select value={selected} onChange={event => select(event.target.value)}>
        {organizations.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}
      </select></label>}
      <button onClick={() => {
        if (window.confirm("Sign out? Export any unsaved drawing before continuing.")) void logout(true);
      }}>Sign out</button>
    </header>
    {error ? <main className="canvas-list" role="alert">{error} <a href="/">Try again</a></main> :
      !organizations ? <main className="canvas-list" role="status">Loading your account…</main> :
      organizations.length === 0 ? <main className="canvas-list"><h1>No organization access</h1><p>Ask your administrator for an organization invitation.</p></main> :
      <App authenticated />}
  </div>;
}

export function Auth() {
  const [config, setConfig] = useState<AuthConfig>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    fetch("/api/auth/config").then(async response => {
      if (!response.ok) throw new Error("Could not load authentication configuration");
      const value = await response.json() as AuthConfig;
      if (value.mode !== "development" && !(value.mode === "propelauth" && value.authUrl)) throw new Error("Invalid authentication configuration");
      if (active) setConfig(value);
    }).catch((error: Error) => { if (active) setError(error.message); });
    return () => { active = false; };
  }, []);
  if (error) return <main className="canvas-list" role="alert">{error} <a href="/">Try again</a></main>;
  if (!config) return <main className="canvas-list" role="status">Loading…</main>;
  if (config.mode === "development") return <App />;
  return <RequiredAuthProvider authUrl={config.authUrl} displayWhileLoading={<main className="canvas-list">Signing in…</main>}
    displayIfLoggedOut={<RedirectToLogin postLoginRedirectUrl={window.location.href} />}>
    <SignedInApp />
  </RequiredAuthProvider>;
}
