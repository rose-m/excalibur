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
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    configureApi(() => ({ token: token.current ?? "" }));
    api.me().then(principal => {
      if (!active) return;
      setOrganizations(principal.organizations);
    }).catch((error: Error) => { if (active) setError(error.message); });
    return () => { active = false; configureApi(); };
  }, [auth.user?.userId]);

  return <div className="authenticated-app">
    <header className="auth-header">
      <span>{auth.user?.email}</span>
      {organizations?.length === 1 && <span>{organizations[0]!.name}</span>}
      <button onClick={() => {
        if (window.confirm("Sign out? Export any unsaved drawing before continuing.")) void logout(true);
      }}>Sign out</button>
    </header>
    {error ? <main className="canvas-list" role="alert">{error} <a href="/">Try again</a></main> :
      !organizations ? <main className="canvas-list" role="status">Loading your account…</main> :
      organizations.length === 0 ? <main className="canvas-list"><h1>No organization access</h1><p>Ask your administrator for an organization invitation.</p></main> :
      organizations.length > 1 ? <main className="canvas-list" role="alert"><h1>Account configuration required</h1><p>Your account must belong to exactly one organization. Contact your administrator.</p></main> :
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
