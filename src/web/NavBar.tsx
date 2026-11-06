import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export function NavBar({ title, accountControls, children }: { title?: string; accountControls?: ReactNode; children?: ReactNode }) {
  return <header className="app-nav">
    <nav aria-label="Main navigation">
      <Link className="nav-home" to="/" aria-label={title ? "Back to canvases" : "Excalibur home"}>
        {title ? <>← <span>Canvases</span></> : "Excalibur"}
      </Link>
      {title && <h1 title={title}>{title}</h1>}
      <div className="nav-actions">{children}{accountControls}</div>
    </nav>
  </header>;
}
