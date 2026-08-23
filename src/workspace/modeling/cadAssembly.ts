import { z } from "zod";
import type { ComponentInstance } from "../components/componentTypes";

export const CAD_ASSEMBLY_MATE_KINDS = ["fixed", "revolute", "slider", "planar"] as const;

export type CadAssemblyMateEndpoint = Readonly<{
  componentId: string;
  datumId?: string;
  topologyRole?: string;
}>;

export type CadAssemblyMate = Readonly<{
  id: string;
  kind: typeof CAD_ASSEMBLY_MATE_KINDS[number];
  a: CadAssemblyMateEndpoint;
  b: CadAssemblyMateEndpoint;
  offsetM: number;
  angleRad: number;
  enabled: boolean;
}>;

const ID = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);
const SEMANTIC_ID = z.string().min(1).max(256).regex(/^[A-Za-z][A-Za-z0-9._:/-]*$/u);
const ENDPOINT = z.strictObject({
  componentId: ID,
  datumId: SEMANTIC_ID.max(128).optional(),
  topologyRole: SEMANTIC_ID.optional(),
});
const MATE = z.strictObject({
  id: SEMANTIC_ID.max(128),
  kind: z.enum(CAD_ASSEMBLY_MATE_KINDS),
  a: ENDPOINT,
  b: ENDPOINT,
  offsetM: z.number().finite().min(-1_000).max(1_000),
  angleRad: z.number().finite().min(-Math.PI * 2).max(Math.PI * 2),
  enabled: z.boolean(),
});

export class CadAssemblyError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "CadAssemblyError";
  }
}
export function parseCadAssemblyMates(value: unknown): CadAssemblyMate[] {
  const parsed = z.array(MATE).max(128).safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CadAssemblyError(
      `Invalid assembly mate at ${issue?.path.join(".") || "$"}: ${issue?.message ?? "invalid value"}`,
      "invalid_assembly_mates",
    );
  }
  const ids = new Set<string>();
  for (const mate of parsed.data) {
    if (ids.has(mate.id)) {
      throw new CadAssemblyError(`Duplicate assembly mate ${mate.id}`, "duplicate_assembly_mate");
    }
    if (mate.a.componentId === mate.b.componentId
      && mate.a.datumId === mate.b.datumId
      && mate.a.topologyRole === mate.b.topologyRole) {
      throw new CadAssemblyError(`Assembly mate ${mate.id} connects an endpoint to itself`, "self_assembly_mate");
    }
    ids.add(mate.id);
  }
  return structuredClone(parsed.data);
}

function belongsToAssembly(
  components: ReadonlyMap<string, ComponentInstance>,
  assemblyId: string,
  componentId: string,
): boolean {
  let current = components.get(componentId);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    if (current.id === assemblyId) return true;
    visited.add(current.id);
    current = current.parentId ? components.get(current.parentId) : undefined;
  }
  return false;
}

/** Validate that mate endpoints stay inside the editable assembly subtree. */
export function assertCadAssemblyMates(
  components: ReadonlyMap<string, ComponentInstance>,
  assembly: ComponentInstance,
): void {
  if (assembly.type.typeId !== "model-assembly" || assembly.props.mates === undefined) return;
  const mates = parseCadAssemblyMates(assembly.props.mates);
  for (const mate of mates) {
    for (const endpoint of [mate.a, mate.b]) {
      const component = components.get(endpoint.componentId);
      if (!component) {
        throw new CadAssemblyError(
          `Assembly mate ${mate.id} references missing component ${endpoint.componentId}`,
          "missing_assembly_mate_endpoint",
        );
      }
      if (!belongsToAssembly(components, assembly.id, component.id)) {
        throw new CadAssemblyError(
          `Assembly mate ${mate.id} leaves assembly ${assembly.id}`,
          "external_assembly_mate_endpoint",
        );
      }
      if (endpoint.datumId && component.type.typeId !== "cad-part") {
        throw new CadAssemblyError(
          `Assembly mate ${mate.id} uses datum ${endpoint.datumId} on non-CAD component ${component.id}`,
          "invalid_assembly_mate_datum",
        );
      }
      if (endpoint.topologyRole && component.type.typeId !== "cad-part") {
        throw new CadAssemblyError(
          `Assembly mate ${mate.id} uses topology role ${endpoint.topologyRole} on non-CAD component ${component.id}`,
          "invalid_assembly_mate_topology",
        );
      }
    }
  }
}
