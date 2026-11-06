import { useEffect, useId, useRef, useState } from "react";
import type { CanvasMetadata } from "../shared/canvas.js";
import { api, ApiError } from "./api.js";
import { ShareCanvas } from "./ShareCanvas.js";

export function CanvasActions({ canvas, canManage, canSave, onSave, onUpdate, onDeleted }: {
  canvas: CanvasMetadata;
  canManage: boolean;
  canSave: boolean;
  onSave: () => void;
  onUpdate: (metadata: CanvasMetadata) => void;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"rename" | "delete" | "share" | null>(null);
  const [name, setName] = useState(canvas.title);
  const [confirmation, setConfirmation] = useState("");
  const [review, setReview] = useState<CanvasMetadata>(canvas);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sharingBusy, setSharingBusy] = useState(false);
  const [error, setError] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const headingId = useId();
  const inputId = useId();
  const focusLast = useRef(false);

  useEffect(() => {
    if (!open) return;
    const items = panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    (focusLast.current ? items?.[items.length - 1] : items?.[0])?.focus();
    const outside = (event: Event) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [open]);

  useEffect(() => {
    if (!mode || mode === "share") return;
    dialog.current?.showModal();
    if (mode === "rename") { nameInput.current?.focus(); nameInput.current?.select(); }
  }, [mode]);

  async function refreshReview() {
    const latest = await api.get(canvas.id);
    setReview(latest);
    onUpdate(latest);
    setLoaded(true);
    setConfirmation("");
  }

  function show(next: "rename" | "delete" | "share") {
    setOpen(false);
    setError("");
    setName(canvas.title);
    setConfirmation("");
    setReview(canvas);
    setLoaded(next === "rename");
    setMode(next);
    if (next === "delete") {
      setBusy(true);
      void refreshReview().catch((error: Error) => setError(error.message)).finally(() => setBusy(false));
    }
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      if (mode === "rename") {
        onUpdate(await api.rename(canvas.id, name.trim(), review.title));
        dialog.current?.close();
      } else if (mode === "delete" && loaded) {
        await api.deleteCanvas(canvas.id, confirmation, review.revision);
        dialog.current?.close();
        onDeleted();
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setLoaded(false);
        try { await refreshReview(); } catch { /* Do not retry a rename or deletion automatically. */ }
      }
      setError(error instanceof Error ? error.message : "Could not update canvas");
    } finally { setBusy(false); }
  }

  return <>
    <div className="canvas-actions" ref={container} onKeyDown={event => {
      if (!open) return;
      if (event.key === "Escape" || event.key === "Tab") {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
        setOpen(false);
        trigger.current?.focus();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        const items = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    }}>
      <button className="secondary canvas-actions-trigger" ref={trigger} aria-label="Canvas actions" title="Canvas actions" disabled={busy || sharingBusy}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        onClick={() => { focusLast.current = false; setOpen(value => !value); }} onKeyDown={event => {
          if (!open && ["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault(); event.stopPropagation(); focusLast.current = event.key === "ArrowUp"; setOpen(true);
          }
        }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
      </button>
      {open && <div className="canvas-actions-popup" ref={panel} id={menuId} role="menu" aria-label="Canvas actions">
        <button role="menuitem" disabled={!canSave} onClick={() => { setOpen(false); trigger.current?.focus(); onSave(); }}>Save now</button>
        <button role="menuitem" onClick={() => show("share")}>Share canvas <span className="canvas-action-hint">{canvas.visibility === "organization" ? "Organization" : "Private"}</span></button>
        {canManage && <>
          <div className="canvas-actions-divider" role="separator" />
          <button role="menuitem" onClick={() => show("rename")}>Rename canvas</button>
          <button className="canvas-delete-item" role="menuitem" onClick={() => show("delete")}>Delete canvas…</button>
        </>}
      </div>}
    </div>
    <ShareCanvas canvas={canvas} canManage={canManage} onUpdate={onUpdate} open={mode === "share"} onSavingChange={setSharingBusy}
      onClose={() => { setMode(null); trigger.current?.focus(); }} />
    <dialog ref={dialog} className="share-dialog canvas-action-dialog" aria-labelledby={headingId} onClose={() => { setMode(null); trigger.current?.focus(); }}>
      <div className="share-dialog-heading"><h2 id={headingId}>{mode === "delete" ? "Delete canvas?" : "Rename canvas"}</h2>
        <form method="dialog"><button className="share-close" aria-label="Close canvas action">×</button></form>
      </div>
      <p className="share-canvas-title">{review.title}</p>
      <form onSubmit={event => { event.preventDefault(); if (!busy && loaded) void submit(); }}>
        {mode === "delete" ? <>
          <p className="canvas-delete-warning">Permanently delete this canvas, all its images and comments, and disconnect everyone editing it. This cannot be undone.</p>
          <p className="share-notice">Any unsaved drawing in this tab will also be discarded. Export anything you want to keep before deleting.</p>
          <label htmlFor={inputId}>Type <strong>{review.title}</strong> to confirm</label>
          <input id={inputId} value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy || !loaded} autoComplete="off" />
        </> : <>
          <label htmlFor={inputId}>Canvas name</label>
          <input id={inputId} ref={nameInput} value={name} onChange={event => setName(event.target.value)} maxLength={200} required disabled={busy} />
        </>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="share-dialog-actions"><button className={mode === "delete" ? "danger" : undefined}
          disabled={busy || !loaded || (mode === "delete" ? confirmation !== review.title : !name.trim() || name.trim() === review.title)}>
          {busy ? "Please wait…" : mode === "delete" ? "Delete permanently" : "Save name"}
        </button></div>
      </form>
    </dialog>
  </>;
}
