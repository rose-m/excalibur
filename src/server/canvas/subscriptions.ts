// Registration only: callers authorize access before attaching listeners.
export function subscribeTo<T>(registry: Map<string, Set<T>>, id: string, listener: T): () => void {
  let listeners = registry.get(id);
  if (!listeners) { listeners = new Set(); registry.set(id, listeners); }
  listeners.add(listener);
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    listeners.delete(listener);
    if (!listeners.size && registry.get(id) === listeners) registry.delete(id);
  };
}
