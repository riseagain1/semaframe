import type { JSONObject, World3DPlacement } from "../components/componentTypes";
import { deterministicDigest } from "../components/manifestDigest";
import { parseParametricPrimitive } from "./parametricGeometry";
import type { ModelDefinition } from "./modelDefinitions";
import type {
  OpenUsdExportDocument,
  OpenUsdExportMaterial,
  OpenUsdExportNode,
} from "./openUsdExporter";

type Quaternion = { x: number; y: number; z: number; w: number };

function quaternionFromEuler(rotation: World3DPlacement["rotation"]): Quaternion {
  const cx = Math.cos(rotation.x / 2);
  const sx = Math.sin(rotation.x / 2);
  const cy = Math.cos(rotation.y / 2);
  const sy = Math.sin(rotation.y / 2);
  const cz = Math.cos(rotation.z / 2);
  const sz = Math.sin(rotation.z / 2);
  return {
    x: sx * cy * cz + cx * sy * sz,
    y: cx * sy * cz - sx * cy * sz,
    z: cx * cy * sz + sx * sy * cz,
    w: cx * cy * cz - sx * sy * sz,
  };
}

function srgbChannelToLinear(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearColor(value: unknown, fallback: string): { r: number; g: number; b: number } {
  const color = typeof value === "string" && /^#[0-9A-Fa-f]{6}$/u.test(value) ? value : fallback;
  return {
    r: srgbChannelToLinear(Number.parseInt(color.slice(1, 3), 16)),
    g: srgbChannelToLinear(Number.parseInt(color.slice(3, 5), 16)),
    b: srgbChannelToLinear(Number.parseInt(color.slice(5, 7), 16)),
  };
}

function finiteProperty(
  props: JSONObject,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = props[key];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function materialFromProps(nodeId: string, value: unknown): OpenUsdExportMaterial {
  const props = value && typeof value === "object" && !Array.isArray(value)
    ? value as JSONObject
    : {};
  return {
    id: `MAT_${deterministicDigest({ nodeId, props })}`,
    name: `${nodeId} material`,
    baseColorLinear: linearColor(props.baseColor, "#68D5FF"),
    metallic: finiteProperty(props, "metallic", 0, 0, 1),
    roughness: finiteProperty(props, "roughness", 0.55, 0, 1),
    opacity: finiteProperty(props, "opacity", 1, 0, 1),
    emissiveColorLinear: linearColor(props.emissiveColor, "#000000"),
  };
}

function transformFromPlacement(placement: World3DPlacement): NonNullable<OpenUsdExportNode["transform"]> {
  return {
    translationM: { ...placement.position },
    rotationQuaternion: quaternionFromEuler(placement.rotation),
    scale: { ...placement.scale },
  };
}

/** Convert one immutable Workspace model into the deterministic exporter DTO. */
export function modelDefinitionToOpenUsdDocument(
  definition: ModelDefinition,
): OpenUsdExportDocument {
  const materials: OpenUsdExportMaterial[] = [];
  const nodes: OpenUsdExportNode[] = definition.nodes.map((node) => {
    const primitive = node.componentType.typeId === "spatial-primitive"
      ? parseParametricPrimitive(node.props.geometry)
      : undefined;
    const material = primitive ? materialFromProps(node.nodeId, node.props.material) : undefined;
    if (material) materials.push(material);
    return {
      id: node.nodeId,
      name: node.label,
      ...(node.parentNodeId ? { parentId: node.parentNodeId } : {}),
      transform: transformFromPlacement(node.placement),
      ...(primitive ? { primitive } : {}),
      ...(material ? { materialId: material.id } : {}),
      visible: node.visibility === "visible",
    };
  });
  return {
    id: `${definition.modelId}@${definition.version}`,
    name: definition.displayName,
    nodes,
    materials,
  };
}
