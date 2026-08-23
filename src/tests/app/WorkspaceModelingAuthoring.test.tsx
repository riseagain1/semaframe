import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceComponentLibrary,
  WorkspaceInspector,
  buildWorkspaceComponentCatalog,
  createRectangularCadPlateDefinition,
} from "../../app/components/workspace";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import type { WorkspaceRenderComponent } from "../../workspace/renderer";
import {
  CAD_EVALUATION_EVIDENCE_FORMAT_VERSION,
  CAD_PART_EVALUATOR_VERSION,
  CAD_SKETCH_SOLVER_VERSION,
  cadPartDefinitionDigest,
  type CadEvaluationEvidenceV1,
  type CadPartDefinitionV1,
} from "../../workspace/modeling/cad";

afterEach(cleanup);

function primitiveComponent(): WorkspaceRenderComponent {
  const manifest = DEFAULT_COMPONENT_REGISTRY.require("spatial-primitive");
  return {
    id: "CMP_PRIMITIVE",
    type: { typeId: manifest.typeId, version: manifest.version, digest: manifest.digest },
    label: "Exact box",
    props: structuredClone(manifest.defaultProps),
    durableState: {},
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

function cadComponent(): WorkspaceRenderComponent {
  const manifest = DEFAULT_COMPONENT_REGISTRY.require("cad-part");
  return {
    id: "CMP_CAD",
    type: { typeId: manifest.typeId, version: manifest.version, digest: manifest.digest },
    label: "Machined plate",
    props: structuredClone(manifest.defaultProps),
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
    min: { x: -0.3, y: -0.2, z: 0 },
    max: { x: 0.3, y: 0.2, z: 0.08 },
    size: { x: 0.6, y: 0.4, z: 0.08 },
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
      volumeM3: 0.0192,
      surfaceAreaM2: 0.352,
      centerOfMassM: { x: 0, y: 0, z: 0.04 },
      valid: true,
    }],
    overallBounds: bounds,
    diagnostics: [],
  };
}

describe("parametric modeling authoring", () => {
  it("expands the exact primitive manifest into six presets and includes editable assemblies", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const catalog = buildWorkspaceComponentCatalog(DEFAULT_COMPONENT_REGISTRY.listLatest(), {
      hasStage: false,
    });
    expect(catalog.filter((item) => item.typeId === "spatial-primitive")).toHaveLength(6);
    expect(catalog.some((item) => item.typeId === "model-assembly")).toBe(true);
    expect(catalog.find((item) => item.typeId === "cad-part")).toMatchObject({
      configureOnCreate: true,
      badge: "Exact CAD",
    });

    render(<WorkspaceComponentLibrary items={catalog} onCreate={onCreate} />);
    await user.click(screen.getByRole("button", { name: /Capsule.*Exact radius/i }));
    expect(onCreate).toHaveBeenCalledWith("spatial-primitive", {
      label: "Capsule",
      props: {
        geometry: { kind: "capsule", radiusM: 0.25, cylinderHeightM: 0.5, axis: "y" },
      },
    });
  });

  it("evaluates and commits a human-authored CAD feature document atomically", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn(() => true);
    const evaluateCadPart = vi.fn(async (definition: CadPartDefinitionV1) => cadEvidence(definition));
    render(<WorkspaceInspector
      component={cadComponent()}
      onUpdate={onUpdate}
      evaluateCadPart={evaluateCadPart}
    />);

    await user.clear(screen.getByRole("spinbutton", { name: "CAD plate width (m)" }));
    await user.type(screen.getByRole("spinbutton", { name: "CAD plate width (m)" }), "0.6");
    await user.clear(screen.getByRole("spinbutton", { name: "CAD plate depth (m)" }));
    await user.type(screen.getByRole("spinbutton", { name: "CAD plate depth (m)" }), "0.4");
    await user.clear(screen.getByRole("spinbutton", { name: "CAD plate thickness (m)" }));
    await user.type(screen.getByRole("spinbutton", { name: "CAD plate thickness (m)" }), "0.08");
    await user.click(screen.getByRole("button", { name: "Build and apply starter part" }));

    expect(evaluateCadPart).toHaveBeenCalledTimes(1);
    const evaluatedDefinition = evaluateCadPart.mock.calls[0]?.[0];
    expect(evaluatedDefinition?.history.map((feature) => feature.kind)).toEqual(["sketch", "extrude"]);
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({
      componentId: "CMP_CAD",
      props: expect.objectContaining({
        definitionDigest: cadPartDefinitionDigest(evaluatedDefinition!),
        evaluation: expect.objectContaining({ exactness: "brep", status: "valid" }),
      }),
    }));
  });

  it("keeps the last valid CAD state when evaluation fails", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(<WorkspaceInspector
      component={cadComponent()}
      onUpdate={onUpdate}
      evaluateCadPart={vi.fn().mockRejectedValue(new Error("Feature center_hole produced an invalid B-rep"))}
    />);
    await user.click(screen.getByRole("button", { name: "Build and apply starter part" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid B-rep/i);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("builds a versioned plate with a distinct through-hole feature", () => {
    const definition = createRectangularCadPlateDefinition({
      partId: "fixture_plate",
      displayName: "Fixture plate",
      widthM: 0.8,
      depthM: 0.5,
      thicknessM: 0.03,
      holeDiameterM: 0.06,
    });
    expect(definition.history.map((feature) => feature.kind)).toEqual(["sketch", "extrude", "hole"]);
    expect(definition.parameters.map((parameter) => parameter.id)).toEqual([
      "width", "depth", "thickness", "hole_diameter",
    ]);
  });

  it("commits exact geometry and PBR material as one closed update", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(<WorkspaceInspector component={primitiveComponent()} onUpdate={onUpdate} />);

    const width = screen.getByRole("spinbutton", { name: "Width X (m)" });
    await user.clear(width);
    await user.type(width, "1.25");
    const height = screen.getByRole("spinbutton", { name: "Height Y (m)" });
    await user.clear(height);
    await user.type(height, "0.75");
    const metallic = screen.getByRole("spinbutton", { name: "Metallic" });
    await user.clear(metallic);
    await user.type(metallic, "0.35");
    await user.click(screen.getByRole("button", { name: "Apply geometry and material" }));

    expect(onUpdate).toHaveBeenCalledWith({
      componentId: "CMP_PRIMITIVE",
      props: {
        geometry: { kind: "box", sizeM: { x: 1.25, y: 0.75, z: 1 } },
        material: {
          baseColor: "#68D5FF",
          metallic: 0.35,
          roughness: 0.55,
          opacity: 1,
          emissiveColor: "#000000",
          emissiveIntensity: 0,
        },
      },
    });
  });

  it("enforces the capsule total-extent invariant before sending an update", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(<WorkspaceInspector component={primitiveComponent()} onUpdate={onUpdate} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Primitive" }), "capsule");
    const radius = screen.getByRole("spinbutton", { name: "Radius (m)" });
    await user.clear(radius);
    await user.type(radius, "500");
    const length = screen.getByRole("spinbutton", { name: "Cylinder length (m)" });
    await user.clear(length);
    await user.type(length, "1");
    await user.click(screen.getByRole("button", { name: "Apply geometry and material" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/total extent must not exceed 1000 metres/i);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("offers a lock-aware preserve-world assembly action", async () => {
    const user = userEvent.setup();
    const onCreateAssembly = vi.fn();
    const view = render(<WorkspaceInspector
      component={primitiveComponent()}
      onCreateAssembly={onCreateAssembly}
    />);
    await user.click(screen.getByRole("button", { name: "Create model assembly" }));
    expect(onCreateAssembly).toHaveBeenCalledWith("CMP_PRIMITIVE");

    view.rerender(<WorkspaceInspector
      component={{
        ...primitiveComponent(),
        locks: { ...primitiveComponent().locks, placement: true },
      }}
      onCreateAssembly={onCreateAssembly}
    />);
    expect(screen.getByRole("button", { name: "Create model assembly" })).toBeDisabled();
  });

  it("commits exact world position and degree-authored rotation", async () => {
    const user = userEvent.setup();
    const onTransform = vi.fn();
    render(<WorkspaceInspector
      component={primitiveComponent()}
      worldPlacement={{
        space: "world3d",
        position: { x: 1, y: 2, z: 3 },
        rotation: { x: 0, y: Math.PI / 2, z: 0 },
        scale: { x: 1.5, y: 1.5, z: 1.5 },
      }}
      onTransform={onTransform}
    />);

    const y = screen.getByRole("spinbutton", { name: "World position Y (m)" });
    await user.clear(y);
    await user.type(y, "2.375");
    const zRotation = screen.getByRole("spinbutton", { name: "World rotation Z (deg)" });
    await user.clear(zRotation);
    await user.type(zRotation, "45");
    await user.click(screen.getByRole("button", { name: "Apply world transform" }));

    const request = onTransform.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      componentId: "CMP_PRIMITIVE",
      worldPlacement: {
        position: { x: 1, y: 2.375, z: 3 },
        scale: { x: 1.5, y: 1.5, z: 1.5 },
      },
    });
    expect(request.worldPlacement.rotation.y).toBeCloseTo(Math.PI / 2, 10);
    expect(request.worldPlacement.rotation.z).toBeCloseTo(Math.PI / 4, 10);
  });

  it("attaches to a selected assembly and exposes the current root selection path", async () => {
    const user = userEvent.setup();
    const component = { ...primitiveComponent(), parentId: "ASSEMBLY_CURRENT" };
    const onReparent = vi.fn(() => true);
    const onSelectComponent = vi.fn();
    render(<WorkspaceInspector
      component={component}
      assemblyOptions={[
        { id: "ASSEMBLY_CURRENT", label: "Current fixture" },
        { id: "ASSEMBLY_NEXT", label: "Target fixture" },
      ]}
      onReparent={onReparent}
      onSelectComponent={onSelectComponent}
    />);

    await user.click(screen.getByRole("button", { name: /Select parent assembly.*Current fixture/i }));
    expect(onSelectComponent).toHaveBeenCalledWith("ASSEMBLY_CURRENT");
    await user.selectOptions(screen.getByRole("combobox", { name: "Parent" }), "ASSEMBLY_NEXT");
    await user.click(screen.getByRole("button", { name: "Apply parent · preserve world" }));
    expect(onReparent).toHaveBeenCalledWith({
      componentId: "CMP_PRIMITIVE",
      parentId: "ASSEMBLY_NEXT",
    });
  });

  it("allows the spatial-primitive 1.0 physics master switch to be disabled", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(<WorkspaceInspector component={primitiveComponent()} onUpdate={onUpdate} />);
    const enabled = screen.getByRole("checkbox", { name: "Physics enabled" });
    expect(enabled).toBeEnabled();
    await user.click(enabled);
    await user.click(screen.getByRole("button", { name: "Apply physics" }));
    const physicsRequest = onUpdate.mock.calls.find(([request]) => "physics" in request.props)?.[0];
    expect(physicsRequest).toBeDefined();
    expect(physicsRequest.props.physics).toMatchObject({ enabled: false });
  });

  it("keeps safe model-instance deletion confirmation open when the commit fails", async () => {
    const user = userEvent.setup();
    const onDeleteComponent = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    render(<WorkspaceInspector
      component={{
        ...primitiveComponent(),
        type: { typeId: "model-assembly", version: "1.0.0", digest: "assembly" },
        label: "Reusable fixture instance",
        props: {
          modelRef: { modelId: "com.example.fixture", version: "1.0.0", digest: "sha256:fixture" },
        },
      }}
      descendantCount={2}
      onDeleteComponent={onDeleteComponent}
    />);

    await user.click(screen.getByRole("button", { name: "Delete model instance…" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("2 descendants");
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));
    expect(screen.getByRole("alertdialog")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onDeleteComponent).toHaveBeenCalledTimes(2);
  });
});
