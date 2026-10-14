import type { RuntimeViewContext } from "../layout/runtimeView";

/** Public IDs are fixed app chrome identifiers, never DOM text or user content. */
const HOST_REGIONS: Readonly<Record<string, string>> = Object.freeze({
  "workspace-tools": "toolbar",
  "workspace-panel": "panel",
  "camera-controls": "toolbar",
  "viewport-status": "status",
  "camera-help": "panel",
  "agent-controls": "toolbar",
  "agent-history": "panel",
  "project-controls": "toolbar",
  "project-menu": "panel",
  "project-recovery": "notification",
  "notifications": "notification",
});

export type RuntimeViewHostSample = Readonly<{
  occluders: RuntimeViewContext["occluders"];
  unavailableReason?: string;
}>;

/** Only app-owned, explicitly marked surfaces are inspected; no text, URL,
 * form value, iframe content, or arbitrary page accessibility tree is read. */
export function collectRuntimeViewHost(container: HTMLElement): RuntimeViewHostSample {
  const root = container.closest<HTMLElement>("[data-workspace-runtime-root]");
  if (!root) return { occluders: [] };
  const canvas = container.getBoundingClientRect();
  const immersive = container.closest<HTMLElement>('[data-workspace-runtime-immersive="true"]');
  const occluders: RuntimeViewContext["occluders"][number][] = [];
  for (const marker of root.querySelectorAll<HTMLElement>("[data-workspace-runtime-region]")) {
    if (marker.closest("[data-workspace-component-id]")) continue;
    if (immersive && !immersive.contains(marker)) continue;
    const id = marker.dataset.workspaceRuntimeRegion ?? "";
    const kind = HOST_REGIONS[id];
    if (!kind) continue;
    // display:contents wrappers let App identify an owned component without
    // introducing a new layout box or changing that component's public props.
    const elements = marker.dataset.workspaceRuntimeChildren === "true"
      ? [...marker.children].filter((child): child is HTMLElement => child instanceof HTMLElement)
      : [marker];
    elements.forEach((element, index) => {
      if (!isVisibleHostElement(element, root)) return;
      const rect = element.getBoundingClientRect();
      const left = Math.max(canvas.left, rect.left);
      const top = Math.max(canvas.top, rect.top);
      const right = Math.min(canvas.right, rect.right);
      const bottom = Math.min(canvas.bottom, rect.bottom);
      if (right <= left || bottom <= top) return;
      occluders.push({
        id: elements.length > 1 ? `${id}:${index}` : id,
        kind,
        bounds: { left: left - canvas.left, top: top - canvas.top, width: right - left, height: bottom - top },
      });
    });
  }
  occluders.sort((a, b) => a.id.localeCompare(b.id));
  const blocked = root.dataset.workspaceRuntimeBlocked === "true";
  const portalOpen = [...container.ownerDocument.querySelectorAll<HTMLElement>(
    '[data-workspace-runtime-modal="xr-setup"], [data-workspace-runtime-modal="xr-headset"]',
  )].some((modal) => !modal.closest("[data-workspace-component-id]") && isVisibleHostElement(modal, root));
  const dialogOpen = [...root.querySelectorAll<HTMLElement>("[data-workspace-runtime-modal-scope]")]
    .some((scope) => !scope.closest("[data-workspace-component-id]")
      && [...scope.querySelectorAll<HTMLElement>('[role="dialog"], dialog[open]')]
        .some((dialog) => isVisibleHostElement(dialog, root)));
  return {
    occluders,
    ...(blocked || dialogOpen || portalOpen ? { unavailableReason: "host_modal_or_gate" } : {}),
  };
}

function isVisibleHostElement(element: HTMLElement, root: HTMLElement): boolean {
  const view = element.ownerDocument.defaultView;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const style = view?.getComputedStyle(current);
    if (current.hidden || style?.display === "none" || style?.visibility === "hidden"
      || style?.visibility === "collapse" || style?.opacity === "0") return false;
    if (current === root) break;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
