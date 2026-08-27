import type { RealityAssetDescriptor } from "../../assets/types";
import { parseRealityAssetDescriptor } from "../../assets/validation";
import type { ComponentInstance } from "../../components/componentTypes";
import type { WorkspaceProjectFile } from "../WorkspaceProjectSerializer";
import { canonicalJson } from "./canonicalJson";
import { PortableProjectError } from "./errors";

type RealityReference = Readonly<{ assetId: string; digest: string; source: string }>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function assetReference(props: unknown, source: string): RealityReference | undefined {
  const reference = record(record(props)?.assetRef);
  if (!reference) return undefined;
  const assetId = reference.assetId;
  const digest = reference.digest;
  if (typeof assetId !== "string" || typeof digest !== "string") {
    throw new PortableProjectError("closure_mismatch", `${source} contains an incomplete Reality assetRef`);
  }
  if (!/^ra_[0-9a-f]{64}$/.test(assetId) || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new PortableProjectError("closure_mismatch", `${source} contains a non-canonical Reality assetRef`);
  }
  return Object.freeze({ assetId, digest, source });
}

function componentReference(component: ComponentInstance, source: string): RealityReference | undefined {
  return component.type.typeId === "gaussian-splat"
    ? assetReference(component.props, source)
    : undefined;
}

/**
 * The portable set covers replay and undo, not just the final scene: checkpoint
 * and current catalogs plus every retained register operation are included.
 */
export function collectPortableRealityAssetClosure(
  project: WorkspaceProjectFile,
): readonly RealityAssetDescriptor[] {
  const descriptors = new Map<string, RealityAssetDescriptor>();
  const references: RealityReference[] = [];
  const addDescriptor = (value: unknown, source: string): void => {
    let descriptor: RealityAssetDescriptor;
    try {
      descriptor = parseRealityAssetDescriptor(value);
    } catch (error) {
      throw new PortableProjectError("closure_mismatch", `${source} contains an invalid Reality descriptor`, { cause: error });
    }
    const existing = descriptors.get(descriptor.assetId);
    if (existing && canonicalJson(existing) !== canonicalJson(descriptor)) {
      throw new PortableProjectError("closure_mismatch", `${source} conflicts with descriptor ${descriptor.assetId}`);
    }
    descriptors.set(descriptor.assetId, descriptor);
  };

  for (const [source, state] of [
    ["checkpoint", project.checkpoint],
    ["workspace", project.workspace],
  ] as const) {
    for (const [assetId, descriptor] of state.realityAssets ?? []) {
      addDescriptor(descriptor, `${source}.realityAssets[${assetId}]`);
    }
    for (const [componentId, component] of state.components) {
      const reference = componentReference(component, `${source}.components[${componentId}]`);
      if (reference) references.push(reference);
    }
  }

  project.commandHistory.forEach((command, commandIndex) => {
    command.resolvedOperations.forEach((operation, operationIndex) => {
      const source = `commandHistory[${commandIndex}].resolvedOperations[${operationIndex}]`;
      if (operation.op === "register_reality_asset") addDescriptor(operation.asset, source);
      if (operation.op === "create_component" && operation.component_type.typeId === "gaussian-splat") {
        const reference = assetReference(operation.props, source);
        if (reference) references.push(reference);
      }
    });
  });

  for (const reference of references) {
    const descriptor = descriptors.get(reference.assetId);
    if (!descriptor || descriptor.digest !== reference.digest) {
      throw new PortableProjectError(
        "closure_mismatch",
        `${reference.source} references Reality bytes absent from the portable descriptor closure`,
      );
    }
  }
  return Object.freeze([...descriptors.values()].sort((left, right) => (
    left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0
  )));
}
