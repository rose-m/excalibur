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
  return new SceneDiffer(known).mutation(local);
}

// The editor advances native versions/nonces for content changes. Use those
// small fields on onChange (including viewport/selection callbacks), and defer
// exact document comparisons until a send or an explicit unsaved-work check.
export class SceneDiffer {
  private elements: Map<string, Scene["elements"][number]>;
  private signatures = new Map<string, string>();

  constructor(private known: Scene) {
    this.elements = new Map(known.elements.map(element => [element.id, element]));
  }

  hasChanges(local: Scene): boolean {
    return local.elements.some(element => {
      const previous = this.elements.get(element.id);
      return !previous || previous.version !== element.version || previous.versionNonce !== element.versionNonce
        || previous.index !== element.index || previous.isDeleted !== element.isDeleted;
    }) || Object.entries(local.files).some(([id, file]) => fileChanged(this.known, id, file))
      || this.known.sharedSettings.viewBackgroundColor !== local.sharedSettings.viewBackgroundColor;
  }

  mutation(local: Scene): Mutation | null {
    const elements = local.elements.filter(element => {
      const previous = this.elements.get(element.id);
      if (!previous) return true;
      let before = this.signatures.get(element.id);
      if (before === undefined) {
        before = signature(previous);
        this.signatures.set(element.id, before);
      }
      return before !== signature(element);
    });
    const files = Object.fromEntries(Object.entries(local.files).filter(([id, file]) => fileChanged(this.known, id, file)));
    const settingsChanged = this.known.sharedSettings.viewBackgroundColor !== local.sharedSettings.viewBackgroundColor;
    if (!elements.length && !Object.keys(files).length && !settingsChanged) return null;
    return { elements, files, ...(settingsChanged ? { sharedSettings: local.sharedSettings } : {}) };
  }
}

function fileChanged(known: Scene, id: string, file: Scene["files"][string]) {
  const existing = Object.hasOwn(known.files, id) ? known.files[id] : undefined;
  return !existing || existing.mimeType !== file.mimeType || existing.dataURL !== file.dataURL;
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
