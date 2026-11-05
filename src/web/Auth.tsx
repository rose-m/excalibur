import { RedirectToLogin, RequiredAuthProvider, useAuthInfo, useLogoutFunction } from "@propelauth/react";
import { useEffect, useRef, useState } from "react";
import { App } from "./App.js";
import { api, configureApi } from "./api.js";
import { organizationStorageKey, organizationUrl, selectOrganization } from "./organizations.js";
import type { Organization } from "./organizations.js";

type AuthConfig = { mode: "development" } | { mode: "propelauth"; authUrl: string };

function SignedInApp() {
  const auth = useAuthInfo();
  const logout = useLogoutFunction();
  const token = useRef(auth.accessToken);
  token.current = auth.accessToken;
  const organization = useRef<string>();
  const [account, setAccount] = useState<{ organizations: Organization[]; organizationId: string | undefined }>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    organization.current = undefined;
    setAccount(undefined);
    setError("");
    configureApi(() => ({ token: token.current ?? "", organizationId: organization.current }));
    api.me().then(principal => {
      if (!active) return;
      const url = new URL(window.location.href);
      const requested = url.searchParams.get("organization");
      const key = organizationStorageKey(principal.userId);
      let remembered: string | null = null;
      try { remembered = window.sessionStorage.getItem(key); } catch { /* Storage can be disabled. */ }
      const organizationId = selectOrganization(principal.organizations, requested, remembered);
      try {
        if (organizationId) window.sessionStorage.setItem(key, organizationId);
        else window.sessionStorage.removeItem(key);
      } catch { /* The current page still works without storage. */ }
      url.searchParams.delete("organization");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      organization.current = organizationId;
      setAccount({ organizations: principal.organizations, organizationId });
    }).catch((error: Error) => { if (active) setError(error.message); });
    return () => { active = false; configureApi(); };
  }, [auth.user?.userId]);

  return <div className="authenticated-app">
    <header className="auth-header">
      <span>{auth.user?.email}</span>
      {account?.organizationId && <label>Organization <select aria-label="Organization" value={account.organizationId} onChange={event => {
        // Navigate before changing credentials or storage. If the editor's unsaved
        // changes prompt is cancelled, the existing workspace remains untouched.
        window.location.assign(organizationUrl(event.target.value));
      }}>
        {account.organizations.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}
      </select></label>}
      <button onClick={() => {
        if (window.confirm("Sign out? Export any unsaved drawing before continuing.")) void logout(true);
      }}>Sign out</button>
    </header>
    {error ? <main className="canvas-list" role="alert">{error} <a href="/">Try again</a></main> :
      !account ? <main className="canvas-list" role="status">Loading your account…</main> :
      account.organizations.length === 0 ? <main className="canvas-list"><h1>No organization access</h1><p>Ask your administrator for an organization invitation.</p></main> :
      !account.organizationId ? <main className="canvas-list"><h1>Select an organization</h1><p>Choose the workspace you want to open.</p>
        <ul>{account.organizations.map(org => <li key={org.id}><a href={organizationUrl(org.id, window.location.pathname)}>{org.name}</a></li>)}</ul>
      </main> : <App key={`${auth.user?.userId}:${account.organizationId}`} authenticated />}
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
