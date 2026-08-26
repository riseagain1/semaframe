import type { EntityId, SceneState, Vec3 } from "../sceneRenderTypes";

/** Renderer-local presentation choice. It is never persisted in Workspace state. */
export type MaterializationMode = "off" | "subtle" | "full";

/**
 * Identifies how a semantic snapshot reached a renderer. Only a live commit is
 * eligible for a build reveal; opening, reconnecting, and context recovery
 * must project the authoritative state immediately.
 */
export type RenderDelivery = "initial" | "live_commit" | "reconnect" | "context_restore";

export type RenderPresentationContext = Readonly<{
  delivery: RenderDelivery;
  /** Ephemeral identity used only to prevent duplicate presentation. */
  batchKey?: string;
}>;

export type MaterializationProxySource =
  | "reality_bounds"
  | "asset_bounds"
  | "parametric_bounds"
  | "collision_bounds"
  | "resolved_render_bounds"
  | "loading_glyph";

export type MaterializationProxy = Readonly<{
  source: MaterializationProxySource;
  reliableBounds: boolean;
  localCenter: Vec3;
  localSize: Vec3;
  /** Column-major Matrix4 elements, local to the renderer's entity layer. */
  worldMatrix: readonly number[];
}>;

export type MaterializationPlanEntry = Readonly<{
  entityId: EntityId;
  parentId?: EntityId;
  order: number;
  revealAtMs: number;
  revealDurationMs: number;
  proxy: MaterializationProxy;
}>;

export type MaterializationPlan = Readonly<{
  batchKey: string;
  mode: Exclude<MaterializationMode, "off">;
  totalDurationMs: number;
  center: Vec3;
  radius: number;
  entries: readonly MaterializationPlanEntry[];
}>;

export type MaterializationAssetBounds = Readonly<{
  center: Vec3;
  size: Vec3;
}>;

export type MaterializationPlannerInput = Readonly<{
  state: Readonly<SceneState>;
  addedEntityIds: readonly EntityId[];
  batchKey: string;
  mode: Exclude<MaterializationMode, "off">;
  resolveAssetBounds?(assetId: string): MaterializationAssetBounds | undefined;
}>;
