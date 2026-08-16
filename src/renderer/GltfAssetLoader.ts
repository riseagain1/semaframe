import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { AssetRecord } from "../assets/assetManifest";
import type { EntityState } from "./sceneRenderTypes";
import type { ProceduralEntity } from "./proceduralAssets";

export type GltfLoadFunction = (uri: string) => Promise<Pick<GLTF, "scene" | "animations">>;

type LoadedTemplate = {
  scene: THREE.Object3D;
  animations: THREE.AnimationClip[];
};

/**
 * Lazy, version-stable GLB template cache.
 *
 * Parsed templates are cached by their resolved URI. Every entity gets cloned
 * geometry and materials so appearance updates and disposal cannot bleed into
 * another entity or invalidate the cached template.
 */
export class GltfAssetLoader {
  private readonly load: GltfLoadFunction;
  private readonly templates = new Map<string, Promise<LoadedTemplate>>();

  constructor(load?: GltfLoadFunction) {
    const loader = load ? null : new GLTFLoader();
    this.load = load ?? ((uri) => loader!.loadAsync(uri));
  }

  async instantiate(record: AssetRecord, entity: EntityState): Promise<ProceduralEntity> {
    if (!record.runtime) throw new Error(`Asset ${record.assetId} has no GLB runtime URI.`);
    const uri = resolveRuntimeUri(record.runtime.uri);
    let pending = this.templates.get(uri);
    if (!pending) {
      pending = this.load(uri).then((gltf) => ({
        scene: gltf.scene,
        animations: gltf.animations ?? [],
      }));
      this.templates.set(uri, pending);
    }
    const template = await pending;
    return instantiateTemplate(template, record, entity);
  }

  clear(): void {
    this.templates.clear();
  }
}

export function resolveRuntimeUri(uri: string): string {
  if (typeof document === "undefined") return uri;
  return new URL(uri, document.baseURI).href;
}

function instantiateTemplate(
  template: LoadedTemplate,
  record: AssetRecord,
  entity: EntityState,
): ProceduralEntity {
  const root = new THREE.Group() as ProceduralEntity;
  root.name = `entity:${entity.id}`;
  root.userData.entityId = entity.id;
  root.userData.loadedAssetId = record.assetId;

  const content = cloneSkeleton(template.scene);
  content.name = "asset:content";
  content.scale.setScalar(record.runtime!.unitScaleMeters * record.defaultScale);
  const primaryMaterials: THREE.MeshStandardMaterial[] = [];
  content.traverse((object) => {
    object.userData.entityId = entity.id;
    normalizeContractNodeName(object);
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry = object.geometry.clone();
    object.castShadow = true;
    object.receiveShadow = true;
    const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
    const clonedMaterials = sourceMaterials.map((material) => material.clone());
    object.material = Array.isArray(object.material) ? clonedMaterials : clonedMaterials[0];
    for (const material of clonedMaterials) {
      if (material instanceof THREE.MeshStandardMaterial) {
        material.userData.defaultColor = material.color.getHex();
        primaryMaterials.push(material);
      }
    }
  });
  root.add(content);
  root.userData.primaryMaterials = primaryMaterials;
  root.userData.accentMaterials = [];
  root.userData.animationClips = template.animations.map((clip) => clip.clone());
  if (template.animations.length) root.userData.animationMixer = new THREE.AnimationMixer(content);
  ensureManifestNodes(root, content, record);
  root.traverse((object) => {
    object.userData.entityId = entity.id;
  });
  return root;
}

/** Accept common authoring-tool separators without renaming animation targets. */
function normalizeContractNodeName(object: THREE.Object3D): void {
  const socket = /^(?:socket[:_.-])(.+)$/i.exec(object.name);
  const anchor = /^(?:anchor[:_.-])(.+)$/i.exec(object.name);
  const contractName = socket ? `socket:${socket[1]}` : anchor ? `anchor:${anchor[1]}` : undefined;
  if (contractName && object.name !== contractName && !object.getObjectByName(contractName)) {
    // Keep the authored node name intact so animation tracks remain valid.
    const alias = new THREE.Object3D();
    alias.name = contractName;
    object.add(alias);
  }
}

function ensureManifestNodes(root: THREE.Object3D, content: THREE.Object3D, record: AssetRecord): void {
  for (const name of record.sockets) ensureNamedNode(root, content, record, "socket", name);
  for (const name of record.anchors) ensureNamedNode(root, content, record, "anchor", name);
}

function ensureNamedNode(
  root: THREE.Object3D,
  content: THREE.Object3D,
  record: AssetRecord,
  prefix: "socket" | "anchor",
  name: string,
): void {
  const contractName = `${prefix}:${name}`;
  if (root.getObjectByName(contractName)) return;
  const authored = root.getObjectByName(name);
  if (authored) {
    const alias = new THREE.Object3D();
    alias.name = contractName;
    authored.add(alias);
    return;
  }
  const fallback = new THREE.Object3D();
  fallback.name = contractName;
  fallback.position.copy(defaultNodePosition(record, name));
  fallback.userData.approximatedNode = true;
  content.add(fallback);
}

function defaultNodePosition(record: AssetRecord, name: string): THREE.Vector3 {
  const { width, height, depth } = record.bounds;
  switch (name) {
    case "head":
    case "top":
      return new THREE.Vector3(0, height, 0);
    case "eyes":
      return new THREE.Vector3(0, height * 0.94, depth * 0.18);
    case "torso":
      return new THREE.Vector3(0, height * 0.6, depth * 0.18);
    case "left_hand":
      return new THREE.Vector3(-width * 0.54, height * 0.57, 0);
    case "right_hand":
      return new THREE.Vector3(width * 0.54, height * 0.57, 0);
    case "back":
      return new THREE.Vector3(0, height * 0.58, -depth * 0.5);
    case "feet":
    case "ground":
      return new THREE.Vector3(0, 0, 0);
    case "seat":
      return new THREE.Vector3(0, height * 0.52, 0);
    case "inside":
      return new THREE.Vector3(0, height * 0.5, 0);
    case "front":
      return new THREE.Vector3(0, height * 0.5, depth * 0.5);
    case "left_side":
      return new THREE.Vector3(-width * 0.5, height * 0.5, 0);
    case "right_side":
      return new THREE.Vector3(width * 0.5, height * 0.5, 0);
    case "tabletop":
      return new THREE.Vector3(0, height, 0);
    default:
      return new THREE.Vector3(0, height * 0.5, 0);
  }
}
