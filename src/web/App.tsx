import { lazy, Suspense, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { CanvasDocument } from "../shared/canvas.js";
import { api } from "./api.js";
import { NavBar } from "./NavBar.js";
import { CanvasList } from "./CanvasList.js";
import { Link, useLocation } from "react-router-dom";

const Editor = lazy(() => import("./Editor.js"));

function CanvasPage({ id, authenticated, accountControls, userId }: { id: string; authenticated: boolean; accountControls?: ReactNode; userId: string | undefined }) {
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
    <Editor key={canvas.id} canvas={canvas} authenticated={authenticated} accountControls={accountControls} userId={userId} />
  </Suspense>;
}

export function App({ authenticated = false, accountControls, userId }: { authenticated?: boolean; accountControls?: ReactNode; userId?: string | undefined }) {
  const path = useLocation().pathname;
  const match = /^\/canvases\/([a-f0-9-]{36})$/.exec(path);
  const currentUserId = userId ?? (!authenticated ? "development-user" : undefined);
  return <div className="app-shell">
    {match ? <CanvasPage key={match[1]} id={match[1]!} authenticated={authenticated} accountControls={accountControls} userId={currentUserId} /> : <>
      <NavBar accountControls={accountControls} />
      {path === "/" ? <CanvasList authenticated={authenticated} userId={currentUserId} /> : <main className="canvas-list"><h1>Page not found</h1><Link to="/">Back to canvases</Link></main>}
    </>}
  </div>;
}
