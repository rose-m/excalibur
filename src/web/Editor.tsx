import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import type { CanvasDocument } from "../shared/canvas.js";
import { LiveCanvas } from "./live-canvas.js";
import type { LiveRecovery, LiveStatus } from "./live-canvas.js";
import { createLiveEditor } from "./live-editor.js";
import type { CommentState } from "../shared/comments.js";
import Comments from "./Comments.js";

export default function Editor({ canvas }: { canvas: CanvasDocument }) {
  const [editor, setEditor] = useState<ExcalidrawImperativeAPI | null>(null);
  const [status, setStatus] = useState<LiveStatus>({ ready: false, message: "Connecting…", error: "" });
  const [comments, setComments] = useState<CommentState>({ revision: -1, comments: [] });
  const [commentToolbar, setCommentToolbar] = useState<HTMLDivElement | null>(null);
  const receiveComments = useCallback((next: CommentState) => setComments(current => next.revision < current.revision ? current : next), []);
  const live = useRef<LiveCanvas | null>(null);
  // Keep recovery in a ref so effect replay/Fast Refresh cannot discard it.
  const recovery = useRef<LiveRecovery>();
  const initialData = useMemo(() => ({
    elements: canvas.scene.elements,
    appState: { ...canvas.scene.sharedSettings, scrollToContent: true },
    files: canvas.scene.files,
  } as unknown as ExcalidrawInitialDataState), [canvas.scene]);
  const onChange = useCallback(() => { live.current?.changed(); }, []);

  useEffect(() => {
    if (!editor) return;
    const client = new LiveCanvas(canvas, createLiveEditor(editor), setStatus, { recovery: recovery.current, onComments: receiveComments });
    live.current = client;
    client.connect();
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (client.hasUnsavedChanges()) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      recovery.current = client.dispose();
      live.current = null;
    };
  }, [canvas, editor, receiveComments]);

  return <main className="editor-page">
    <header className="editor-header">
      <a href="/">← Canvases</a>
      <h1>{canvas.title}</h1>
      <span className="save-status" role="status">{status.message}</span>
      <button className="secondary" disabled={!status.ready} onClick={() => live.current?.flush()}>Save now</button>
    </header>
    {status.error && <div className="save-error" role="alert">
      {status.error} <button onClick={() => window.location.reload()}>Reload canvas (discard unsaved edits)</button>
      <span> You can export your drawing from the editor menu before reloading.</span>
    </div>}
    <div className="editor-surface">
      <Excalidraw initialData={initialData} excalidrawAPI={setEditor} onChange={onChange}
        renderTopRightUI={() => <div ref={setCommentToolbar} className="comment-toolbar-slot" />}
        viewModeEnabled={!status.ready} UIOptions={{ canvasActions: { loadScene: false } }}>
        <MainMenu>
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      </Excalidraw>
      {editor && <Comments canvasId={canvas.id} editor={editor} toolbar={commentToolbar} state={comments} ready={status.ready} onUpdate={receiveComments} />}
    </div>
    <footer className="editor-footer">Local development · Live canvas · PNG/JPEG/GIF/WebP images, up to 5 MiB each</footer>
  </main>;
}
