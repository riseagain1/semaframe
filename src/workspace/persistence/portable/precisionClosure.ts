import type { WorkspaceProjectFile } from "../WorkspaceProjectSerializer";
import { parsePrecisionEvidenceRef, type PrecisionEvidenceRef } from "../../precision/evidenceVault";
import { canonicalJson } from "./canonicalJson";
import { PortableProjectError } from "./errors";

/** Include retained history, even when its study has subsequently been deleted. */
export function collectPortablePrecisionEvidence(project: WorkspaceProjectFile): readonly PrecisionEvidenceRef[] {
  const refs = new Map<string, PrecisionEvidenceRef>();
  const studyIds = new Set<string>();
  const collect = (props: unknown): void => {
    if (!props || typeof props !== "object" || Array.isArray(props)) return;
    const sources = (props as Record<string, unknown>).evidenceSources;
    if (sources === undefined) return;
    if (!Array.isArray(sources) || sources.length > 32) throw new PortableProjectError("closure_mismatch", "Invalid precision evidence closure");
    for (const source of sources) {
      const ref = parsePrecisionEvidenceRef(source);
      const previous = refs.get(ref.digest);
      if (previous && canonicalJson(previous) !== canonicalJson(ref)) throw new PortableProjectError("closure_mismatch", "Conflicting precision evidence references");
      refs.set(ref.digest, ref);
    }
  };
  for (const state of [project.checkpoint, project.workspace]) {
    for (const [, component] of state.components) if (component.type.typeId === "precision-study") {
      studyIds.add(component.id);
      collect(component.props);
    }
  }
  for (const command of project.commandHistory) for (const operation of command.resolvedOperations) {
    if (operation.op === "create_component" && operation.component_type.typeId === "precision-study") studyIds.add(operation.id);
  }
  for (const command of project.commandHistory) {
    for (const operation of command.resolvedOperations) {
      if (operation.op === "create_component" && operation.component_type.typeId === "precision-study") collect(operation.props);
      // A deleted study's type may no longer exist in the current scene.
      if (operation.op === "update_component" && studyIds.has(operation.id)) collect(operation.patch.props);
    }
  }
  if (refs.size > 128) throw new PortableProjectError("size_limit_exceeded", "Precision evidence closure exceeds 128 objects");
  return [...refs.values()].sort((a, b) => a.digest.localeCompare(b.digest));
}

export function precisionEvidencePath(ref: PrecisionEvidenceRef): string {
  parsePrecisionEvidenceRef(ref);
  return `evidence/sha256/${ref.digest.slice(7)}`;
}
