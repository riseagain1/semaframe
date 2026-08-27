import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceInspector,
  createRectangularCadPlateDefinition,
} from "../../app/components/workspace/WorkspaceInspector";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import type { WorkspaceRenderComponent } from "../../workspace/renderer/contracts";
import {
  CAD_EVALUATION_EVIDENCE_FORMAT_VERSION,
  CAD_PART_EVALUATOR_VERSION,
  CAD_SKETCH_SOLVER_VERSION,
  cadPartDefinitionDigest,
  parseCadPartDefinition,
  type CadEvaluationEvidenceV1,
  type CadPartDefinitionV1,
} from "../../workspace/modeling/cad";

afterEach(cleanup);

function componentFromManifest(typeId: "cad-part" | "model-assembly"): WorkspaceRenderComponent {
  const manifest = DEFAULT_COMPONENT_REGISTRY.require(typeId);
  return {
    id: typeId === "cad-part" ? "CMP_CAD_MODE" : "CMP_ASSEMBLY_MODE",
    type: { typeId: manifest.typeId, version: manifest.version, digest: manifest.digest },
    label: typeId === "cad-part" ? "Mode fixture" : "Assembly fixture",
    props: structuredClone(manifest.defaultProps),
    durableState: { audit: "retained" },
    placement: {
      space: "world3d",
      position: { x: 0, y: 0.5, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    tags: [],
    visibility: "visible",
    locks: {
      placement: false,
      resize: false,
      visualEffects: false,
      props: false,
      deletion: false,
      actions: false,
    },
  };
}

function configuredSpatial(): WorkspaceRenderComponent {
  return {
    id: "CMP_CONFIGURED",
    type: { typeId: "spatial-entity", version: "1.5.0", digest: "sha256:manifest" },
    label: "Configured machine",
    props: {
      assetId: "primitive_box",
      entityKind: "primitive",
      collision: {
        enabled: true,
        role: "solid",
        shape: "compound",
        margin: 0.04,
        parts: [{
          id: "body",
          center: { x: 0, y: 0.5, z: 0 },
          size: { x: 2, y: 1, z: 1 },
          rotation: { x: 0, y: 0, z: 0 },
        }],
      },
      physics: {
        enabled: true,
        bodyType: "dynamic",
        massKg: 12.5,
        centerOfMass: { x: 0.1, y: 0, z: 0 },
        friction: 0.7,
        restitution: 0.2,
        gravityScale: 0.8,
        stabilityMode: "enforce",
        constraints: [{
          id: "mount",
          type: "fixed",
          targetId: "BASE",
          anchor: { x: 0, y: 0, z: 0 },
          targetAnchor: { x: 0, y: 0, z: 0 },
          axis: { x: 0, y: 1, z: 0 },
          enabled: true,
        }],
      },
    },
    durableState: {},
    placement: {
      space: "world3d",
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    tags: [],
    visibility: "visible",
    locks: {
      placement: false,
      resize: false,
      visualEffects: false,
      props: false,
      deletion: false,
      actions: false,
    },
  };
}

function cadEvidence(definition: CadPartDefinitionV1): CadEvaluationEvidenceV1 {
  const bounds = {
    min: { x: -0.4, y: -0.2, z: 0 },
    max: { x: 0.4, y: 0.2, z: 0.08 },
    size: { x: 0.8, y: 0.4, z: 0.08 },
    center: { x: 0, y: 0, z: 0.04 },
  };
  return {
    formatVersion: CAD_EVALUATION_EVIDENCE_FORMAT_VERSION,
    definitionDigest: cadPartDefinitionDigest(definition),
    evaluatorVersion: CAD_PART_EVALUATOR_VERSION,
    sketchSolverVersion: CAD_SKETCH_SOLVER_VERSION,
    exactness: "brep",
    status: "valid",
    bodies: [{
      bodyId: "body",
      bounds,
      volumeM3: 0.0256,
      surfaceAreaM2: 0.4,
      centerOfMassM: { x: 0, y: 0, z: 0.04 },
      valid: true,
    }],
    overallBounds: bounds,
    diagnostics: [],
  };
}

describe("Workspace Inspector detail modes", () => {
  it("defaults to a useful Basic surface and reveals technical documents only in Advanced", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(<WorkspaceInspector component={componentFromManifest("cad-part")} onUpdate={onUpdate} />);

    expect(screen.getByRole("button", { name: "Basic" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "World transform" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Editable CAD part" })).toBeVisible();
    expect(screen.getByRole("spinbutton", { name: "CAD plate width (m)" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Collision enabled" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Physics enabled" })).toBeVisible();
    expect(screen.queryByRole("list", { name: "CAD feature history" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Shape" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Body type" })).not.toBeInTheDocument();
    expect(screen.queryByText("Manifest digest")).not.toBeInTheDocument();
    expect(screen.queryByText("Raw properties")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Advanced" }));

    expect(screen.getByRole("button", { name: "Advanced" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("list", { name: "CAD feature history" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Shape" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Body type" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Constraints JSON" })).toBeVisible();
    expect(screen.getByText("Manifest digest")).toBeVisible();
    expect(screen.getByText("Raw properties")).toBeVisible();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("toggles collision and physics in Basic without erasing hidden compound or constraint data", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    const component = configuredSpatial();
    render(<WorkspaceInspector component={component} onUpdate={onUpdate} />);

    await user.click(screen.getByRole("checkbox", { name: "Collision enabled" }));
    await user.click(screen.getByRole("button", { name: "Apply collision" }));
    expect(onUpdate).toHaveBeenCalledWith({
      componentId: component.id,
      props: {
        collision: {
          enabled: false,
          role: "solid",
          shape: "compound",
          margin: 0.04,
          parts: [{
            id: "body",
            center: { x: 0, y: 0.5, z: 0 },
            size: { x: 2, y: 1, z: 1 },
            rotation: { x: 0, y: 0, z: 0 },
          }],
        },
      },
    });

    await user.click(screen.getByRole("checkbox", { name: "Physics enabled" }));
    await user.click(screen.getByRole("button", { name: "Apply physics" }));
    expect(onUpdate).toHaveBeenCalledWith({
      componentId: component.id,
      props: {
        physics: {
          enabled: false,
          bodyType: "dynamic",
          massKg: 12.5,
          centerOfMass: { x: 0.1, y: 0, z: 0 },
          friction: 0.7,
          restitution: 0.2,
          gravityScale: 0.8,
          stabilityMode: "enforce",
          constraints: [{
            id: "mount",
            type: "fixed",
            targetId: "BASE",
            anchor: { x: 0, y: 0, z: 0 },
            targetAnchor: { x: 0, y: 0, z: 0 },
            axis: { x: 0, y: 1, z: 0 },
            enabled: true,
          }],
        },
      },
    });
  });

  it("keeps one CAD draft while switching modes", async () => {
    const user = userEvent.setup();
    render(<WorkspaceInspector component={componentFromManifest("cad-part")} onUpdate={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    const document = screen.getByRole("textbox", { name: "CAD feature document JSON" });
    fireEvent.change(document, { target: { value: "draft that is intentionally incomplete" } });
    await user.click(screen.getByRole("button", { name: "Basic" }));
    expect(screen.queryByRole("textbox", { name: "CAD feature document JSON" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByRole("textbox", { name: "CAD feature document JSON" }))
      .toHaveValue("draft that is intentionally incomplete");
  });

  it("edits common CAD parameters in Basic without replacing hidden feature history", async () => {
    const user = userEvent.setup();
    const base = createRectangularCadPlateDefinition({
      partId: "custom_fixture",
      displayName: "Custom fixture",
      widthM: 0.6,
      depthM: 0.4,
      thicknessM: 0.08,
    });
    const definition = parseCadPartDefinition({
      ...base,
      history: base.history.map((feature, index) => index === 0
        ? { ...feature, name: "Custom constrained profile" }
        : feature),
    });
    const source = componentFromManifest("cad-part");
    const component = {
      ...source,
      props: {
        ...source.props,
        definition,
        definitionDigest: cadPartDefinitionDigest(definition),
        evaluation: cadEvidence(definition),
      },
    };
    const evaluateCadPart = vi.fn(async (next: CadPartDefinitionV1) => cadEvidence(next));
    render(<WorkspaceInspector
      component={component}
      onUpdate={vi.fn(() => true)}
      evaluateCadPart={evaluateCadPart}
    />);

    const width = screen.getByRole("spinbutton", { name: "CAD plate width (m)" });
    await user.clear(width);
    await user.type(width, "0.8");
    await user.click(screen.getByRole("button", { name: "Apply safe CAD parameters" }));

    await waitFor(() => expect(evaluateCadPart).toHaveBeenCalledOnce());
    const evaluated = evaluateCadPart.mock.calls[0]![0];
    expect(evaluated.history).toEqual(definition.history);
    expect(evaluated.history[0]?.name).toBe("Custom constrained profile");
    expect(evaluated.parameters.find((parameter) => parameter.id === "width")?.expression)
      .toEqual({ kind: "constant", dimension: "length", value: 0.8 });
  });

  it("preserves hidden assembly mates when Basic metadata is applied", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn(() => true);
    const sourceMate = {
      id: "base_to_post",
      kind: "fixed",
      a: { componentId: "PART_A", datumId: "top_plane" },
      b: { componentId: "PART_B", topologyRole: "mount_face" },
      offsetM: 0,
      angleRad: 0,
      enabled: true,
    };
    const component = componentFromManifest("model-assembly");
    const versionTwo = {
      ...component,
      type: { ...component.type, version: "2.0.0" },
      props: { ...component.props, mates: [sourceMate] },
    };
    render(<WorkspaceInspector component={versionTwo} onUpdate={onUpdate} />);

    expect(screen.queryByRole("textbox", { name: "Assembly mates JSON" })).not.toBeInTheDocument();
    const description = screen.getByRole("textbox", { name: "Description" });
    await user.clear(description);
    await user.type(description, "Human-readable fixture");
    await user.click(screen.getByRole("button", { name: "Apply model settings" }));

    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({
      props: expect.objectContaining({ mates: [sourceMate] }),
    }));
  });

  it("uses a focus request to reveal and focus an Advanced section", async () => {
    render(<WorkspaceInspector
      component={configuredSpatial()}
      focusRequest={{ sectionId: "physics-details", requestId: 1 }}
    />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Advanced" }))
      .toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("combobox", { name: "Body type" })).toBeVisible();
    await waitFor(() => expect(document.activeElement)
      .toHaveAttribute("data-workspace-inspector-section", "physics-details"));
  });
});
