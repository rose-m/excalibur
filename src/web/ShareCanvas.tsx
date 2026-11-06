import { useEffect, useRef, useState } from "react";
import type { CanvasMetadata } from "../shared/canvas.js";
import { api, ApiError } from "./api.js";

export function ShareCanvas({ canvas, canManage, onUpdate, open, onClose, onSavingChange }: {
  canvas: CanvasMetadata;
  canManage: boolean;
  onUpdate: (metadata: CanvasMetadata) => void;
  open: boolean;
  onClose: () => void;
  onSavingChange?: (saving: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const expected = useRef(canvas.visibility);
  const [visibility, setVisibility] = useState(canvas.visibility);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const selectedVisibility = canManage ? visibility : canvas.visibility;
  const url = new URL(`/canvases/${canvas.id}`, window.location.origin).href;

  useEffect(() => { onSavingChange?.(saving); }, [saving, onSavingChange]);

  useEffect(() => {
    const modal = dialog.current;
    if (!modal) return;
    if (open && !modal.open) {
      expected.current = canvas.visibility;
      setVisibility(canvas.visibility);
      setError("");
      setCopyStatus("");
      modal.showModal();
    } else if (!open && modal.open) modal.close();
  }, [open, canvas.visibility]);

  async function save() {
    setSaving(true);
    setError("");
    try {
      onUpdate(await api.setVisibility(canvas.id, visibility, expected.current));
      dialog.current?.close();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        try {
          const latest = await api.get(canvas.id);
          onUpdate(latest);
          expected.current = latest.visibility;
          setVisibility(latest.visibility);
        } catch { /* Keep the original error; never retry a permission change automatically. */ }
      }
      setError(error instanceof Error ? error.message : "Could not update sharing");
    } finally { setSaving(false); }
  }

  return <dialog ref={dialog} className="share-dialog" aria-labelledby="share-title" onClose={onClose}>
      <div className="share-dialog-heading"><h2 id="share-title">Share canvas</h2><form method="dialog"><button className="share-close" aria-label="Close sharing">×</button></form></div>
      <p className="share-canvas-title">{canvas.title}</p>
      <fieldset disabled={!canManage || saving}>
        <legend>Who can access this canvas?</legend>
        <label className="share-option"><input type="radio" name="visibility" value="private" checked={selectedVisibility === "private"} onChange={() => setVisibility("private")} />
          <span><strong>Private</strong><span>Only the creator can view and edit.</span></span>
        </label>
        <label className="share-option"><input type="radio" name="visibility" value="organization" checked={selectedVisibility === "organization"} onChange={() => setVisibility("organization")} />
          <span><strong>Organization</strong><span>All current members of this organization can view and edit.</span></span>
        </label>
      </fieldset>
      {!canManage && <p className="share-notice">Only the creator can change sharing.</p>}
      {canManage && visibility === "private" && canvas.visibility === "organization" && <p className="share-notice">New requests and reconnects will be blocked for other members. Already-open live connections may keep receiving updates until they disconnect.</p>}
      <div className="share-link"><label htmlFor="canvas-share-url">Canvas link</label><div>
        <input id="canvas-share-url" readOnly value={url} onFocus={event => event.target.select()} />
        <button className="secondary" onClick={() => {
          void (async () => {
            try { await navigator.clipboard.writeText(url); setCopyStatus("Link copied"); }
            catch { setCopyStatus("Select and copy the link above."); }
          })();
        }}>Copy link</button>
      </div><p>Links do not grant access. Members must sign in to the same organization.</p><span role="status">{copyStatus}</span></div>
      {error && <p role="alert" className="error">{error}</p>}
      {canManage && <div className="share-dialog-actions"><button disabled={saving || visibility === canvas.visibility} onClick={() => { void save(); }}>{saving ? "Saving…" : "Save sharing"}</button></div>}
    </dialog>;
}
