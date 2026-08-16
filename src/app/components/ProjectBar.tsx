import { ChevronDown, Download, FolderOpen, MoreHorizontal, Redo2, Save, Undo2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

type ProjectBarProps = {
  projectName: string;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  busy: boolean;
  onProjectName: (name: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onOpen: () => void;
  onSave: () => void;
  onNew: () => void;
};

export function ProjectBar(props: ProjectBarProps) {
  const { projectName, dirty, canUndo, canRedo, busy, onProjectName, onUndo, onRedo, onOpen, onSave, onNew } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuPanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menuOpen]);
  useLayoutEffect(() => {
    if (!menuOpen) return;
    menuPanelRef.current?.querySelector<HTMLButtonElement>('button[data-initial-menu-item]')?.focus();
  }, [menuOpen]);

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const compactLayout = window.matchMedia?.("(max-width: 520px)").matches ?? false;
    const items = Array.from(menuPanelRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])
      .filter((item) => compactLayout || !item.classList.contains("compact-only"));
    if (event.key === "Escape") {
      event.preventDefault();
      setMenuOpen(false);
      menuButtonRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !items.length) return;
    event.preventDefault();
    const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? (current + 1) % items.length
      : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };
  const runMenuAction = (action: () => void) => {
    setMenuOpen(false);
    menuButtonRef.current?.focus({ preventScroll: true });
    action();
  };
  return (
    <header className="project-bar">
      <div className="brand-lockup" aria-label="Scene Thread visual thinking engine">
        <div className="brand-mark"><span /><span /><span /></div>
        <div><strong>SCENE THREAD</strong><small>Visual thinking engine</small></div>
      </div>
      <div className="project-name-wrap">
        {dirty && <><span className="unsaved-dot" title="Unsaved changes" aria-hidden="true" /><span className="sr-only">Unsaved changes</span></>}
        <input value={projectName} onChange={(event) => onProjectName(event.target.value)} aria-label="Project name" />
        <ChevronDown size={13} aria-hidden="true" />
      </div>
      <div className="project-actions">
        <div className="action-group">
          <button type="button" onClick={onUndo} disabled={!canUndo || busy} aria-label="Undo last change" title={busy ? "Available after pending changes finish" : "Undo"}><Undo2 size={17} /></button>
          <button type="button" onClick={onRedo} disabled={!canRedo || busy} aria-label="Redo last change" title={busy ? "Available after pending changes finish" : "Redo"}><Redo2 size={17} /></button>
        </div>
        <div className="action-group file-actions">
          <button type="button" onClick={onOpen} disabled={busy} aria-label="Open project" title={busy ? "Available after pending changes finish" : "Open project"}><FolderOpen size={16} /><span>Open</span></button>
          <button type="button" onClick={onSave} aria-label="Save project"><Save size={16} /><span>Save</span></button>
        </div>
        <div className="more-menu" ref={menuRef}>
          {dirty && <span className="compact-unsaved-dot" aria-hidden="true" />}
          <button ref={menuButtonRef} type="button" onClick={() => setMenuOpen((value) => !value)} aria-label={`More project actions${dirty ? ", unsaved changes" : ""}`} aria-haspopup="menu" aria-controls="project-actions-menu" aria-expanded={menuOpen}><MoreHorizontal size={18} /></button>
          {menuOpen && <div ref={menuPanelRef} id="project-actions-menu" className="menu-popover" role="menu" onKeyDown={handleMenuKeyDown}>
            <button type="button" role="menuitem" className="compact-only" onClick={() => runMenuAction(onUndo)} disabled={!canUndo || busy}><Undo2 size={14} />Undo last change</button>
            <button type="button" role="menuitem" className="compact-only" onClick={() => runMenuAction(onRedo)} disabled={!canRedo || busy}><Redo2 size={14} />Redo last change</button>
            <span className="menu-separator compact-only" role="separator" />
            <button type="button" role="menuitem" data-initial-menu-item onClick={() => runMenuAction(onNew)} disabled={busy}>New project</button>
            <button type="button" role="menuitem" onClick={() => runMenuAction(onSave)}><Download size={14} />Download copy</button>
          </div>}
        </div>
      </div>
    </header>
  );
}
