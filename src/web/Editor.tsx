import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import type { CanvasDocument, CanvasMetadata } from "../shared/canvas.js";
import { LiveCanvas } from "./live-canvas.js";
import type { LiveRecovery, LiveStatus } from "./live-canvas.js";
import { createLiveEditor } from "./live-editor.js";
import type { CommentState } from "../shared/comments.js";
import Comments from "./Comments.js";
import { api } from "./api.js";
import type { ReactNode } from "react";
import { NavBar } from "./NavBar.js";
import { CanvasActions } from "./CanvasActions.js";
import { Link, useNavigate } from "react-router-dom";
import { useUnsavedNavigation } from "./use-unsaved-navigation.js";

export default function Editor({ canvas, authenticated = false, accountControls, userId }: { canvas: CanvasDocument; authenticated?: boolean; accountControls?: ReactNode; userId: string | undefined }) {
  const navigate = useNavigate();
  const [metadata, setMetadata] = useState<CanvasMetadata>(canvas);
  const [deleted, setDeleted] = useState(false);
  const receiveDeletion = useCallback(() => setDeleted(true), []);
  const leavingAfterDelete = useRef(false);
  const receiveMetadata = useCallback((next: CanvasMetadata) => setMetadata(current => next.revision < current.revision ? current : next), []);
  const [editor, setEditor] = useState<ExcalidrawImperativeAPI | null>(null);
  const [status, setStatus] = useState<LiveStatus>({ ready: false, message: "Connecting…", error: "" });
  const [comments, setComments] = useState<CommentState>({ revision: -1, comments: [] });
  const [commentToolbar, setCommentToolbar] = useState<HTMLDivElement | null>(null);
  const receiveComments = useCallback((next: CommentState) => setComments(current => next.revision < current.revision ? current : next), []);
  const live = useRef<LiveCanvas | null>(null);
  const shouldWarnBeforeLeaving = useCallback(() => !leavingAfterDelete.current && (live.current?.hasUnsavedChanges() ?? false), []);
  useUnsavedNavigation(shouldWarnBeforeLeaving);
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
    const client = new LiveCanvas(canvas, createLiveEditor(editor), setStatus, { recovery: recovery.current, onComments: receiveComments, onMetadata: receiveMetadata, onDeleted: receiveDeletion,
      getTicket: authenticated ? () => api.ticket(canvas.id).then(result => result.ticket) : undefined });
    live.current = client;
    client.connect();
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!leavingAfterDelete.current && client.hasUnsavedChanges()) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      recovery.current = client.dispose();
      live.current = null;
    };
  }, [canvas, editor, receiveComments, receiveMetadata, receiveDeletion, authenticated]);

  return <main className="editor-page">
    <NavBar title={metadata.title} accountControls={accountControls}>
      <span className="save-status" role="status">{status.message}</span>
      {!deleted && <CanvasActions canvas={metadata} canManage={userId === metadata.creatorUserId} canSave={status.ready}
        onSave={() => live.current?.flush()} onUpdate={receiveMetadata} onDeleted={() => {
        leavingAfterDelete.current = true;
        void navigate("/");
      }} />}
    </NavBar>
    {status.error && <div className="save-error" role="alert">
      {status.error} {deleted ? <Link to="/">Back to canvases</Link> : <button onClick={() => window.location.reload()}>Reload canvas (discard unsaved edits)</button>}
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
    <footer className="editor-footer">{!authenticated && "Local development · "}Live canvas · PNG/JPEG/GIF/WebP images, up to 5 MiB each</footer>
  </main>;
}
