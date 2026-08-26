import type {
  ApproximationNote,
  SceneDelta,
  SceneOperation,
  SceneState,
} from "./sceneRenderTypes";
import type { MaterializationMode, RenderPresentationContext } from "./materialization";

/** Internal renderer boundary for Workspace-projected spatial state. */
export interface RendererAdapter {
  initialize(container: HTMLElement): Promise<void>;

  renderState(state: Readonly<SceneState>): Promise<void>;

  applyDelta(
    delta: SceneDelta,
    state?: Readonly<SceneState>,
    operations?: readonly SceneOperation[],
    presentation?: RenderPresentationContext,
  ): Promise<void>;

  resize(): void;
  setMaterializationMode?(mode: MaterializationMode): void;
  dispose(): void;
}

export type RendererStatus =
  | { kind: "ready" }
  | { kind: "context-lost" }
  | { kind: "context-restored" }
  | {
      kind: "asset-fallback";
      assetId: string;
      note: ApproximationNote & { code: "asset_load_failed"; entityId: string };
    }
  | { kind: "error"; message: string };
