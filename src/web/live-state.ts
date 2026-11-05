import type { Mutation, Scene, SceneUpdate } from "../shared/canvas.js";
import { signature } from "../shared/signature.js";

type SharedSettings = Scene["sharedSettings"];

export interface LiveEditor {
  read(): Scene;
  selectedElementIds(): string[];
  normalize(scene: Scene): Scene;
  render(scene: Scene, replace: boolean): void;
  isInvisiblySmall(element: Scene["elements"][number]): boolean;
}

export class SharedSettingsTracker {
  private observed: string;
  private renders: string[] = [];
  private local: SharedSettings | undefined;

  constructor(settings: SharedSettings) { this.observed = signature(settings); }

  requested(settings: SharedSettings) {
    const next = signature(settings);
    if ((this.renders.at(-1) ?? this.observed) !== next) this.renders.push(next);
  }

  changed(settings: SharedSettings, acceptLocal: boolean) {
    const next = signature(settings);
    const echo = this.renders.indexOf(next);
    if (echo >= 0) {
      // React may apply each render or batch straight to a later requested one.
      this.renders.splice(0, echo + 1);
    } else if (next !== this.observed && acceptLocal) {
      this.local = { ...settings };
    }
    this.observed = next;
  }

  settle(settings: SharedSettings) {
    if (this.local && signature(this.local) === signature(settings)) this.local = undefined;
  }

  retain(settings: SharedSettings) { this.local = { ...settings }; }

  value(authoritative: SharedSettings): SharedSettings { return this.local ?? authoritative; }
}

export function pendingMutation(known: Scene, local: Scene): Mutation | null {
  const previous = new Map(known.elements.map((element) => [element.id, signature(element)]));
  const elements = local.elements.filter((element) => previous.get(element.id) !== signature(element));
  const files = Object.fromEntries(Object.entries(local.files).filter(([id, file]) => {
    const existing = Object.hasOwn(known.files, id) ? known.files[id] : undefined;
    return !existing || existing.mimeType !== file.mimeType || existing.dataURL !== file.dataURL;
  }));
  const settingsChanged = signature(known.sharedSettings) !== signature(local.sharedSettings);
  if (!elements.length && !Object.keys(files).length && !settingsChanged) return null;
  return { elements, files, ...(settingsChanged ? { sharedSettings: local.sharedSettings } : {}) };
}

export function applyUpdate(scene: Scene, update: SceneUpdate): Scene {
  const elements = new Map(scene.elements.map((element) => [element.id, element]));
  for (const element of update.elements) elements.set(element.id, element);
  return {
    elements: [...elements.values()].sort((a, b) => {
      if (a.index && b.index && a.index !== b.index) return a.index < b.index ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    }),
    files: { ...scene.files, ...update.files },
    sharedSettings: update.sharedSettings,
  };
}
