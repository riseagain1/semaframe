import type { SceneOperation } from "../../renderer/sceneRenderTypes";
import { describe, expect, it } from "vitest";
import {
  easeProgress,
  operationEntityIds,
  resolveVisualTiming,
  timingForEntity,
} from "../../renderer/rendererTiming";

describe("renderer visual timing", () => {
  it("uses bounded easing functions", () => {
    expect(easeProgress(-1, "ease_in")).toBe(0);
    expect(easeProgress(2, "ease_out")).toBe(1);
    expect(easeProgress(0.5, "ease_in_out")).toBeCloseTo(0.5);
    expect(easeProgress(0.25, "linear")).toBe(0.25);
  });

  it("honors explicit operation timing and reduced motion", () => {
    const operation: SceneOperation = {
      op: "update_entity",
      op_id: "op_move",
      id: "CHAR_0001",
      patch: {},
      visualTiming: {
        startAfterMs: 80,
        durationMs: 900,
        easing: "ease_out",
        syncGroup: "walk",
      },
    };
    expect(resolveVisualTiming(operation)).toEqual({
      startAfterMs: 80,
      durationMs: 900,
      easing: "ease_out",
      syncGroup: "walk",
    });
    expect(resolveVisualTiming(operation, true)).toEqual({
      startAfterMs: 0,
      durationMs: 0,
      easing: "ease_out",
      syncGroup: "walk",
    });
  });

  it("associates update timing with its projected entity", () => {
    const operation: SceneOperation = {
      op: "update_entity",
      op_id: "op_update",
      id: "PROP_0002",
      patch: {},
      visualTiming: { durationMs: 240 },
    };
    expect(operationEntityIds(operation)).toEqual(["PROP_0002"]);
    expect(timingForEntity([operation], "PROP_0002")?.durationMs).toBe(240);
  });
});
