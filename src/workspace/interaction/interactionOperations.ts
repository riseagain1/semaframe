import type {
  InvokeComponentActionOperation,
  PlaceComponentOperation,
  ResizeComponentOperation,
  WorkspaceOperation,
} from "../protocol/workspaceTypes";
import {
  clonePlacement,
  type ComponentActionRequest,
  type PlacementCommitRequest,
  type ResizeCommitRequest,
} from "../renderer/contracts";

/** Convert a renderer commit request into the closed Workspace operation. */
export function placementCommitOperation(
  request: PlacementCommitRequest,
  operationId: string,
): PlaceComponentOperation {
  return {
    op: "place_component",
    op_id: operationId,
    id: request.componentId,
    placement: clonePlacement(request.placement),
  };
}

/** Convert an absolute renderer resize into the closed Workspace operation. */
export function resizeCommitOperation(
  request: ResizeCommitRequest,
  operationId: string,
): ResizeComponentOperation {
  return {
    op: "resize_component",
    op_id: operationId,
    id: request.componentId,
    resize: structuredClone(request.resize),
  };
}

/**
 * Build the single-batch durable operation list for a human resize.
 *
 * `resize_component` must run first. When edge anchoring also changes the
 * position, the following `place_component` carries the already-resized full
 * placement so strict geometry validation sees no second resize.
 */
export function resizeCommitOperations(
  request: Pick<ResizeCommitRequest, "componentId" | "resize" | "placement">,
  resizeOperationId: string,
  placeOperationId: string,
): WorkspaceOperation[] {
  const operations: WorkspaceOperation[] = [{
    op: "resize_component",
    op_id: resizeOperationId,
    id: request.componentId,
    resize: structuredClone(request.resize),
  }];
  if (request.placement) {
    operations.push({
      op: "place_component",
      op_id: placeOperationId,
      id: request.componentId,
      placement: clonePlacement(request.placement),
    });
  }
  return operations;
}

/** Convert a UI action into the same action vocabulary used by agents. */
export function componentActionOperation(
  request: ComponentActionRequest,
  operationId: string,
): InvokeComponentActionOperation {
  return {
    op: "invoke_component_action",
    op_id: operationId,
    id: request.componentId,
    action: request.action,
    input: structuredClone(request.input ?? {}),
  };
}
