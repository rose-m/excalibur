import type { Scene } from "../../shared/canvas.js";

export type NativeElement = Scene["elements"][number];
export type Bounds = { x: number; y: number; width: number; height: number };
export type BoundsResult = Record<string, Bounds>;
export type HeadlessJob =
  | { kind: "convert"; elements: Record<string, unknown>[] }
  | { kind: "bounds"; elements: NativeElement[] }
  | { kind: "bindings"; elements: NativeElement[]; changedIds: string[]; simultaneousIds: string[] }
  | { kind: "render"; scene: Scene; format: "png" | "svg"; scale: number; padding: number; background: boolean; dark: boolean; elementIds?: string[] | undefined };
export type RenderResult = { format: "png" | "svg"; data: string; width: number; height: number };
export type HeadlessResult = NativeElement[] | RenderResult | BoundsResult;
