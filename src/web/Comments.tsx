import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { sceneCoordsToViewportCoords, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { Scene } from "../shared/canvas.js";
import type { CommentAnchor, CommentState } from "../shared/comments.js";
import { api } from "./api.js";
import { anchorAt, commentPosition, commentTarget } from "./comment-geometry.js";
import { requestId } from "./request-id.js";
import { commentShortcutTarget, isCommentShortcut } from "./comment-shortcut.js";

type Props = { canvasId: string; editor: ExcalidrawImperativeAPI; toolbar: HTMLElement | null; state: CommentState; ready: boolean; onUpdate: (state: CommentState) => void };
type Draft = { id: string; anchor: CommentAnchor; text: string; expectedText?: string };
const isCommentTool = (tool: { type: string; customType?: string | null }) => tool.type === "custom" && tool.customType === "comment";

export default function Comments({ canvasId, editor, toolbar, state, ready, onUpdate }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const pointers = useRef(new Set<number>());
  const gesture = useRef(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState(() => ({ key: "", app: editor.getAppState(), elements: editor.getSceneElementsIncludingDeleted() }));
  const mode = isCommentTool(view.app.activeTool);
  const active = state.comments.find(comment => comment.id === activeId);
  const editing = draft?.expectedText !== undefined;

  useEffect(() => {
    const surface = root.current?.parentElement;
    if (!surface) return;
    const keydown = (event: KeyboardEvent) => {
      if (!ready || pending || pointers.current.size > 0 || !isCommentShortcut(event) || !(event.target instanceof Element)
        || !surface.contains(document.activeElement) || !commentShortcutTarget(event.target)
        || editor.getAppState().editingTextElement) return;
      // Capture before Excalidraw handles its own drawing shortcuts.
      event.preventDefault();
      event.stopPropagation();
      if (draft) { input.current?.focus(); return; }
      setActiveId(null); setError("");
      editor.setActiveTool({ type: "custom", customType: "comment" });
    };
    surface.addEventListener("keydown", keydown, true);
    return () => surface.removeEventListener("keydown", keydown, true);
  }, [editor, ready, pending, draft]);

  useEffect(() => {
    const down = (event: PointerEvent) => {
      if (!pointers.current.size) gesture.current = false;
      pointers.current.add(event.pointerId);
      if (pointers.current.size > 1) gesture.current = true;
    };
    const up = (event: PointerEvent) => { pointers.current.delete(event.pointerId); };
    const clear = () => { pointers.current.clear(); gesture.current = true; };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("blur", clear);
    };
  }, []);

  useEffect(() => {
    const update = () => {
      const app = editor.getAppState(), elements = editor.getSceneElementsIncludingDeleted();
      const targets = new Set(state.comments.flatMap(comment => comment.anchor.type === "element" ? [comment.anchor.elementId] : []));
      if (draft?.anchor.type === "element") targets.add(draft.anchor.elementId);
      const rect = root.current?.getBoundingClientRect();
      const key = JSON.stringify([app.scrollX, app.scrollY, app.zoom.value, app.offsetLeft, app.offsetTop, app.activeTool, rect?.width, rect?.height,
        elements.filter(element => targets.has(element.id)).map(element => [element.id, element.version, element.isDeleted])]);
      setView(old => old.key === key ? old : { key, app: { ...app }, elements });
    };
    update();
    const unsubscribe = editor.onChange(update);
    const observer = new ResizeObserver(update);
    if (root.current) observer.observe(root.current);
    return () => { unsubscribe(); observer.disconnect(); };
  }, [editor, state.comments, draft?.anchor]);

  useEffect(() => editor.onPointerUp((tool, down, event) => {
    if (!ready || !isCommentTool(tool) || event.button !== 0 || !event.isPrimary || gesture.current) return;
    const app = editor.getAppState();
    const point = viewportCoordsToSceneCoords(event, app);
    if (Math.hypot(point.x - down.origin.x, point.y - down.origin.y) * app.zoom.value > 6) return;
    const elements = editor.getSceneElements() as unknown as Scene["elements"];
    const target = commentTarget(point, elements, app.zoom.value);
    setDraft({ id: requestId(), anchor: anchorAt(point, target), text: "" });
    setActiveId(null);
    setError("");
    editor.setActiveTool({ type: "selection" });
  }), [editor, ready]);

  useEffect(() => { if (draft) input.current?.focus(); }, [draft?.id]);
  useEffect(() => {
    if (activeId && state.revision >= 0 && !active && !draft) { setActiveId(null); setError(""); }
  }, [activeId, active, state.revision, draft]);
  useEffect(() => {
    if (!ready && isCommentTool(editor.getAppState().activeTool)) editor.setActiveTool({ type: "selection" });
  }, [ready, editor]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (pending || draft?.text.trim()) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending, draft]);

  const elements = new Map(view.elements.map(element => [element.id, element])) as unknown as ReadonlyMap<string, Scene["elements"][number]>;
  const rect = root.current?.getBoundingClientRect();
  const location = (anchor: CommentAnchor) => {
    const scene = commentPosition(anchor, elements);
    const point = sceneCoordsToViewportCoords({ sceneX: scene.x, sceneY: scene.y }, view.app);
    return { x: point.x - (rect?.left ?? view.app.offsetLeft), y: point.y - (rect?.top ?? view.app.offsetTop) };
  };
  const selected = draft ?? active;
  const at = selected ? location(selected.anchor) : null;
  const close = () => { if (!pending) { setDraft(null); setActiveId(null); setError(""); } };

  async function save() {
    if (!draft || !ready || pending || !draft.text.trim()) return;
    setPending(true); setError("");
    try {
      const next = draft.expectedText !== undefined
        ? await api.editComment(canvasId, draft.id, draft.text, draft.expectedText)
        : await api.createComment(canvasId, { id: draft.id, text: draft.text, anchor: draft.anchor });
      onUpdate(next);
      setActiveId(draft.id);
      setDraft(null);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save comment"); }
    finally { setPending(false); }
  }

  async function resolve() {
    if (!active || !ready || pending) return;
    setPending(true); setError("");
    try { onUpdate(await api.resolveComment(canvasId, active.id)); setActiveId(null); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not resolve comment"); }
    finally { setPending(false); }
  }

  return <>
    {toolbar && createPortal(<button type="button" className="comment-tool" aria-label="Add comment" aria-keyshortcuts="c" aria-pressed={mode} disabled={!ready || pending} onKeyDown={event => event.stopPropagation()}
      title="Add a pinned comment — C" onClick={() => {
        if (draft) { input.current?.focus(); return; }
        setActiveId(null); setError("");
        editor.setActiveTool(mode ? { type: "selection" } : { type: "custom", customType: "comment" });
      }}>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8l-6 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M8 9h8M8 13h5"/></svg>
      <span>Comment</span>
    </button>, toolbar)}
    <div className="comments-overlay" ref={root} onKeyDown={event => event.stopPropagation()}>
      {mode && <div className="comment-hint" role="status">Click an element or the canvas to add a note</div>}
      {state.comments.map((comment, index) => {
        const point = location(comment.anchor);
        return <button type="button" key={comment.id} className={`comment-pin${comment.id === activeId ? " active" : ""}`} style={{ left: point.x, top: point.y }}
          aria-label={`Comment ${index + 1}: ${comment.text.slice(0, 80)}`} aria-expanded={comment.id === activeId} title={comment.text}
          onClick={() => { if (draft || pending) return; setActiveId(comment.id); setError(""); editor.setActiveTool({ type: "selection" }); }}>{index + 1}</button>;
      })}
      {draft && !editing && at && <span className="comment-pin draft" style={{ left: at.x, top: at.y }}>+</span>}
      {selected && at && <section className="comment-popover" role="dialog" aria-label={editing ? "Edit comment" : draft ? "New comment" : "Comment"}
        style={{ left: Math.max(12, Math.min(at.x + 24, (rect?.width ?? 360) - 332)), top: Math.max(12, Math.min(at.y + 12, (rect?.height ?? 400) - 290)) }}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.key === "Escape") { event.preventDefault(); close(); }
          if (draft && event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); }
        }}>
        <header><strong>{editing ? "Edit comment" : draft ? "New comment" : "Comment"}</strong><button type="button" className="comment-close" aria-label="Close comment" disabled={pending} onClick={close}>×</button></header>
        <div className="comment-anchor-label">{selected.anchor.type === "element" ? "Attached to element" : "Pinned to canvas"}</div>
        {draft ? <form onSubmit={event => { event.preventDefault(); void save(); }}>
          <label className="sr-only" htmlFor="comment-text">Comment text</label>
          <textarea id="comment-text" ref={input} rows={4} maxLength={4000} placeholder="Leave a note…" value={draft.text} disabled={pending}
            onChange={event => setDraft({ ...draft, text: event.target.value })}/>
          <div className="comment-actions"><button type="button" className="secondary" disabled={pending} onClick={() => { if (editing) { setDraft(null); setError(""); } else close(); }}>Cancel</button><button type="submit" disabled={!ready || pending || !draft.text.trim()}>{pending ? "Saving…" : editing ? "Save changes" : "Save comment"}</button></div>
        </form> : <><p className="comment-body">{active?.text}</p><div className="comment-actions"><button type="button" className="secondary" disabled={!ready || pending || !active} onClick={() => {
          if (active) { setDraft({ id: active.id, anchor: active.anchor, text: active.text, expectedText: active.text }); setError(""); }
        }}>Edit</button><button type="button" disabled={!ready || pending} onClick={() => void resolve()}>{pending ? "Resolving…" : "Resolve"}</button></div></>}
        {error && <p className="comment-error" role="alert">{error}</p>}
        {!ready && <p className="comment-error" role="status">Reconnect before saving or resolving comments.</p>}
      </section>}
    </div>
  </>;
}
