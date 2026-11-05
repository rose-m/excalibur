import type { ReactNode } from "react";

export function NavBar({ title, accountControls, children }: { title?: string; accountControls?: ReactNode; children?: ReactNode }) {
  return <header className="app-nav">
    <nav aria-label="Main navigation">
      <a className="nav-home" href="/" aria-label={title ? "Back to canvases" : "Excalibur home"}>
        {title ? <>← <span>Canvases</span></> : "Excalibur"}
      </a>
      {title && <h1 title={title}>{title}</h1>}
      <div className="nav-actions">{children}{accountControls}</div>
    </nav>
  </header>;
}
