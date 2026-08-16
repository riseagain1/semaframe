import type {
  Easing,
  EntityId,
  SceneOperation,
  VisualTiming,
} from "./sceneRenderTypes";

export type ResolvedVisualTiming = Required<
  Pick<VisualTiming, "startAfterMs" | "durationMs" | "easing">
> & { syncGroup?: string };

const DEFAULT_DURATION_BY_OPERATION: Record<SceneOperation["op"], number> = {
  set_environment: 280,
  update_entity: 180,
};

export function easeProgress(progress: number, easing: Easing): number {
  const t = Math.min(1, Math.max(0, progress));
  switch (easing) {
    case "ease_in":
      return t * t;
    case "ease_out":
      return 1 - (1 - t) * (1 - t);
    case "ease_in_out":
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    case "linear":
    default:
      return t;
  }
}

export function resolveVisualTiming(
  operation: SceneOperation,
  reducedMotion = false,
): ResolvedVisualTiming {
  const specified = "visualTiming" in operation ? operation.visualTiming : undefined;
  return {
    startAfterMs: reducedMotion ? 0 : specified?.startAfterMs ?? 0,
    durationMs: reducedMotion
      ? 0
      : specified?.durationMs ?? DEFAULT_DURATION_BY_OPERATION[operation.op],
    easing: specified?.easing ?? "ease_in_out",
    ...(specified?.syncGroup ? { syncGroup: specified.syncGroup } : {}),
  };
}

export function operationEntityIds(operation: SceneOperation): EntityId[] {
  switch (operation.op) {
    case "update_entity":
      return [operation.id];
    default:
      return [];
  }
}

/** Later operations win, matching the final visual destination of a batch. */
export function timingForEntity(
  operations: readonly SceneOperation[],
  entityId: EntityId,
  reducedMotion = false,
): ResolvedVisualTiming | undefined {
  let match: SceneOperation | undefined;
  for (const operation of operations) {
    if (operationEntityIds(operation).includes(entityId)) match = operation;
  }
  return match ? resolveVisualTiming(match, reducedMotion) : undefined;
}
