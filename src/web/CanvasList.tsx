import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { CanvasListItem } from "../shared/canvas.js";
import { api } from "./api.js";
import { Link, useNavigate } from "react-router-dom";

type CanvasTab = "mine" | "shared";
const tabs = [{ id: "mine", label: "My canvases" }, { id: "shared", label: "Org shared" }] as const;

export function CanvasList({ authenticated, userId }: { authenticated: boolean; userId: string | undefined }) {
  const navigate = useNavigate();
  const [canvases, setCanvases] = useState<CanvasListItem[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<CanvasTab>("mine");
  const [search, setSearch] = useState("");
  const id = useId();
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    let active = true;
    api.list().then(items => { if (active) setCanvases(items); })
      .catch((error: Error) => { if (active) setError(error.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function create(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError("");
    try {
      const canvas = await api.create(title.trim());
      void navigate(`/canvases/${canvas.id}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not create canvas");
      setCreating(false);
    }
  }

  const groups = {
    mine: canvases.filter(canvas => canvas.creatorUserId === userId),
    shared: canvases.filter(canvas => canvas.visibility === "organization"),
  };
  const query = search.trim().toLowerCase();
  const visible = groups[tab].filter(canvas => canvas.title.toLowerCase().includes(query));

  return <main className="canvas-list">
    <p className="eyebrow">EXCALIBUR{!authenticated && " · LOCAL DEVELOPMENT"}</p>
    <h1>Canvases</h1>
    <p className="muted">A persistent space to think, sketch, and connect ideas.</p>
    <form onSubmit={event => { void create(event); }} className="create-form">
      <label htmlFor={`${id}-title`}>Canvas name</label>
      <div className="create-row">
        <input id={`${id}-title`} value={title} onChange={event => setTitle(event.target.value)}
          placeholder="What are you working on?" maxLength={200} required disabled={creating} />
        <button disabled={creating || !title.trim()}>{creating ? "Creating…" : "Create canvas"}</button>
      </div>
    </form>
    <div className="canvas-list-controls">
      <div className="canvas-tabs" role="tablist" aria-label="Canvas groups">
        {tabs.map((item, index) => <button key={item.id} type="button" role="tab" id={`${id}-${item.id}`} aria-selected={tab === item.id}
          aria-label={loading ? item.label : `${item.label} (${groups[item.id].length})`}
          aria-controls={`${id}-panel`} tabIndex={tab === item.id ? 0 : -1} ref={element => { tabButtons.current[index] = element; }}
          onClick={() => setTab(item.id)} onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
              : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
            setTab(tabs[next]!.id);
            tabButtons.current[next]?.focus();
          }}>
          {item.label}{!loading && <span className="canvas-tab-count" aria-hidden="true">{groups[item.id].length}</span>}
        </button>)}
      </div>
      <label className="canvas-search"><span className="sr-only">Search canvases</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>
        <input type="search" placeholder="Search by name…" value={search} onChange={event => setSearch(event.target.value)} />
      </label>
    </div>
    {error && <p role="alert" className="error">{error} <a href="/">Reload</a></p>}
    <section role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`} tabIndex={0} aria-busy={loading}>
      {loading ? <p role="status">Loading canvases…</p> : <>
        {!error && <p className="canvas-results" role="status">{visible.length} {visible.length === 1 ? "canvas" : "canvases"}{query && " found"}</p>}
        <ul className="canvas-grid">
          {visible.map(canvas => <li key={canvas.id}>
            <Link to={`/canvases/${canvas.id}`} className="canvas-card">
              <h2>{canvas.title}</h2>
              <p className="canvas-owner">Owner: <span>{canvas.ownerName ?? "Unavailable"}</span></p>
              <p className="muted">{canvas.visibility === "organization" ? "Organization" : "Private"} · Updated {new Date(canvas.updatedAt).toLocaleString()}</p>
            </Link>
          </li>)}
        </ul>
        {!error && visible.length === 0 && <div className="empty">
          {query ? <><p>No canvases match “{search.trim()}”.</p><button className="secondary" onClick={() => setSearch("")}>Clear search</button></>
            : <p>{tab === "mine" ? "You haven't created any canvases in this organization yet. Create your first one above." : "No canvases are shared with this organization yet."}</p>}
        </div>}
      </>}
    </section>
    {!authenticated && <p className="local-notice">Authentication is disabled. All local sessions share one development identity.</p>}
  </main>;
}
