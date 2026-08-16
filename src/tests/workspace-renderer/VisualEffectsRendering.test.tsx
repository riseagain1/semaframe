import { render } from "@testing-library/react";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { WorkspaceCanvasOverlay } from "../../app/components/workspace/WorkspaceCanvasOverlay";
import { applyObjectVisualEffects, restoreObjectVisualEffects } from "../../renderer/visualEffects";
import type { WorkspaceRenderComponent } from "../../workspace/renderer";

const effects = {
  opacity: 0.5,
  emissive: { color: "#FF3300" as const, intensity: 2 },
  glow: { color: "#00CCFF" as const, intensity: 1.5, spread: 0.75 },
};

describe("universal visual-effects rendering", () => {
  it("applies and restores 3D material effects from a stable baseline", () => {
    const root = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({
      color: 0x445566,
      opacity: 0.8,
      emissive: 0x110000,
      emissiveIntensity: 0.25,
    });
    root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material));

    const renderedEffects = {
      opacity: effects.opacity,
      emissiveColor: effects.emissive.color,
      emissiveIntensity: effects.emissive.intensity,
      glowColor: effects.glow.color,
      glowIntensity: effects.glow.intensity,
      glowSpread: effects.glow.spread,
    };
    applyObjectVisualEffects(root, renderedEffects);
    // Diagnostic invariant: the renderer recognized a physically based material.
    expect(material.userData.workspaceVisualEffectsBaseline).toMatchObject({ emissive: 0x110000 });
    expect(material.opacity).toBeCloseTo(0.4);
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.emissive.getHexString()).toBe("00ccff");
    expect(material.emissiveIntensity).toBeCloseTo(3.375);

    applyObjectVisualEffects(root, renderedEffects);
    expect(material.opacity).toBeCloseTo(0.4);
    expect(material.emissiveIntensity).toBeCloseTo(3.375);
    restoreObjectVisualEffects(root);
    expect(material.opacity).toBeCloseTo(0.8);
    expect(material.emissive.getHexString()).toBe("110000");
    expect(material.emissiveIntensity).toBeCloseTo(0.25);
  });

  it("maps 2D opacity and glow onto the stable outer component without remounting content", () => {
    const component: WorkspaceRenderComponent = {
      id: "CMP_EFFECT",
      type: { typeId: "panel", version: "1.1.0", digest: "panel" },
      label: "Glowing panel",
      props: { title: "Glowing panel" },
      durableState: {},
      placement: { space: "viewport", anchor: "center", offset: { x: 0, y: 0 }, size: { width: 320, height: 220 } },
      tags: [],
      visibility: "visible",
      visualEffects: effects,
      locks: { placement: false, resize: false, visualEffects: false, props: false, deletion: false, actions: false },
    };
    const projections = new Map([[component.id, {
      componentId: component.id,
      space: "viewport" as const,
      left: 10,
      top: 20,
      width: 320,
      height: 220,
      zIndex: 1,
      visible: true,
      spatialOnly: false,
    }]]);
    const view = render(<WorkspaceCanvasOverlay components={[component]} projections={projections} selectedId={null} />);
    const shell = view.container.querySelector<HTMLElement>("[data-workspace-component-id='CMP_EFFECT']");
    const content = shell?.firstElementChild;
    expect(shell).toHaveStyle({ opacity: "0.5", pointerEvents: "auto" });
    expect(shell?.style.boxShadow).toContain("0, 204, 255");

    view.rerender(<WorkspaceCanvasOverlay
      components={[{ ...component, visualEffects: { ...effects, glow: { ...effects.glow, intensity: 2 } } }]}
      projections={projections}
      selectedId={null}
    />);
    expect(shell?.firstElementChild).toBe(content);

    view.rerender(<WorkspaceCanvasOverlay
      components={[{ ...component, visualEffects: { ...effects, opacity: 0 } }]}
      projections={projections}
      selectedId={null}
    />);
    expect(shell).toHaveAttribute("aria-hidden", "true");
    expect(shell).toHaveAttribute("tabindex", "-1");
    expect(shell).toHaveStyle({ pointerEvents: "none" });
  });
});
