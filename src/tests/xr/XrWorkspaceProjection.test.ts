import { describe, expect, it } from "vitest";
import type { WorkspaceRenderSnapshot } from "../../workspace/renderer/contracts";
import {
  applyXrWorkspaceProjectionDelta,
  canonicalXrJson,
  diffXrWorkspaceProjection,
  digestXrProjection,
  parseXrWorkspaceProjection,
  parseXrWorkspaceProjectionDelta,
  toXrWorkspaceProjection,
} from "../../xr/authority";

function snapshot(revision: number, labels: readonly string[]): WorkspaceRenderSnapshot {
  return {
    workspaceId: "workspace-xr-test",
    revision,
    components: labels.map((label, index) => ({
      id: `component-${index}`,
      type: { typeId: "spatial-entity", version: "1.0.0", digest: "fixture" },
      label,
      props: { assetId: "primitive_box", entityKind: "prop" },
      durableState: {},
      placement: {
        space: "world3d",
        position: { x: index, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      tags: [],
      visibility: "visible",
      locks: { placement: false },
    })),
  };
}

describe("XR Workspace projection", () => {
  it("produces stable digests independently of object insertion order", async () => {
    expect(canonicalXrJson({ b: 2, a: 1 })).toBe(canonicalXrJson({ a: 1, b: 2 }));
    await expect(digestXrProjection({ b: 2, a: 1 }))
      .resolves.toBe(await digestXrProjection({ a: 1, b: 2 }));
  });

  it("round-trips an exact one-revision component delta", () => {
    const before = toXrWorkspaceProjection(snapshot(4, ["Desk", "Lamp"]));
    const after = toXrWorkspaceProjection(snapshot(5, ["Desk moved", "Lamp", "Plant"]));
    const delta = diffXrWorkspaceProjection(before, after);
    expect(delta.added.map((component) => component.id)).toEqual(["component-2"]);
    expect(delta.updated.map((component) => component.id)).toEqual(["component-0"]);
    expect(applyXrWorkspaceProjectionDelta(before, delta)).toEqual(after);
  });

  it("rejects revision gaps and malformed component order", () => {
    const before = toXrWorkspaceProjection(snapshot(1, ["Desk"]));
    const gap = toXrWorkspaceProjection(snapshot(3, ["Desk"]));
    expect(() => diffXrWorkspaceProjection(before, gap)).toThrow(/exactly one revision/u);

    const after = toXrWorkspaceProjection(snapshot(2, ["Desk", "Lamp"]));
    const delta = diffXrWorkspaceProjection(before, after);
    expect(() => applyXrWorkspaceProjectionDelta(before, { ...delta, componentOrder: ["component-0"] }))
      .toThrow(/order/u);
  });

  it("strictly parses detached projection and delta payloads from a renderer transport", () => {
    const before = toXrWorkspaceProjection(snapshot(8, ["Desk"]));
    const after = toXrWorkspaceProjection(snapshot(9, ["Desk moved", "Lamp"]));
    const parsed = parseXrWorkspaceProjection(JSON.parse(JSON.stringify(before)));
    const parsedDelta = parseXrWorkspaceProjectionDelta(
      JSON.parse(JSON.stringify(diffXrWorkspaceProjection(before, after))),
    );
    expect(parsed).toEqual(before);
    expect(applyXrWorkspaceProjectionDelta(parsed, parsedDelta)).toEqual(after);
    expect(parsed).not.toBe(before);
  });

  it("rejects unknown fields, invalid components, and duplicate delta identities", () => {
    const before = toXrWorkspaceProjection(snapshot(2, ["Desk"]));
    expect(() => parseXrWorkspaceProjection({ ...before, authority: true }))
      .toThrow(/unknown field/u);
    expect(() => parseXrWorkspaceProjection({
      ...before,
      components: [{ id: "broken" }],
    })).toThrow(/invalid component/u);

    const after = toXrWorkspaceProjection(snapshot(3, ["Desk moved", "Lamp"]));
    const delta = diffXrWorkspaceProjection(before, after);
    expect(() => parseXrWorkspaceProjectionDelta({
      ...delta,
      componentOrder: ["component-0", "component-0"],
    })).toThrow(/duplicate/u);
  });
});
