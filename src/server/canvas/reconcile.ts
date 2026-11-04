// Adapted from Excalidraw v0.18.1 data/reconcile.ts and fractionalIndex.ts.
// Copyright (c) 2020 Excalidraw. MIT license: see THIRD_PARTY_NOTICES.md.
// The published editor bundle is browser-only, so the server keeps this small
// headless port. No active-editor exemption exists on the authoritative server.
import { randomInt } from "node:crypto";
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import type { Scene } from "../../shared/canvas.js";
import { ServiceError } from "./errors.js";

type Element = Scene["elements"][number];

export function reconcileElements(local: Scene["elements"], remote: Scene["elements"]): Scene["elements"] {
  const byId = new Map(local.map((element) => [element.id, element]));
  const added = new Set<string>();
  const result: Scene["elements"] = [];
  for (const element of remote) {
    if (added.has(element.id)) throw new ServiceError(400, "Duplicate element ID");
    const current = byId.get(element.id);
    const discard = current && (current.version > element.version
      || (current.version === element.version && current.versionNonce < element.versionNonce));
    result.push({ ...(discard ? current : element) });
    added.add(element.id);
  }
  for (const element of local) if (!added.has(element.id)) result.push({ ...element });

  for (const element of result) {
    if (element.index) {
      try { generateKeyBetween(element.index, null); }
      catch { throw new ServiceError(400, "Invalid fractional element index"); }
    }
  }
  result.sort((a, b) => {
    if (a.index && b.index) {
      if (a.index !== b.index) return a.index < b.index ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    }
    return 1;
  });
  repairIndices(result);
  return result;
}

function valid(index: string | null | undefined, lower: string | null | undefined, upper: string | null | undefined) {
  return !!index && (!lower || lower < index) && (!upper || index < upper);
}

// Match upstream's invalid-index grouping, preserving already valid indices.
function repairIndices(elements: Element[]) {
  let lowerIndex = -1;
  let upperIndex = 0;
  const groups: number[][] = [];
  function lower(i: number): [Element["index"], number] {
    const bound = elements[lowerIndex]?.index;
    const candidate = elements[i - 1]?.index;
    return candidate && (!bound || candidate > bound) ? [candidate, i - 1] : [bound, lowerIndex];
  }
  function upper(i: number): [Element["index"], number] {
    const bound = elements[upperIndex]?.index;
    if (bound && i < upperIndex) return [bound, upperIndex];
    let next = upperIndex;
    while (++next < elements.length) {
      const candidate = elements[next]?.index;
      if (candidate && (!bound || candidate > bound)) return [candidate, next];
    }
    return [undefined, next];
  }
  let i = 0;
  while (i < elements.length) {
    let low: Element["index"];
    let high: Element["index"];
    [low, lowerIndex] = lower(i);
    [high, upperIndex] = upper(i);
    if (valid(elements[i]!.index, low, high)) { i++; continue; }
    const group = [lowerIndex, i];
    while (++i < elements.length) {
      const [nextLow, nextLower] = lower(i);
      const [nextHigh, nextUpper] = upper(i);
      if (valid(elements[i]!.index, nextLow, nextHigh)) break;
      [low, lowerIndex] = [nextLow, nextLower];
      [high, upperIndex] = [nextHigh, nextUpper];
      group.push(i);
    }
    group.push(upperIndex);
    groups.push(group);
  }
  for (const group of groups) {
    const lower = group.shift()!;
    const upper = group.pop()!;
    const keys = generateNKeysBetween(elements[lower]?.index ?? null, elements[upper]?.index ?? null, group.length);
    group.forEach((index, offset) => {
      const element = elements[index]!;
      element.index = keys[offset]!;
      element.version++;
      element.versionNonce = randomInt(0x7fffffff);
      element.updated = Date.now();
    });
  }
}
