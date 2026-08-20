import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceChrome,
  WorkspaceInspector,
  WorkspaceRealityAssets,
} from "../../app/components/workspace";
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
