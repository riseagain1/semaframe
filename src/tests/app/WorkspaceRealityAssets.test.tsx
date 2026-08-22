import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceChrome,
  WorkspaceInspector,
  WorkspaceRealityAssets,
} from "../../app/components/workspace";
import type { RealityMeasurementEvent } from "../../renderer/reality";
import type { RealityAssetDescriptor } from "../../workspace/assets";
import { inspectRealityAsset, MemoryAssetVault } from "../../workspace/assets";
import { DEFAULT_COMPONENT_REGISTRY } from "../../workspace/components";
import type { WorkspaceRenderComponent } from "../../workspace/renderer";
import { WorkspaceProjectSerializer } from "../../workspace/persistence";
import { WorkspaceStore } from "../../workspace/state";
import { workspaceBatch } from "../workspace/helpers";
import { asciiPly, VALID_ROW } from "../workspace-assets/fixtures";

afterEach(cleanup);

const digest = `sha256:${"a".repeat(64)}` as const;
const assetId = `ra_${"a".repeat(64)}` as const;
const replacementDigest = `sha256:${"b".repeat(64)}` as const;
const replacementAssetId = `ra_${"b".repeat(64)}` as const;

function descriptor(): RealityAssetDescriptor {
  return {
    version: 1,
    assetId,
    digest,
    format: "ply",
    formatVersion: 1,
    mediaType: "application/ply",
    byteLength: 4_096,
    splatCount: 12_345,
    sphericalHarmonicsDegree: 0,
    model: "gaussian-3d",
    antialiased: null,
    coordinateSystem: { system: "RUB", provenance: "embedded" },
    engineeringAuthority: "visual_only",
  };
}

function splatComponent(): WorkspaceRenderComponent {
  const manifest = DEFAULT_COMPONENT_REGISTRY.require("gaussian-splat");
  return {
    id: "CMP_REALITY",
    type: { typeId: manifest.typeId, version: manifest.version, digest: manifest.digest },
    label: "Field capture",
    props: {
      assetRef: { assetId, digest },
      calibration: {
        version: 1,
        status: "uncalibrated",
        sourceCoordinateSystem: "RUB",
        targetCoordinateSystem: "RUB",
        metersPerSourceUnit: null,
      },
      quality: "auto",
      semanticProxyIds: [],
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

describe("human Reality asset workflow", () => {
  it("stores bytes only in the vault while save/reopen preserves an editable missing-byte placeholder", async () => {
    const source = asciiPly([VALID_ROW]);
    const file = new File([source], "private-field-capture.ply", { type: "application/ply" });
    const candidate = await inspectRealityAsset(file);
    const vault = new MemoryAssetVault();
    await vault.put(candidate, file);
    const store = new WorkspaceStore();
    store.apply(workspaceBatch(store, "human_reality_import", [{
      op: "register_reality_asset",
      op_id: "register_reality",
      asset: candidate.descriptor,
    }, {
      op: "create_component",
      op_id: "create_stage",
      id: "CMP_STAGE",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
      placement: {
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    }, {
      op: "create_component",
      op_id: "create_reality",
      id: "CMP_REALITY",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("gaussian-splat"),
      props: {
        assetRef: { assetId: candidate.descriptor.assetId, digest: candidate.descriptor.digest },
        calibration: {
          version: 1,
          status: "uncalibrated",
          sourceCoordinateSystem: candidate.descriptor.coordinateSystem.system,
          targetCoordinateSystem: "RUB",
          metersPerSourceUnit: null,
        },
        quality: "auto",
        semanticProxyIds: [],
      },
      placement: {
        space: "world3d",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    }]));

    const serializer = new WorkspaceProjectSerializer();
    const saved = serializer.serialize(serializer.fromStore("project_reality", store));
    expect(saved).toContain(candidate.descriptor.digest);
    expect(saved).not.toContain("private-field-capture.ply");
    expect(saved).not.toContain("end_header");

    const reopened = serializer.openStore(serializer.deserialize(saved));
    expect(reopened.getState().realityAssets.get(candidate.descriptor.assetId)).toEqual(candidate.descriptor);
    expect(reopened.getState().components.get("CMP_REALITY")?.props.assetRef).toEqual({
      assetId: candidate.descriptor.assetId,
      digest: candidate.descriptor.digest,
    });
    const otherBrowserVault = new MemoryAssetVault();
    expect(await otherBrowserVault.has(candidate.descriptor.assetId)).toBe(false);
    vault.dispose();
    otherBrowserVault.dispose();
  });

  it("opens the Reality surface from WorkspaceChrome and starts an import", async () => {
    const user = userEvent.setup();
    const onImport = vi.fn();
    render(<WorkspaceChrome
      catalog={[]}
      sources={[]}
      realityAssets={[]}
      onImportRealityAsset={onImport}
      onCreate={vi.fn()}
      onUpdate={vi.fn()}
      onAction={vi.fn()}
      onCreateShowcase={vi.fn()}
    />);

    await user.click(screen.getByRole("button", { name: "Reality" }));
    expect(screen.getByRole("region", { name: "reality panel" })).toBeVisible();
    expect(screen.getByRole("complementary", { name: "Reality assets" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Import Reality asset" }));
    expect(onImport).toHaveBeenCalledOnce();
  });

  it("hides the Inspector while picking and restores it with the completed calibration draft", async () => {
    const user = userEvent.setup();
    const onStartMeasurement = vi.fn(() => true);
    const chrome = (measurement?: RealityMeasurementEvent) => <WorkspaceChrome
      catalog={[]}
      selected={splatComponent()}
      sources={[]}
      realityAssets={[]}
      realityMeasurement={measurement}
      onStartRealityMeasurement={onStartMeasurement}
      onCreate={vi.fn()}
      onUpdate={vi.fn()}
      onAction={vi.fn()}
      onCreateShowcase={vi.fn()}
    />;
    const view = render(chrome());

    await user.click(screen.getByRole("button", { name: "Inspector" }));
    await user.click(screen.getByRole("button", { name: "Pick two points" }));
    expect(onStartMeasurement).toHaveBeenCalledWith("CMP_REALITY");
    expect(screen.queryByRole("region", { name: "inspector panel" })).not.toBeInTheDocument();

    view.rerender(chrome({
      kind: "point",
      componentId: "CMP_REALITY",
      assetId,
      assetDigest: digest,
      sessionId: 13,
      pointIndex: 1,
      point: {
        sourcePoint: { x: 0, y: 0, z: 0 },
        worldPoint: { x: 0, y: 0, z: 0 },
        cameraDistance: 5,
        fidelity: "gaussian-lod",
      },
    }));
    expect(screen.queryByRole("region", { name: "inspector panel" })).not.toBeInTheDocument();
    expect(screen.getByText(/Point A captured/)).toHaveClass("sr-only");

    view.rerender(chrome({
      kind: "complete",
      componentId: "CMP_REALITY",
      assetId,
      assetDigest: digest,
      sessionId: 13,
      points: [{
        sourcePoint: { x: 0, y: 0, z: 0 },
        worldPoint: { x: 0, y: 0, z: 0 },
        cameraDistance: 5,
        fidelity: "gaussian-lod",
      }, {
        sourcePoint: { x: 3, y: 4, z: 0 },
        worldPoint: { x: 0.3, y: 0.4, z: 0 },
        cameraDistance: 5,
        fidelity: "gaussian-lod",
      }],
      sourceDistance: 5,
      displayedDistance: 0.5,
      fidelity: "gaussian-lod",
    }));

    expect(await screen.findByRole("region", { name: "inspector panel" })).toBeVisible();
    const measuredSourceDistance = screen.getByRole("spinbutton", { name: "Source distance" });
    expect(measuredSourceDistance).toHaveValue(5);
    expect(measuredSourceDistance).toBeDisabled();
    const completedStatuses = screen.getAllByText(/Measured 5 source units/);
    expect(completedStatuses).toHaveLength(1);
    expect(completedStatuses[0]).not.toHaveClass("sr-only");
  });

  it("offers exact-content relink for missing bytes and confirms unreferenced deletion", async () => {
    const user = userEvent.setup();
    const onRelink = vi.fn();
    const onDelete = vi.fn(() => true);
    const view = render(<WorkspaceRealityAssets
      items={[{ descriptor: descriptor(), availability: "missing", componentIds: ["CMP_REALITY"] }]}
      onRelink={onRelink}
      onDelete={onDelete}
      onSelectComponent={vi.fn()}
    />);

    expect(screen.getByText("Local bytes missing")).toBeVisible();
    expect(screen.getByText("Visual only")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Relink same asset…" }));
    expect(onRelink).toHaveBeenCalledWith(assetId);
    expect(screen.queryByRole("button", { name: "Remove unreferenced asset…" })).not.toBeInTheDocument();

    view.rerender(<WorkspaceRealityAssets
      items={[{ descriptor: descriptor(), availability: "available", componentIds: [] }]}
      onRelink={onRelink}
      onDelete={onDelete}
    />);
    await user.click(screen.getByRole("button", { name: "Remove unreferenced asset…" }));
    expect(screen.getByRole("alertdialog", { name: "Remove Reality asset" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Confirm remove" }));
    expect(onDelete).toHaveBeenCalledWith(assetId);
  });

  it("commits reference calibration, render quality, and engineering proxies together", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    render(<WorkspaceInspector
      component={splatComponent()}
      realityProxyOptions={[
        { id: "CMP_POLE_PROXY", label: "Pole collision proxy" },
        { id: "CMP_WIRE_PROXY", label: "Wire clearance proxy" },
      ]}
      onUpdate={onUpdate}
    />);

    expect(screen.getByText(/never collision, physics, CAD, or feasibility authority/i)).toBeVisible();
    await user.selectOptions(screen.getByRole("combobox", { name: "Render quality" }), "high");
    await user.selectOptions(screen.getByRole("combobox", { name: "Calibration" }), "reference-distance");
    const source = screen.getByRole("spinbutton", { name: "Source distance" });
    await user.clear(source);
    await user.type(source, "250");
    const real = screen.getByRole("spinbutton", { name: "Real distance (m)" });
    await user.clear(real);
    await user.type(real, "2.5");
    await user.click(screen.getByRole("checkbox", { name: "Pole collision proxy" }));
    await user.click(screen.getByRole("button", { name: "Apply Reality settings" }));

    expect(onUpdate).toHaveBeenCalledWith({
      componentId: "CMP_REALITY",
      props: {
        assetRef: { assetId, digest },
        calibration: {
          version: 1,
          status: "reference-distance",
          sourceCoordinateSystem: "RUB",
          targetCoordinateSystem: "RUB",
          metersPerSourceUnit: 0.01,
          sourceDistance: 250,
          referenceDistanceM: 2.5,
        },
        quality: "high",
        semanticProxyIds: ["CMP_POLE_PROXY"],
      },
    });
  });

  it("turns a two-point Gaussian surface pick into one reference-distance calibration draft", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    const onStartMeasurement = vi.fn(() => true);
    const onCancelMeasurement = vi.fn();
    const component = splatComponent();
    const view = render(<WorkspaceInspector
      component={component}
      onUpdate={onUpdate}
      onStartRealityMeasurement={onStartMeasurement}
      onCancelRealityMeasurement={onCancelMeasurement}
    />);

    expect(screen.getByText(/Gaussian LOD surface as a visual estimate/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Pick two points" }));
    expect(onStartMeasurement).toHaveBeenCalledWith("CMP_REALITY");

    view.rerender(<WorkspaceInspector
      component={component}
      onUpdate={onUpdate}
      onStartRealityMeasurement={onStartMeasurement}
      onCancelRealityMeasurement={onCancelMeasurement}
      realityMeasurement={{
        kind: "point",
        componentId: "CMP_REALITY",
        assetId,
        assetDigest: digest,
        sessionId: 7,
        pointIndex: 1,
        point: {
          sourcePoint: { x: 1, y: 2, z: 3 },
          worldPoint: { x: 4, y: 5, z: 6 },
          cameraDistance: 8,
          fidelity: "gaussian-lod",
        },
      }}
    />);
    expect(screen.getByText(/Point A captured/)).toBeVisible();

    view.rerender(<WorkspaceInspector
      component={component}
      onUpdate={onUpdate}
      onStartRealityMeasurement={onStartMeasurement}
      onCancelRealityMeasurement={onCancelMeasurement}
      realityMeasurement={{
        kind: "complete",
        componentId: "CMP_REALITY",
        assetId,
        assetDigest: digest,
        sessionId: 7,
        points: [{
          sourcePoint: { x: 1, y: 2, z: 3 },
          worldPoint: { x: 4, y: 5, z: 6 },
          cameraDistance: 8,
          fidelity: "gaussian-lod",
        }, {
          sourcePoint: { x: 4, y: 6, z: 3 },
          worldPoint: { x: 4.3, y: 5.4, z: 6 },
          cameraDistance: 8,
          fidelity: "gaussian-lod",
        }],
        sourceDistance: 5,
        displayedDistance: 0.5,
        fidelity: "gaussian-lod",
      }}
    />);

    expect(screen.getByRole("combobox", { name: "Calibration" })).toHaveValue("reference-distance");
    const measuredSource = screen.getByRole("spinbutton", { name: "Source distance" });
    expect(measuredSource).toHaveValue(5);
    expect(measuredSource).toBeDisabled();
    expect(screen.getByText(/Measured 5 source units/)).toBeVisible();
    let realDistance = screen.getByRole("spinbutton", { name: "Real distance (m)" });
    const apply = screen.getByRole("button", { name: "Apply Reality settings" });
    expect(realDistance).toHaveValue(null);
    await waitFor(() => expect(realDistance).toHaveFocus());
    expect(apply).toBeDisabled();

    // Button state is not the security boundary: a programmatic form submit
    // must also fail closed until this exact measurement session receives a
    // real user input change.
    fireEvent.submit(apply.closest("form")!);
    expect(screen.getByRole("alert")).toHaveTextContent(/known real distance/i);
    expect(onUpdate).not.toHaveBeenCalled();

    // Changing the calibration selector must not turn an unfinished A/B
    // session into an escape hatch. The explicit Clear markers action is the
    // only way to abandon this span and restore persisted settings.
    await user.selectOptions(screen.getByRole("combobox", { name: "Calibration" }), "uncalibrated");
    expect(apply).toBeDisabled();
    fireEvent.submit(apply.closest("form")!);
    expect(screen.getByRole("alert")).toHaveTextContent(/clear its markers/i);
    expect(onUpdate).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByRole("combobox", { name: "Calibration" }), "reference-distance");
    realDistance = screen.getByRole("spinbutton", { name: "Real distance (m)" });

    // Even a synthetic DOM mutation cannot replace the measured span: the
    // persisted calibration must use the immutable A/B receipt in state.
    fireEvent.change(measuredSource, { target: { value: "999" } });
    await user.type(realDistance, "2");
    expect(apply).toBeEnabled();
    await user.click(apply);

    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onUpdate.mock.calls[0]?.[0].props.calibration).toEqual({
      version: 1,
      status: "reference-distance",
      sourceCoordinateSystem: "RUB",
      targetCoordinateSystem: "RUB",
      metersPerSourceUnit: 0.4,
      sourceDistance: 5,
      referenceDistanceM: 2,
    });
    expect(onCancelMeasurement).toHaveBeenCalledOnce();
  });

  it("keeps the completed A/B receipt when the Workspace rejects the settings write", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn(() => false);
    const onCancelMeasurement = vi.fn();
    render(<WorkspaceInspector
      component={splatComponent()}
      onUpdate={onUpdate}
      onStartRealityMeasurement={() => true}
      onCancelRealityMeasurement={onCancelMeasurement}
      realityMeasurement={{
        kind: "complete",
        componentId: "CMP_REALITY",
        assetId,
        assetDigest: digest,
        sessionId: 72,
        points: [{
          sourcePoint: { x: 0, y: 0, z: 0 },
          worldPoint: { x: 0, y: 0, z: 0 },
          cameraDistance: 5,
          fidelity: "gaussian-lod",
        }, {
          sourcePoint: { x: 0, y: 5, z: 0 },
          worldPoint: { x: 0, y: 0.5, z: 0 },
          cameraDistance: 5,
          fidelity: "gaussian-lod",
        }],
        sourceDistance: 5,
        displayedDistance: 0.5,
        fidelity: "gaussian-lod",
      }}
    />);

    const realDistance = screen.getByRole("spinbutton", { name: "Real distance (m)" });
    await waitFor(() => expect(realDistance).toHaveFocus());
    await user.type(realDistance, "2");
    await user.click(screen.getByRole("button", { name: "Apply Reality settings" }));

    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onCancelMeasurement).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/measurement is still available/i);
    expect(screen.getByText(/Measured 5 source units/)).toBeVisible();
  });

  it("restores persisted calibration after an unapplied measurement is cancelled", async () => {
    const user = userEvent.setup();
    const base = splatComponent();
    const component: WorkspaceRenderComponent = {
      ...base,
      props: {
        ...base.props,
        calibration: {
          version: 1,
          status: "reference-distance",
          sourceCoordinateSystem: "RUB",
          targetCoordinateSystem: "RUB",
          metersPerSourceUnit: 0.01,
          sourceDistance: 250,
          referenceDistanceM: 2.5,
        },
      },
    };
    const complete: RealityMeasurementEvent = {
      kind: "complete",
      componentId: "CMP_REALITY",
      assetId,
      assetDigest: digest,
      sessionId: 71,
      points: [{
        sourcePoint: { x: 0, y: 0, z: 0 },
        worldPoint: { x: 0, y: 0, z: 0 },
        cameraDistance: 5,
        fidelity: "gaussian-lod",
      }, {
        sourcePoint: { x: 3, y: 4, z: 0 },
        worldPoint: { x: 0.3, y: 0.4, z: 0 },
        cameraDistance: 5,
        fidelity: "gaussian-lod",
      }],
      sourceDistance: 5,
      displayedDistance: 0.5,
      fidelity: "gaussian-lod",
    };
    const view = render(<WorkspaceInspector
      component={component}
      onUpdate={vi.fn()}
      onStartRealityMeasurement={() => true}
      realityMeasurement={complete}
    />);

    const measuredRealDistance = screen.getByRole("spinbutton", { name: "Real distance (m)" });
    await waitFor(() => expect(measuredRealDistance).toHaveValue(null));
    await user.type(measuredRealDistance, "9");
    expect(measuredRealDistance).toHaveValue(9);

    view.rerender(<WorkspaceInspector
      component={component}
      onUpdate={vi.fn()}
      onStartRealityMeasurement={() => true}
      realityMeasurement={{
        kind: "cancelled",
        componentId: "CMP_REALITY",
        assetId,
        assetDigest: digest,
        sessionId: 71,
      }}
    />);

    await waitFor(() => {
      expect(screen.getByRole("spinbutton", { name: "Source distance" })).toHaveValue(250);
      expect(screen.getByRole("spinbutton", { name: "Real distance (m)" })).toHaveValue(2.5);
    });
  });

  it("keeps a missed Gaussian pick ephemeral and lets the user cancel without a Workspace write", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    const onCancelMeasurement = vi.fn();
    render(<WorkspaceInspector
      component={splatComponent()}
      onUpdate={onUpdate}
      onStartRealityMeasurement={() => true}
      onCancelRealityMeasurement={onCancelMeasurement}
      realityMeasurement={{
        kind: "miss",
        componentId: "CMP_REALITY",
        assetId,
        assetDigest: digest,
        sessionId: 3,
        pickedPoints: 1,
        message: "No Gaussian surface was found there. Click a visible part of the capture.",
      }}
    />);

    expect(screen.getByText(/No Gaussian surface was found/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancelMeasurement).toHaveBeenCalledOnce();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("keeps a completed source span immutable but rejects it after rebinding to different bytes", () => {
    const component = splatComponent();
    const completedMeasurement = {
      kind: "complete",
      componentId: "CMP_REALITY",
      assetId,
      assetDigest: digest,
      sessionId: 9,
      points: [{
        sourcePoint: { x: 0, y: 0, z: 0 },
        worldPoint: { x: 0, y: 0, z: 0 },
        cameraDistance: 4,
        fidelity: "gaussian-lod",
      }, {
        sourcePoint: { x: 5, y: 0, z: 0 },
        worldPoint: { x: 5, y: 0, z: 0 },
        cameraDistance: 4,
        fidelity: "gaussian-lod",
      }],
      sourceDistance: 5,
      displayedDistance: 5,
      fidelity: "gaussian-lod",
    } satisfies RealityMeasurementEvent;
    const view = render(<WorkspaceInspector
      component={component}
      onUpdate={vi.fn()}
      onStartRealityMeasurement={() => true}
      realityMeasurement={completedMeasurement}
    />);

    const measuredSource = screen.getByRole("spinbutton", { name: "Source distance" });
    expect(measuredSource).toHaveValue(5);
    expect(measuredSource).toBeDisabled();
    view.rerender(<WorkspaceInspector
      component={{
        ...component,
        props: {
          ...component.props,
          assetRef: { assetId: replacementAssetId, digest: replacementDigest },
        },
      }}
      onUpdate={vi.fn()}
      onStartRealityMeasurement={() => true}
      realityMeasurement={completedMeasurement}
    />);

    expect(screen.getByRole("combobox", { name: "Calibration" })).toHaveValue("uncalibrated");
    expect(screen.queryByRole("spinbutton", { name: "Source distance" })).not.toBeInTheDocument();
    expect(screen.getByText(/Ready to pick a known span/)).toBeVisible();
  });

  it("resets an unapplied completed draft when a fresh measurement session starts", () => {
    const component = splatComponent();
    const view = render(<WorkspaceInspector
      component={component}
      onUpdate={vi.fn()}
      onStartRealityMeasurement={() => true}
      realityMeasurement={{
        kind: "complete",
        componentId: "CMP_REALITY",
        assetId,
        assetDigest: digest,
        sessionId: 10,
        points: [{
          sourcePoint: { x: 0, y: 0, z: 0 },
          worldPoint: { x: 0, y: 0, z: 0 },
          cameraDistance: 4,
          fidelity: "gaussian-lod",
        }, {
          sourcePoint: { x: 3, y: 4, z: 0 },
          worldPoint: { x: 3, y: 4, z: 0 },
          cameraDistance: 4,
          fidelity: "gaussian-lod",
        }],
        sourceDistance: 5,
        displayedDistance: 5,
        fidelity: "gaussian-lod",
      }}
    />);
    expect(screen.getByRole("spinbutton", { name: "Source distance" })).toHaveValue(5);

    view.rerender(<WorkspaceInspector
      component={component}
      onUpdate={vi.fn()}
      onStartRealityMeasurement={() => true}
      realityMeasurement={{
        kind: "started",
        componentId: "CMP_REALITY",
        assetId,
        assetDigest: digest,
        sessionId: 11,
      }}
    />);

    expect(screen.getByRole("combobox", { name: "Calibration" })).toHaveValue("uncalibrated");
    expect(screen.queryByRole("spinbutton", { name: "Source distance" })).not.toBeInTheDocument();
    expect(screen.getByText(/Pick point A on the visible Gaussian surface/)).toBeVisible();
  });

  it("does not claim metric calibration while source coordinates remain unknown", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    const component = splatComponent();
    render(<WorkspaceInspector
      component={{
        ...component,
        props: {
          ...component.props,
          calibration: {
            version: 1,
            status: "uncalibrated",
            sourceCoordinateSystem: "UNKNOWN",
            targetCoordinateSystem: "RUB",
            metersPerSourceUnit: null,
          },
        },
      }}
      onUpdate={onUpdate}
    />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Calibration" }), "metadata-declared");
    await user.click(screen.getByRole("button", { name: "Apply Reality settings" }));
    expect(screen.getByRole("alert")).toHaveTextContent("source coordinate system");
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
