import { CaptureUpdateAction, isInvisiblySmallElement, reconcileElements, restoreElements } from "@excalidraw/excalidraw";
import type { BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { Scene } from "../shared/canvas.js";
import type { LiveEditor } from "./live-state.js";

// Keep the mutable, browser-only SDK at the edge. The coordinator can be tested
// with an editor which deliberately defers app-state updates, just like React.
export function createLiveEditor(editor: ExcalidrawImperativeAPI): LiveEditor {
  return {
    read() {
      return {
        elements: editor.getSceneElementsIncludingDeleted() as unknown as Scene["elements"],
        sharedSettings: { viewBackgroundColor: editor.getAppState().viewBackgroundColor },
        files: Object.fromEntries(Object.entries(editor.getFiles()).map(([id, file]) => [id, {
          id: file.id, mimeType: file.mimeType, dataURL: file.dataURL, created: file.created,
        }])) as Scene["files"],
      };
    },
    normalize(scene) {
      const restored = restoreElements(scene.elements as unknown as Parameters<typeof restoreElements>[0], null,
        { refreshDimensions: false, repairBindings: false });
      const byId = new Map(restored.map((element) => [element.id, element]));
      return {
        ...scene,
        // Keep tiny in-progress elements in the baseline, even when native
        // restoration drops them, so acknowledgments do not cause resend loops.
        elements: scene.elements.map((element) => byId.get(element.id) ?? element) as Scene["elements"],
      };
    },
    render(scene, replace) {
      // Never let native in-place mutations change our authoritative baseline.
      const remote = structuredClone(scene);
      editor.addFiles(Object.values(remote.files) as unknown as BinaryFiles[string][]);
      const elements = replace ? remote.elements : reconcileElements(
        editor.getSceneElementsIncludingDeleted() as Parameters<typeof reconcileElements>[0],
        remote.elements as unknown as Parameters<typeof reconcileElements>[1], editor.getAppState());
      editor.updateScene({
        elements: elements as Parameters<ExcalidrawImperativeAPI["updateScene"]>[0]["elements"],
        appState: remote.sharedSettings,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    },
    isInvisiblySmall: (element) => isInvisiblySmallElement(element as unknown as Parameters<typeof isInvisiblySmallElement>[0]),
  };
}
