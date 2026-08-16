import { useMemo, useState } from "react";

export type ComponentLibraryItem = Readonly<{
  typeId: string;
  displayName: string;
  description?: string;
  placements?: readonly string[];
  trustTier?: "builtin" | "declarative" | "sandboxed";
  configureOnCreate?: boolean;
}>;

export type WorkspaceComponentLibraryProps = Readonly<{
  items: readonly ComponentLibraryItem[];
  onCreate?: (typeId: string) => void;
}>;

export function WorkspaceComponentLibrary({ items, onCreate }: WorkspaceComponentLibraryProps) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? items.filter((item) => `${item.displayName} ${item.typeId} ${item.description ?? ""}`.toLowerCase().includes(needle))
      : items;
  }, [items, query]);
  return (
    <aside className="workspace-side-panel workspace-library" aria-label="Component library">
      <header><strong>Components</strong><span>{items.length}</span></header>
      <label>
        <span className="workspace-a11y-label">Find a component</span>
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search components" />
      </label>
      <ul>
        {filtered.map((item) => (
          <li key={item.typeId}>
            <button type="button" onClick={() => onCreate?.(item.typeId)}>
              <strong>{item.displayName}</strong>
              <span>{item.description ?? item.typeId}</span>
              {item.trustTier === "declarative" && <small>Custom recipe</small>}
            </button>
          </li>
        ))}
      </ul>
      {filtered.length === 0 && <p className="workspace-empty-copy">No matching components.</p>}
      <section className="workspace-library__custom" aria-label="Custom component help">
        <strong>Need a custom component?</strong>
        <p>Ask an approved Agent to define a bounded declarative recipe. New recipe types appear in this list for reuse.</p>
      </section>
    </aside>
  );
}
