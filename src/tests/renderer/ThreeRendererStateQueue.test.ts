import { describe, expect, it } from "vitest";
import type { ProceduralEntity } from "../../renderer/proceduralAssets";
import type { EntityState } from "../../renderer/sceneRenderTypes";
import { ThreeRenderer } from "../../renderer/ThreeRenderer";

type RenderQueueAccess = Readonly<{
  enqueueStateRender(
    task: (isCurrent: () => boolean, signal: AbortSignal) => Promise<void>,
  ): Promise<void>;
  waitForEntityRoot(
    entity: EntityState,
    pending: Promise<ProceduralEntity>,
    signal: AbortSignal,
  ): Promise<ProceduralEntity>;
}>;

describe("ThreeRenderer state queue cancellation", () => {
  it("lets a newer revision proceed when an external entity decoder never settles", async () => {
    const renderer = new ThreeRenderer({ reducedMotion: true });
    const access = renderer as unknown as RenderQueueAccess;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const never = new Promise<ProceduralEntity>(() => undefined);
    const entity: EntityState = {
      id: "hung-decoder",
      kind: "prop",
      assetId: "asset:hung-decoder",
      label: "Hung decoder",
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      state: { type: "generic", properties: {} },
      appearance: {},
      tags: [],
      locked: false,
    };

    const first = access.enqueueStateRender(async (_isCurrent, signal) => {
      markStarted();
      await access.waitForEntityRoot(entity, never, signal);
    });
    await started;
    let latestRendered = false;
    const latest = access.enqueueStateRender(async () => {
      latestRendered = true;
    });

    await expect(latest).resolves.toBeUndefined();
    await expect(first).resolves.toBeUndefined();
    expect(latestRendered).toBe(true);
    renderer.dispose();
  });
});
