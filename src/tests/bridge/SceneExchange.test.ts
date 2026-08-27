import { describe, expect, it } from "vitest";
import {
  approvedBridgeChangesToWorkspaceOperations,
  createSemaFrameExchange,
  parseSemaFrameBridgeChangeProposal,
  reviewSemaFrameBridgeProposal,
  SEMAFRAME_CHANGE_PROPOSAL_FORMAT,
  SEMAFRAME_CHANGE_PROPOSAL_VERSION,
} from "../../bridge";
import { DEFAULT_COMPONENT_REGISTRY, type JSONObject } from "../../workspace/components";
import { prepareComponentRecipe } from "../../workspace/protocol";
import { WorkspaceStore, type WorkspaceState } from "../../workspace/state";
import { workspaceBatch } from "../workspace/helpers";

function placement(x: number, y = 0, z = 0) {
  return {
    space: "world3d" as const,
    position: { x, y, z },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  };
}

function populatedStore(): WorkspaceStore {
  const store = new WorkspaceStore();
  store.apply(workspaceBatch(store, "exchange_fixture", [
    {
      op: "create_component",
      op_id: "stage",
      id: "STAGE",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"),
      placement: placement(0),
    },
    {
      op: "create_component",
      op_id: "cube",
      id: "CUBE",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("spatial-primitive"),
      placement: placement(2, 0.5, -3),
      props: {
        geometry: { kind: "box", sizeM: { x: 1, y: 1, z: 1 } } as unknown as JSONObject,
        material: {
          baseColor: "#ff8844",
          metallic: 0.1,
          roughness: 0.4,
          opacity: 1,
          emissiveColor: "#000000",
          emissiveIntensity: 0,
        },
      },
      tags: ["demo", "physical"],
    },
    {
      op: "create_component",
      op_id: "panel",
      id: "PANEL",
      component_type: DEFAULT_COMPONENT_REGISTRY.ref("panel"),
      placement: { space: "canvas2d", position: { x: 40, y: 60 }, size: { width: 320, height: 180 } },
      props: { title: "Control" },
    },
  ]));
  return store;
}

function proposal(workspaceId: string, revision: number, digest: `sha256:${string}`) {
  return {
    format: SEMAFRAME_CHANGE_PROPOSAL_FORMAT,
    version: SEMAFRAME_CHANGE_PROPOSAL_VERSION,
    proposalId: "blender-edit-1",
    target: "blender",
    source: {
      workspaceId,
      baseRevision: revision,
      exchangeDigest: digest,
    },
    changes: [{
      changeId: "move-cube",
      kind: "transform",
      componentId: "CUBE",
      placement: placement(4, 0.5, -3),
      transition: { durationMs: 300, easing: "ease_in_out" },
    }],
    note: "Move the selected cube in Blender.",
  };
}

describe("SemaFrame Scene Exchange", () => {
  it("exports deterministic valid OpenUSD, GLB and semantic metadata without host secrets", async () => {
    const store = populatedStore();
    const schemaRecipe = prepareComponentRecipe({
      typeId: "recipe.bridge-schema",
      version: "1.0.0",
      displayName: "Bridge schema fixture",
      allowedPlacements: ["canvas2d"],
      propsSchema: { type: "object", additionalProperties: false },
      durableStateSchema: { type: "object", additionalProperties: false },
      defaultProps: {},
      defaultDurableState: {},
      writableProps: [],
      actions: {
        submit: {
          effectClass: "semantic",
          inputSchema: {
            type: "object",
            description: "Bearer action-secret-value from /Users/example/action",
            default: { password: "action-password" },
            examples: [{ localPath: "/Users/example/action" }],
            properties: {
              count: { type: "number", description: "Bearer hidden-action-token" },
              mode: { const: "canvas" },
            },
          },
        },
      },
      events: {
        submitted: {
          type: "object",
          title: "Event payload from /Users/example/event",
          examples: [{ token: "event-secret-value" }],
          properties: { ok: { type: "boolean", default: true } },
        },
      },
      root: { id: "root", primitive: "text" },
    });
    store.apply(workspaceBatch(store, "schema_fixture", [{
      op: "define_component_recipe",
      op_id: "define_schema_recipe",
      recipe: schemaRecipe,
    }, {
      op: "create_component",
      op_id: "create_schema_component",
      id: "SCHEMA_COMPONENT",
      component_type: {
        typeId: schemaRecipe.typeId,
        version: schemaRecipe.version,
        digest: schemaRecipe.digest,
      },
      placement: { space: "canvas2d", position: { x: 420, y: 60 }, size: { width: 240, height: 144 } },
    }]));
    const state = store.getState() as WorkspaceState;
    state.resources.set("PRIVATE_FEED", {
      id: "PRIVATE_FEED",
      label: "Private feed",
      connectorType: "http.feed",
      connectorVersion: "1.0.0",
      outputSchema: {
        type: "object",
        description: "Private schema at /Users/example/schema",
        default: { apiKey: "ghp_resource-secret-value" },
        examples: [{ path: "/Users/example/schema" }],
        properties: {
          value: { type: "number", description: "Bearer resource-secret-value" },
          mode: { enum: ["safe", "/Users/example/private-schema"] },
          stable: { const: "canvas" },
          volume: { const: "/Volumes/example/private.usd" },
          endpoint: { const: "http://[fe80::1]/private-feed" },
        },
      },
      config: { url: "https://secret.invalid/account" },
      secretRef: "vault://super-secret",
      policy: { mode: "manual", offline: "keep_last_good" },
      snapshot: {
        data: { token: "do-not-export" },
        contentHash: "private-hash",
        retrievedAt: "2026-08-27T00:00:00.000Z",
        stale: false,
        provenance: [],
      },
      status: "ready",
      lastError: "local /Users/example/private path",
    });
    const first = await createSemaFrameExchange(state, {
      generatorVersion: "test",
      exactStep: { bytes: new TextEncoder().encode("ISO-10303-21;END-ISO-10303-21;"), componentIds: ["CUBE"] },
    });
    const second = await createSemaFrameExchange(state, {
      generatorVersion: "test",
      exactStep: { bytes: new TextEncoder().encode("ISO-10303-21;END-ISO-10303-21;"), componentIds: ["CUBE"] },
    });
    const privateVariant = structuredClone(state);
    const privateFeed = privateVariant.resources.get("PRIVATE_FEED")!;
    privateVariant.resources.set("PRIVATE_FEED", {
      ...privateFeed,
      config: { url: "https://different-secret.invalid/account" },
      secretRef: "vault://different-private-secret",
      snapshot: privateFeed.snapshot ? {
        ...privateFeed.snapshot,
        data: { token: "another-private-token" },
      } : undefined,
    });
    const sanitizedVariant = await createSemaFrameExchange(privateVariant, {
      generatorVersion: "test",
      exactStep: { bytes: new TextEncoder().encode("ISO-10303-21;END-ISO-10303-21;"), componentIds: ["CUBE"] },
    });

    expect(first.archive.sha256).toBe(second.archive.sha256);
    expect(first.archive.bytes).toEqual(second.archive.bytes);
    expect(first.manifest.source.workspaceDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(sanitizedVariant.manifest.source.workspaceDigest).toBe(first.manifest.source.workspaceDigest);
    expect(new DataView(first.archive.bytes.buffer, first.archive.bytes.byteOffset).getUint32(0, true)).toBe(0x04034b50);
    const glb = first.files.find((entry) => entry.path === "geometry.glb");
    expect(glb).toBeDefined();
    expect(new DataView(glb!.bytes.buffer, glb!.bytes.byteOffset).getUint32(0, true)).toBe(0x46546c67);
    expect(new DataView(glb!.bytes.buffer, glb!.bytes.byteOffset).getUint32(4, true)).toBe(2);
    const usda = new TextDecoder().decode(first.files.find((entry) => entry.path === "scene.usda")!.bytes);
    expect(usda).toContain("#usda 1.0");
    expect(usda).toContain('metersPerUnit = 1');
    expect(first.manifest.nodes.find((node) => node.stableId === "CUBE")).toMatchObject({
      representation: "exact_brep",
      gltfNodeIndex: expect.any(Number),
      usdPrimPath: expect.any(String),
    });
    expect(first.manifest.nodes.find((node) => node.stableId === "PANEL")).toMatchObject({
      representation: "semantic_only",
      placement: { space: "canvas2d" },
    });
    expect(first.manifest.resources).toEqual([expect.objectContaining({
      id: "PRIVATE_FEED",
      exportedData: false,
      outputSchema: {
        type: "object",
        properties: {
          value: { type: "number" },
          mode: {},
          stable: { const: "canvas" },
          volume: {},
          endpoint: {},
        },
      },
    })]);
    const exportedResourceSchema = first.manifest.resources[0]!.outputSchema;
    expect(Object.isFrozen(exportedResourceSchema)).toBe(true);
    expect(Object.isFrozen(exportedResourceSchema.properties)).toBe(true);
    const exportedSchemaNode = first.manifest.nodes.find((node) => node.stableId === "SCHEMA_COMPONENT")!;
    expect(exportedSchemaNode).toMatchObject({
      actions: [{
        name: "submit",
        inputSchema: {
          type: "object",
          properties: { count: { type: "number" }, mode: { const: "canvas" } },
        },
      }],
      events: [{
        name: "submitted",
        payloadSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      }],
    });
    expect(Object.isFrozen(exportedSchemaNode.actions[0]!.inputSchema)).toBe(true);
    expect(Object.isFrozen(exportedSchemaNode.events[0]!.payloadSchema)).toBe(true);
    const archiveText = new TextDecoder().decode(first.archive.bytes);
    expect(archiveText).not.toContain("secret.invalid");
    expect(archiveText).not.toContain("super-secret");
    expect(archiveText).not.toContain("do-not-export");
    expect(archiveText).not.toContain("/Users/example/private");
    expect(archiveText).not.toContain("/Users/example/schema");
    expect(archiveText).not.toContain("/Volumes/example");
    expect(archiveText).not.toContain("fe80::1");
    expect(archiveText).not.toContain("action-secret-value");
    expect(archiveText).not.toContain("action-password");
    expect(archiveText).not.toContain("event-secret-value");
    expect(archiveText).not.toContain("resource-secret-value");
    expect(first.report.summary).toEqual({ exact: 1, parametric: 0, visual: 0, semantic: 3 });
  });

  it("keeps downstream edits reviewable and routes approved changes back through WorkspaceStore", async () => {
    const store = populatedStore();
    const exchange = await createSemaFrameExchange(store.getState() as WorkspaceState, { generatorVersion: "test" });
    const value = proposal(store.getState().workspaceId, store.getRevision(), exchange.archive.sha256);
    const review = reviewSemaFrameBridgeProposal(value, store.getState() as WorkspaceState, {
      expectedExchangeDigest: exchange.archive.sha256,
    });
    expect(review).toMatchObject({
      status: "review_required",
      stale: false,
      eligibleChangeIds: ["move-cube"],
      ineligibleChangeIds: [],
    });
    const reviewedTransform = review.proposal.changes[0]!;
    if (reviewedTransform.kind !== "transform" || reviewedTransform.placement.space !== "world3d") {
      throw new Error("Expected a reviewed world3d transform");
    }
    expect(Reflect.set(reviewedTransform.placement.position, "x", 999)).toBe(false);
    expect(reviewedTransform.placement.position.x).toBe(4);
    expect(store.getState().components.get("CUBE")?.placement).toEqual(placement(2, 0.5, -3));
    const operations = approvedBridgeChangesToWorkspaceOperations(review, ["move-cube"]);
    store.apply(workspaceBatch(store, "approved_bridge_edit", [...operations]));
    expect(store.getState().components.get("CUBE")?.placement).toEqual(placement(4, 0.5, -3));
  });

  it("does not mark transform-embedded scale or size changes as committable placement edits", async () => {
    const store = populatedStore();
    const exchange = await createSemaFrameExchange(store.getState() as WorkspaceState, { generatorVersion: "test" });
    const resize3d = proposal(store.getState().workspaceId, store.getRevision(), exchange.archive.sha256);
    resize3d.changes[0] = {
      ...resize3d.changes[0],
      changeId: "resize-cube",
      placement: { ...placement(4, 0.5, -3), scale: { x: 2, y: 2, z: 2 } },
    };
    const cubeReview = reviewSemaFrameBridgeProposal(resize3d, store.getState() as WorkspaceState, {
      expectedExchangeDigest: exchange.archive.sha256,
    });
    expect(cubeReview.eligibleChangeIds).toEqual([]);
    expect(cubeReview.issues).toContainEqual(expect.objectContaining({
      changeId: "resize-cube",
      code: "resize_requires_separate_change",
    }));
    expect(() => approvedBridgeChangesToWorkspaceOperations(cubeReview, ["resize-cube"]))
      .toThrow(/not eligible/);

    const resize2d = {
      ...proposal(store.getState().workspaceId, store.getRevision(), exchange.archive.sha256),
      proposalId: "resize-panel-proposal",
      changes: [{
        changeId: "resize-panel",
        kind: "transform",
        componentId: "PANEL",
        placement: { space: "canvas2d", position: { x: 50, y: 70 }, size: { width: 640, height: 360 } },
      }],
    };
    const panelReview = reviewSemaFrameBridgeProposal(resize2d, store.getState() as WorkspaceState, {
      expectedExchangeDigest: exchange.archive.sha256,
    });
    expect(panelReview.eligibleChangeIds).toEqual([]);
    expect(panelReview.issues).toContainEqual(expect.objectContaining({
      changeId: "resize-panel",
      code: "resize_requires_separate_change",
    }));

    const noisyStore = populatedStore();
    const noisyExchange = await createSemaFrameExchange(noisyStore.getState() as WorkspaceState, {
      generatorVersion: "test",
    });
    const noisyProposal = {
      ...proposal(noisyStore.getState().workspaceId, noisyStore.getRevision(), noisyExchange.archive.sha256),
      proposalId: "float32-round-trip-noise",
      changes: [{
        changeId: "move-noisy-cube",
        kind: "transform",
        componentId: "CUBE",
        placement: {
          ...placement(4, 0.5, -3),
          scale: { x: 1 + 5e-7, y: 1 - 5e-7, z: 1 + 2e-7 },
        },
      }, {
        changeId: "move-noisy-panel",
        kind: "transform",
        componentId: "PANEL",
        placement: {
          space: "canvas2d",
          position: { x: 50, y: 70 },
          size: { width: 320 + 1e-4, height: 180 - 1e-4 },
        },
      }],
    };
    const noisyReview = reviewSemaFrameBridgeProposal(noisyProposal, noisyStore.getState() as WorkspaceState, {
      expectedExchangeDigest: noisyExchange.archive.sha256,
    });
    expect(noisyReview.eligibleChangeIds).toEqual(["move-noisy-cube", "move-noisy-panel"]);
    const noisyOperations = approvedBridgeChangesToWorkspaceOperations(noisyReview, noisyReview.eligibleChangeIds);
    expect(noisyOperations).toMatchObject([{
      op: "place_component",
      placement: { position: { x: 4 }, scale: { x: 1, y: 1, z: 1 } },
    }, {
      op: "place_component",
      placement: { position: { x: 50, y: 70 }, size: { width: 320, height: 180 } },
    }]);
    noisyStore.apply(workspaceBatch(noisyStore, "approved_float32_noise", [...noisyOperations]));
    expect(noisyStore.getState().components.get("CUBE")?.placement).toEqual(placement(4, 0.5, -3));
    expect(noisyStore.getState().components.get("PANEL")?.placement).toEqual({
      space: "canvas2d",
      position: { x: 50, y: 70 },
      size: { width: 320, height: 180 },
    });
  });

  it("reviews property changes with the same writable shallow-patch semantics used by WorkspaceStore", async () => {
    const store = populatedStore();
    const exchange = await createSemaFrameExchange(store.getState() as WorkspaceState, { generatorVersion: "test" });
    const currentMaterial = store.getState().components.get("CUBE")?.props.material as JSONObject;
    const materialProposal = {
      ...proposal(store.getState().workspaceId, store.getRevision(), exchange.archive.sha256),
      proposalId: "material-patch",
      changes: [{
        changeId: "repaint-cube",
        kind: "properties",
        componentId: "CUBE",
        props: { material: { ...currentMaterial, baseColor: "#3366ff" } },
      }],
    };
    const review = reviewSemaFrameBridgeProposal(materialProposal, store.getState() as WorkspaceState, {
      expectedExchangeDigest: exchange.archive.sha256,
    });
    expect(review.eligibleChangeIds).toEqual(["repaint-cube"]);
    const reviewedProperties = review.proposal.changes[0]!;
    if (reviewedProperties.kind !== "properties") throw new Error("Expected a reviewed property change");
    const reviewedMaterial = reviewedProperties.props.material as JSONObject;
    expect(Reflect.set(reviewedMaterial, "baseColor", "#ff0000")).toBe(false);
    expect(reviewedMaterial.baseColor).toBe("#3366ff");
    store.apply(workspaceBatch(store, "approved_material_edit", [
      ...approvedBridgeChangesToWorkspaceOperations(review, ["repaint-cube"]),
    ]));
    expect((store.getState().components.get("CUBE")?.props.material as JSONObject).baseColor).toBe("#3366ff");

    const nonWritable = {
      ...materialProposal,
      proposalId: "non-writable-patch",
      source: { ...materialProposal.source, baseRevision: store.getRevision() },
      changes: [{
        changeId: "private-field",
        kind: "properties",
        componentId: "CUBE",
        props: { internalOnly: true },
      }],
    };
    const rejected = reviewSemaFrameBridgeProposal(nonWritable, store.getState() as WorkspaceState, {
      expectedExchangeDigest: exchange.archive.sha256,
    });
    expect(rejected.issues).toContainEqual(expect.objectContaining({ code: "property_not_writable" }));
    expect(rejected.eligibleChangeIds).toEqual([]);
  });

  it("fails closed on stale exchanges, domain changes, unknown fields and unapproved changes", async () => {
    const store = populatedStore();
    const exchange = await createSemaFrameExchange(store.getState() as WorkspaceState, { generatorVersion: "test" });
    const staleValue = proposal(store.getState().workspaceId, store.getRevision() - 1, exchange.archive.sha256);
    const stale = reviewSemaFrameBridgeProposal(staleValue, store.getState() as WorkspaceState, {
      expectedExchangeDigest: exchange.archive.sha256,
    });
    expect(stale.stale).toBe(true);
    expect(() => approvedBridgeChangesToWorkspaceOperations(stale, [])).toThrow(/stale/);

    const crossDomain = proposal(store.getState().workspaceId, store.getRevision(), exchange.archive.sha256);
    crossDomain.changes[0] = {
      changeId: "move-cube",
      kind: "transform",
      componentId: "CUBE",
      placement: { space: "canvas2d", position: { x: 0, y: 0 } },
    } as never;
    const review = reviewSemaFrameBridgeProposal(crossDomain, store.getState() as WorkspaceState, {
      expectedExchangeDigest: exchange.archive.sha256,
    });
    expect(review.eligibleChangeIds).toEqual([]);
    expect(review.issues).toContainEqual(expect.objectContaining({ code: "placement_domain_change" }));
    expect(() => approvedBridgeChangesToWorkspaceOperations(review, ["move-cube"]))
      .toThrow(/not eligible/);

    expect(() => parseSemaFrameBridgeChangeProposal({
      ...proposal(store.getState().workspaceId, store.getRevision(), exchange.archive.sha256),
      surprise: true,
    }))
      .toThrow(/not part of the contract/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => parseSemaFrameBridgeChangeProposal(cyclic)).toThrow(/acyclic JSON/);
  });

  it("rejects empty, duplicate, or non-world exact STEP mappings", async () => {
    const state = populatedStore().getState() as WorkspaceState;
    await expect(createSemaFrameExchange(state, {
      exactStep: { bytes: new Uint8Array(), componentIds: ["CUBE"] },
    })).rejects.toThrow(/must contain bytes/);
    await expect(createSemaFrameExchange(state, {
      exactStep: { bytes: new Uint8Array([1]), componentIds: ["CUBE", "CUBE"] },
    })).rejects.toThrow(/duplicate component IDs/);
    await expect(createSemaFrameExchange(state, {
      exactStep: { bytes: new Uint8Array([1]), componentIds: ["PANEL"] },
    })).rejects.toThrow(/requires a world3d component/);
  });
});
