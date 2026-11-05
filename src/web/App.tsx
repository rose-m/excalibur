import { lazy, Suspense, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { CanvasDocument, CanvasMetadata } from "../shared/canvas.js";
import { api } from "./api.js";
import { NavBar } from "./NavBar.js";

const Editor = lazy(() => import("./Editor.js"));

function CanvasList({ authenticated }: { authenticated: boolean }) {
  const [canvases, setCanvases] = useState<CanvasMetadata[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let active = true;
    api.list().then((items) => { if (active) setCanvases(items); })
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
      window.location.assign(`/canvases/${canvas.id}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not create canvas");
      setCreating(false);
    }
  }

  return <main className="canvas-list">
    <p className="eyebrow">EXCALIBUR{!authenticated && " · LOCAL DEVELOPMENT"}</p>
    <h1>Your canvases</h1>
    <p className="muted">A persistent space to think, sketch, and connect ideas.</p>
    <form onSubmit={(event) => { void create(event); }} className="create-form">
      <label htmlFor="canvas-title">Canvas name</label>
      <div className="create-row">
        <input id="canvas-title" value={title} onChange={(event) => setTitle(event.target.value)}
          placeholder="What are you working on?" maxLength={200} required disabled={creating} />
        <button disabled={creating || !title.trim()}>{creating ? "Creating…" : "Create canvas"}</button>
      </div>
    </form>
    {error && <p role="alert" className="error">{error} <a href="/">Reload</a></p>}
    {loading ? <p role="status">Loading canvases…</p> :
      <ul className="canvas-grid">
        {canvases.map((canvas) => <li key={canvas.id}>
          <a href={`/canvases/${canvas.id}`} className="canvas-card">
            <h2>{canvas.title}</h2>
            <p className="muted">Private · Updated {new Date(canvas.updatedAt).toLocaleString()}</p>
          </a>
        </li>)}
      </ul>}
    {!loading && !error && canvases.length === 0 && <p className="empty">No canvases yet. Create your first one above.</p>}
    {!authenticated && <p className="local-notice">Authentication is disabled. All local sessions share one development identity.</p>}
  </main>;
}

function CanvasPage({ id, authenticated, accountControls }: { id: string; authenticated: boolean; accountControls?: ReactNode }) {
  const [canvas, setCanvas] = useState<CanvasDocument>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api.get(id).then((canvas) => { if (active) setCanvas(canvas); })
      .catch((error: Error) => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [id]);
  const loading = <><NavBar accountControls={accountControls} /><main className="canvas-list" role="status">Loading canvas…</main></>;
  if (error) return <><NavBar accountControls={accountControls} /><main className="canvas-list"><p role="alert" className="error">{error}</p></main></>;
  if (!canvas) return loading;
  return <Suspense fallback={loading}>
    <Editor key={canvas.id} canvas={canvas} authenticated={authenticated} accountControls={accountControls} />
  </Suspense>;
}

export function App({ authenticated = false, accountControls }: { authenticated?: boolean; accountControls?: ReactNode }) {
  const path = window.location.pathname;
  const match = /^\/canvases\/([a-f0-9-]{36})$/.exec(path);
  return <div className="app-shell">
    {match ? <CanvasPage id={match[1]!} authenticated={authenticated} accountControls={accountControls} /> : <>
      <NavBar accountControls={accountControls} />
      {path === "/" ? <CanvasList authenticated={authenticated} /> : <main className="canvas-list"><h1>Page not found</h1><a href="/">Back to canvases</a></main>}
    </>}
  </div>;
}
