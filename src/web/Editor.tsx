import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import type { CanvasDocument, Scene } from "../shared/canvas.js";
import { api, ApiError } from "./api.js";
import { sceneSignature } from "./scene-state.js";

type OnChange = NonNullable<ComponentProps<typeof Excalidraw>["onChange"]>;

export default function Editor({ canvas }: { canvas: CanvasDocument }) {
  const initialSignature = useMemo(() => sceneSignature(canvas.scene), [canvas.scene]);
  const latest = useRef<Scene>(canvas.scene);
  const latestSignature = useRef(initialSignature);
  const saved = useRef(initialSignature);
  const revision = useRef(canvas.revision);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const inFlight = useRef<Promise<boolean> | null>(null);
  const conflict = useRef(false);
  const [status, setStatus] = useState("Saved");
  const [error, setError] = useState("");

  const flush = useCallback((): Promise<boolean> => {
    if (inFlight.current) return inFlight.current;
    if (conflict.current) return Promise.resolve(false);
    if (latestSignature.current === saved.current) return Promise.resolve(true);
    inFlight.current = (async () => {
      setStatus("Saving…");
      setError("");
      try {
        // Single-flight saves, including edits made while a request is in flight.
        while (latestSignature.current !== saved.current) {
          const scene = latest.current;
          const signature = latestSignature.current;
          const result = await api.save(canvas.id, { expectedRevision: revision.current, scene });
          revision.current = result.revision;
          saved.current = signature;
        }
        setStatus("Saved");
        return true;
      } catch (error) {
        conflict.current = error instanceof ApiError && error.status === 409;
        setStatus("Not saved");
        setError(error instanceof Error ? error.message : "Save failed. Please retry.");
        return false;
      } finally {
        inFlight.current = null;
      }
    })();
    return inFlight.current;
  }, [canvas.id]);

  useEffect(() => {
    // Re-arm pending work after StrictMode's effect replay or a hot update.
    if (latestSignature.current !== saved.current && !conflict.current) {
      timer.current = setTimeout(() => { void flush(); }, 600);
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (latestSignature.current !== saved.current || inFlight.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      clearTimeout(timer.current);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [flush]);

  const onChange: OnChange = (elements, appState, files) => {
    const scene: Scene = {
      elements: elements as unknown as Scene["elements"],
      sharedSettings: { viewBackgroundColor: appState.viewBackgroundColor },
      files: Object.fromEntries(Object.entries(files).map(([id, file]) => [id, {
        id: file.id, mimeType: file.mimeType, dataURL: file.dataURL, created: file.created,
      }])) as Scene["files"],
    };
    const signature = sceneSignature(scene);
    if (signature === latestSignature.current) return;
    // Excalidraw can mutate native element objects in place. Keep an independent
    // snapshot so future edits cannot mutate pending/in-flight save state.
    latestSignature.current = signature;
    latest.current = JSON.parse(signature) as Scene;
    clearTimeout(timer.current);
    if (signature !== saved.current && !conflict.current) {
      setStatus("Unsaved changes");
      timer.current = setTimeout(() => { void flush(); }, 600);
    } else if (!conflict.current && !inFlight.current) {
      setStatus("Saved");
      setError("");
    }
  };

  return <main className="editor-page">
    <header className="editor-header">
      <a href="/">← Canvases</a>
      <h1>{canvas.title}</h1>
      <span className="save-status" role="status">{status}</span>
      <button className="secondary" onClick={() => { clearTimeout(timer.current); void flush(); }}>Save now</button>
    </header>
    {error && <div className="save-error" role="alert">
      {error} <button onClick={() => window.location.reload()}>Reload canvas (discard unsaved edits)</button>
      <span> You can export your drawing from the editor menu before reloading.</span>
    </div>}
    <div className="editor-surface">
      <Excalidraw
        initialData={{
          elements: canvas.scene.elements,
          appState: { ...canvas.scene.sharedSettings, scrollToContent: true },
          files: canvas.scene.files,
        } as unknown as ExcalidrawInitialDataState}
        onChange={onChange}
        UIOptions={{ canvasActions: { loadScene: false } }}
      >
        <MainMenu>
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      </Excalidraw>
    </div>
    <footer className="editor-footer">Local development · No live collaboration yet · PNG/JPEG/GIF/WebP images, up to 5 MiB each</footer>
  </main>;
}
