export type SelectionSource = "canvas" | "tree" | "inspector" | "three" | "programmatic";

export type SelectionChange = Readonly<{
  componentId: string | null;
  source: SelectionSource;
}>;

export type SelectionListener = (change: SelectionChange) => void;

/** Keeps the WebGL, DOM overlay, accessible tree, and Inspector selection in sync. */
export class SelectionCoordinator {
  private selectedId: string | null = null;
  private readonly listeners = new Set<SelectionListener>();

  getSelectedId(): string | null {
    return this.selectedId;
  }

  select(componentId: string | null, source: SelectionSource = "programmatic"): void {
    if (this.selectedId === componentId) return;
    this.selectedId = componentId;
    const change = { componentId, source } as const;
    for (const listener of this.listeners) listener(change);
  }

  subscribe(listener: SelectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
