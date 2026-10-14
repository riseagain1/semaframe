// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { WorkspaceStoreEngineAdapter } from "../../../workspace/agents/WorkspaceStoreEngineAdapter";
import type { WorkspaceAgentPrincipal, WorkspacePreparedUpdate } from "../../../workspace/agents/contracts";
import { DEFAULT_COMPONENT_REGISTRY } from "../../../workspace/components";
import type { ComponentPlacement, JSONObject } from "../../../workspace/components/componentTypes";
import type { RuntimeViewContext } from "../../../workspace/layout/runtimeView";
import { DEFAULT_CAD_SKETCH_PLANE, cadLengthExpression, defaultCadPartDefinition, type CadPartDefinitionV1 } from "../../../workspace/modeling/cad";
import { loadCadKernel, type CadKernel } from "../../../workspace/modeling/cadKernel";
import { WorkspaceProjectSerializer } from "../../../workspace/persistence";
import type { WorkspaceOperation } from "../../../workspace/protocol";
import { WorkspaceStore } from "../../../workspace/state";
import { workspaceBatch } from "../../workspace/helpers";

const principal: WorkspaceAgentPrincipal = {
  sessionId: "runtime_session", clientId: "runtime_client", clientName: "Runtime layout tests",
  scopes: ["workspace:read", "workspace:write", "workspace:history", "component:create", "component:update", "component:invoke", "event:connect"],
};
const type = DEFAULT_COMPONENT_REGISTRY.ref("button");
const top = (y = 0): ComponentPlacement => ({ space: "viewport", anchor: "top_left", offset: { x: 0, y }, size: { width: 160, height: 48 } });
const bottom: ComponentPlacement = { space: "viewport", anchor: "bottom_left", offset: { x: 0, y: 0 }, size: { width: 160, height: 48 } };
const world: ComponentPlacement = { space: "world3d", position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
const create = (id: string, placement = top()): WorkspaceOperation => ({ op: "create_component", op_id: `create_${id}`, id, component_type: type, placement });
const batch = (prepared: WorkspacePreparedUpdate, operations: WorkspaceOperation[]) => ({ ...prepared.envelope, operations });

function setup(cadKernelFactory?: () => Promise<CadKernel>) {
  const store = new WorkspaceStore();
  let epoch = 1;
  let available = true;
  let status: RuntimeViewContext["status"] = "ready";
  let revisionOffset = 0;
  let occluders: RuntimeViewContext["occluders"] = [];
  const context = (): RuntimeViewContext | null => available ? {
    viewId: "test-desktop", epoch, workspaceId: store.getState().workspaceId,
    workspaceRevision: store.getRevision() + revisionOffset, sampledAt: Date.now(), status,
    viewport: { width: 501, height: 639 }, canvasView: { pan: { x: 0, y: 0 }, zoom: 1 },
    camera: { position: { x: 7, y: 5, z: 9 }, target: { x: 0, y: 0, z: 0 }, fovDeg: 45 }, occluders,
  } : null;
  const adapter = new WorkspaceStoreEngineAdapter(store, { getRuntimeView: context, cadKernelFactory });
  return { store, adapter, context, changeView: () => { epoch += 1; },
    setAvailable: (value: boolean) => { available = value; },
    setStatus: (value: RuntimeViewContext["status"]) => { status = value; },
    setRevisionOffset: (value: number) => { revisionOffset = value; },
    setOccluders: (value: RuntimeViewContext["occluders"]) => { occluders = value; },
  };
}

describe("runtime view through the authoritative agent adapter", () => {
  it("rejects the 501x639 full-overlap counterexample while reporting the canonical pass separately", async () => {
    const { store, adapter } = setup();
    store.apply(workspaceBatch(store, "seed", [create("A", top(551))]));
    const check = await adapter.queryLayoutPlacement({ component_type: type, placement: bottom }, principal);
    expect(check.placementCheck).toMatchObject({ valid: false, canonical_valid: true, current_view_valid: false,
      issues: [expect.objectContaining({ kind: "layout_overlap", overlap_area: 7_680 })] });
    expect(store.getRevision()).toBe(1);
    expect((await adapter.queryLayoutPlacement({ component_type: type, placement: bottom }, principal, { frame: "canonical" })).placementCheck)
      .toMatchObject({ valid: true, canonical_valid: true, current_view_valid: false });
  });

  it("does not invent a visual pass without a renderer or a new candidate's type", async () => {
    const { adapter, setAvailable } = setup();
    expect((await adapter.queryLayoutPlacement({ placement: top() }, principal)).placementCheck)
      .toMatchObject({ valid: null, reason: "candidate_component_type_required" });
    setAvailable(false);
    expect((await adapter.queryLayoutPlacement({ component_type: type, placement: top() }, principal)).placementCheck)
      .toMatchObject({ canonical_valid: true, current_view_valid: null, valid: null });
    expect((await adapter.queryLayoutPlacement({ placement: top() }, principal, { frame: "canonical" })).placementCheck)
      .toMatchObject({ valid: true, current_view_valid: null });
  });

  it("validates exact type bindings and refuses a 3D type in a UI query", async () => {
    const { adapter } = setup();
    for (const binding of [{ ...type, digest: "wrong" }, DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"), { typeId: "button" }]) {
      await expect(adapter.queryLayoutPlacement({ component_type: binding, placement: top() }, principal))
        .rejects.toMatchObject({ code: "invalid_layout_candidate" });
    }
    await expect(adapter.queryLayoutPlacement({ component_type: type, placement: { ...top(), size: { width: 160, height: 40 } } }, principal))
      .rejects.toMatchObject({ code: "invalid_layout_candidate", message: expect.stringContaining("height") });
  });

  it("returns an independently changing view even with a same-revision delta request", async () => {
    const { store, adapter, changeView } = setup();
    const first = await adapter.inspectSpace(0, principal, { viewDetail: "full" });
    expect(first.viewGraph).toMatchObject({ status: "ready", view_epoch: 1, coordinate_system: expect.objectContaining({ units: "css_px" }) });
    changeView();
    expect((await adapter.inspectSpace(0, principal)).viewGraph).toMatchObject({ view_epoch: 2 });
    expect(store.getRevision()).toBe(0);
    expect(store.getCommandHistory()).toEqual([]);
  });

  it("atomically rejects two new panels whose final runtime positions overlap", async () => {
    const { store, adapter } = setup();
    const prepared = await adapter.prepare("two buttons", 2, principal);
    await expect(adapter.submit(prepared, batch(prepared, [create(prepared.reserved_component_ids[0]!, top(551)), create(prepared.reserved_component_ids[1]!, bottom)]), principal))
      .rejects.toMatchObject({ code: "current_view_layout_conflict" });
    expect(store.getRevision()).toBe(0);
    expect(store.getState().components.size).toBe(0);
    expect(store.getCommandHistory()).toEqual([]);
    expect(store.getEventHistory()).toEqual([]);
  });

  it("binds preparation to the live view and rejects stale UI commits without invalidating the session", async () => {
    const { store, adapter, changeView } = setup();
    const prepared = await adapter.prepare("button", 1, principal);
    expect(prepared).toMatchObject({ layout_frame: "current_view", view_guard: { view_id: "test-desktop", view_epoch: 1 } });
    changeView();
    await expect(adapter.submit(prepared, batch(prepared, [create(prepared.reserved_component_ids[0]!)]), principal))
      .rejects.toMatchObject({ code: "stale_view_context", options: { retryable: true, requiredAction: "inspect_workspace_space" } });
    expect(store.getRevision()).toBe(0);
    expect((await adapter.inspectSpace(undefined, principal)).viewGraph).toMatchObject({ view_epoch: 2 });
  });

  it("rejects stale explicit query and preparation guards", async () => {
    const { adapter } = setup();
    const viewGuard = { view_id: "old-desktop", view_epoch: 1 };
    await expect(adapter.queryLayoutPlacement({ component_type: type, placement: top() }, principal, { viewGuard })).rejects.toMatchObject({ code: "stale_view_context" });
    await expect(adapter.prepare("button", 1, principal, { viewGuard })).rejects.toMatchObject({ code: "stale_view_context" });
  });

  it("fails closed when an authored camera change would reproject visible UI, while allowing explicit canonical authoring", async () => {
    const { store, adapter } = setup();
    store.apply(workspaceBatch(store, "seed_projected_ui", [
      { op: "create_component", op_id: "stage", id: "STAGE", component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"), placement: world },
      create("PROJECTED_BUTTON", { space: "billboard", targetId: "STAGE", offset: { x: 0, y: 0, z: 0 }, size: { width: 160, height: 48 } }),
    ]));
    const before = structuredClone(store.getState());
    const history = structuredClone(store.getCommandHistory());
    const events = structuredClone(store.getEventHistory());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const cameraChange: WorkspaceOperation = {
      op: "update_component", op_id: "camera", id: "STAGE",
      patch: { props: { activeCamera: { position: { x: 5, y: 3, z: 6 }, target: { x: 0, y: 0, z: 0 }, fov: 45 } } },
    };
    const prepared = await adapter.prepare("Move camera with a projected button", 1, principal);
    await expect(adapter.submit(prepared, batch(prepared, [cameraChange]), principal)).rejects.toMatchObject({
      code: "runtime_view_unavailable",
      options: { retryable: true, requiredAction: "inspect_workspace_space", details: { reason: "authored_camera_change_requires_recheck" } },
    });
    expect(store.getState()).toEqual(before);
    expect(store.getCommandHistory()).toEqual(history);
    expect(store.getEventHistory()).toEqual(events);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();

    const canonical = await adapter.prepare("Apply camera, then re-inspect the settled view", 1, principal, { layoutFrame: "canonical" });
    await expect(adapter.submit(canonical, batch(canonical, [cameraChange]), principal)).resolves.toMatchObject({ status: "committed" });
    expect(store.getState().components.get("STAGE")?.props.activeCamera).toEqual(cameraChange.patch.props?.activeCamera);
  });

  it("rechecks the view after awaiting CAD preparation and rolls back the complete draft when its epoch changed", async () => {
    let enterPreparation!: () => void;
    let releasePreparation!: () => void;
    const entered = new Promise<void>((resolve) => { enterPreparation = resolve; });
    const released = new Promise<void>((resolve) => { releasePreparation = resolve; });
    let evaluated = false;
    let disposed = false;
    const factory = vi.fn(async () => {
      enterPreparation();
      await released;
      const kernel = await loadCadKernel();
      const evaluatePart = kernel.evaluatePart.bind(kernel);
      const dispose = kernel.dispose.bind(kernel);
      vi.spyOn(kernel, "evaluatePart").mockImplementation(async (...args) => {
        const result = await evaluatePart(...args);
        evaluated = true;
        return result;
      });
      vi.spyOn(kernel, "dispose").mockImplementation(async () => { await dispose(); disposed = true; });
      return kernel;
    });
    const { store, adapter, changeView } = setup(factory);
    const definition: CadPartDefinitionV1 = {
      ...defaultCadPartDefinition("runtime_plate", "Runtime plate"),
      history: [{
        id: "profile", name: "Profile", kind: "sketch",
        sketch: {
          plane: DEFAULT_CAD_SKETCH_PLANE,
          entities: [
            { id: "bottom", kind: "line", start: { x: 0, y: 0 }, end: { x: 1, y: 0 } },
            { id: "right", kind: "line", start: { x: 1, y: 0 }, end: { x: 1, y: 1 } },
            { id: "top", kind: "line", start: { x: 1, y: 1 }, end: { x: 0, y: 1 } },
            { id: "left", kind: "line", start: { x: 0, y: 1 }, end: { x: 0, y: 0 } },
          ],
          loops: [{ id: "outer", role: "outer", entityIds: ["bottom", "right", "top", "left"] }], constraints: [],
        },
      }, {
        id: "extrude", name: "Extrude", kind: "extrude", profile: { sketchFeatureId: "profile", loopIds: ["outer"] },
        distance: cadLengthExpression(0.1), operation: "new", resultBodyId: "plate",
      }],
      activeBodyIds: ["plate"],
    };
    const prepared = await adapter.prepare("Evaluate CAD and create an interactive control", 3, principal);
    const [stageId, cadId, buttonId] = prepared.reserved_component_ids;
    const before = structuredClone(store.getState());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const submission = adapter.submit(prepared, batch(prepared, [
      { op: "create_component", op_id: "stage", id: stageId!, component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"), placement: world },
      { op: "create_component", op_id: "cad", id: cadId!, component_type: DEFAULT_COMPONENT_REGISTRY.ref("cad-part"), placement: world,
        props: { definition: definition as unknown as JSONObject } },
      create(buttonId!),
      { op: "invoke_component_action", op_id: "press", id: buttonId!, action: "press", input: {} },
    ]), principal);
    const rejected = expect(submission).rejects.toMatchObject({ code: "stale_view_context" });
    await entered;
    expect(factory).toHaveBeenCalledOnce();
    expect(evaluated).toBe(false);
    expect(store.getState()).toEqual(before);
    changeView();
    releasePreparation();
    await rejected;
    expect(evaluated).toBe(true);
    expect(disposed).toBe(true);
    expect(store.getState()).toEqual(before);
    expect(store.getRevision()).toBe(0);
    expect(store.getCommandHistory()).toEqual([]);
    expect(store.getEventHistory()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  }, 30_000);

  it.each(["unavailable", "settling", "stale"])("fails closed for current-view UI authoring when %s", async (state) => {
    const fixture = setup();
    const prepared = await fixture.adapter.prepare("button", 1, principal);
    if (state === "unavailable") fixture.setStatus("unavailable");
    if (state === "settling") fixture.setStatus("settling");
    if (state === "stale") fixture.setRevisionOffset(-1);
    await expect(fixture.adapter.submit(prepared, batch(prepared, [create(prepared.reserved_component_ids[0]!)]), principal))
      .rejects.toMatchObject({ code: "runtime_view_unavailable" });
    expect(fixture.store.getRevision()).toBe(0);
  });

  it("does not block unrelated pure-3D work after a view change or renderer loss", async () => {
    const { store, adapter, changeView, setAvailable } = setup();
    const prepared = await adapter.prepare("stage", 1, principal);
    changeView();
    setAvailable(false);
    const operation: WorkspaceOperation = { op: "create_component", op_id: "stage", id: prepared.reserved_component_ids[0]!, component_type: DEFAULT_COMPONENT_REGISTRY.ref("stage-3d"), placement: world };
    await expect(adapter.submit(prepared, batch(prepared, [operation]), principal)).resolves.toMatchObject({ status: "committed" });
    expect(store.getRevision()).toBe(1);
  });

  it("rejects new host occlusion but leaves pre-existing problems repairable", async () => {
    const { store, adapter, setOccluders } = setup();
    setOccluders([{ id: "dock", kind: "toolbar", bounds: { left: 0, top: 540, width: 501, height: 99 } }]);
    let prepared = await adapter.prepare("button", 1, principal);
    await expect(adapter.submit(prepared, batch(prepared, [create(prepared.reserved_component_ids[0]!, top(551))]), principal))
      .rejects.toMatchObject({ code: "current_view_layout_conflict", options: { details: { issues: [expect.objectContaining({ kind: "host_occlusion" })] } } });
    // Simulate a legacy project or host chrome that appeared after authoring.
    store.apply(workspaceBatch(store, "legacy", [create("LEGACY", top(551))]));
    prepared = await adapter.prepare("label only", 1, principal);
    await expect(adapter.submit(prepared, batch(prepared, [{ op: "update_component", op_id: "label", id: "LEGACY", patch: { label: "Still editable" } }]), principal))
      .resolves.toMatchObject({ status: "committed" });
    prepared = await adapter.prepare("repair", 1, principal);
    await expect(adapter.submit(prepared, batch(prepared, [{ op: "place_component", op_id: "move", id: "LEGACY", placement: top(100) }]), principal))
      .resolves.toMatchObject({ status: "committed" });
  });

  it("validates event-routed visibility effects in the final draft and rolls back the press too", async () => {
    const { store, adapter, setOccluders } = setup();
    store.apply(workspaceBatch(store, "setup", [create("TRIGGER"), { ...create("TARGET", bottom), visibility: "hidden" } as WorkspaceOperation,
      { op: "connect_event", op_id: "route", connection: { id: "ROUTE", kind: "event_connection", sourceComponentId: "TRIGGER", event: "pressed", targetComponentId: "TARGET", action: "show", input: {}, enabled: true } },
    ]));
    setOccluders([{ id: "dock", kind: "toolbar", bounds: { left: 0, top: 540, width: 501, height: 99 } }]);
    const before = store.getState();
    const prepared = await adapter.prepare("press", 1, principal);
    await expect(adapter.submit(prepared, batch(prepared, [{ op: "invoke_component_action", op_id: "press", id: "TRIGGER", action: "press", input: {} }]), principal))
      .rejects.toMatchObject({ code: "current_view_layout_conflict" });
    expect(store.getState()).toEqual(before);
    expect(store.getEventHistory()).toHaveLength(0);
  });

  it("returns the original idempotent receipt after the view changes and allows undo/redo", async () => {
    const { store, adapter, changeView, setAvailable } = setup();
    const prepared = await adapter.prepare("button", 1, principal);
    const input = batch(prepared, [create(prepared.reserved_component_ids[0]!)]);
    await adapter.submit(prepared, input, principal);
    changeView();
    setAvailable(false);
    await expect(adapter.submit(prepared, input, principal)).resolves.toMatchObject({ status: "idempotent", resultingWorkspaceRevision: 1 });
    await expect(adapter.undo(1, principal)).resolves.toMatchObject({ changed: true });
    await expect(adapter.redo(store.getRevision(), principal)).resolves.toMatchObject({ changed: true });
    expect(store.getState().components.size).toBe(1);
    expect(JSON.stringify(store.getCommandHistory())).not.toMatch(/view_epoch|view_guard|test-desktop/);
    const serializer = new WorkspaceProjectSerializer();
    const project = serializer.fromStore("runtime-check", store);
    const reopened = serializer.openStore(serializer.deserialize(serializer.serialize(project)));
    expect(reopened.getState().components.size).toBe(1);
    expect(JSON.stringify(project)).not.toMatch(/view_epoch|view_guard|test-desktop/);
  });

  it("supports explicit canonical-only/headless authoring without pretending visual validation", async () => {
    const { store, adapter, setAvailable } = setup();
    setAvailable(false);
    const prepared = await adapter.prepare("headless", 1, principal, { layoutFrame: "canonical" });
    expect(prepared.layout_frame).toBe("canonical");
    await expect(adapter.submit(prepared, batch(prepared, [create(prepared.reserved_component_ids[0]!)]), principal)).resolves.toMatchObject({ status: "committed" });
    expect((await adapter.inspectSpace(undefined, principal)).viewGraph).toMatchObject({ current_view_valid: null });
    expect(store.getRevision()).toBe(1);
  });
});
