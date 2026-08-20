import * as THREE from "three";
import type {
  AnimationClip,
  EntityKind,
  EntityState,
  Pose,
} from "./sceneRenderTypes";
import type { ParametricPrimitive } from "../workspace/modeling/parametricGeometry";

export type AnimationCompletion = Readonly<{
  entityId: string;
  clip: AnimationClip;
  generation: number;
}>;

export type ProceduralEntity = THREE.Group & {
  userData: {
    entityId?: string;
    animationPhase?: number;
    primaryMaterials?: THREE.MeshStandardMaterial[];
    accentMaterials?: THREE.MeshStandardMaterial[];
    rig?: HumanoidRig;
    animalRig?: AnimalRig;
    effectParticles?: THREE.Object3D[];
    playbackRuntime?: PlaybackRuntime;
    poweredLights?: THREE.Light[];
    [key: string]: unknown;
  };
};

type HumanoidRig = {
  body: THREE.Group;
  head: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
};

type AnimalRig = {
  body: THREE.Object3D;
  head: THREE.Object3D;
  legs: THREE.Object3D[];
  tail?: THREE.Object3D;
  bodyY: number;
  headY: number;
};

type PlaybackRuntime = {
  key: string;
  elapsed: number;
  completed: boolean;
};

export const PROCEDURAL_CLIP_DURATIONS: Readonly<Record<AnimationClip, number>> = Object.freeze({
  idle: 2,
  walk: 1.2,
  run: 0.72,
  enter: 0.6,
  exit: 0.6,
});

type Palette = {
  primary: number;
  accent: number;
  dark: number;
  light: number;
};

const KIND_PALETTES: Record<EntityKind, Palette> = {
  character: { primary: 0x5a78a8, accent: 0xd9a37d, dark: 0x24334a, light: 0xf0dbc5 },
  animal: { primary: 0xa97c54, accent: 0xd5b48f, dark: 0x4e3928, light: 0xeadac6 },
  prop: { primary: 0xa87848, accent: 0xd4b483, dark: 0x4a3524, light: 0xe9d4b5 },
  structure: { primary: 0xa9aca8, accent: 0xcf835f, dark: 0x535b5a, light: 0xe8e6df },
  effect: { primary: 0x69b9d0, accent: 0xffcc66, dark: 0x34667a, light: 0xd9f5ff },
  primitive: { primary: 0x7a8c86, accent: 0xd8906f, dark: 0x344541, light: 0xdde7e2 },
};

function flatMaterial(
  color: number,
  options: Partial<THREE.MeshStandardMaterialParameters> = {},
): THREE.MeshStandardMaterial {
  const result = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.82,
    metalness: 0.02,
    flatShading: true,
    ...options,
  });
  result.userData.defaultColor = result.color.getHex();
  return result;
}

function mesh(
  geometry: THREE.BufferGeometry,
  material: THREE.MeshStandardMaterial,
  name?: string,
): THREE.Mesh {
  const result = new THREE.Mesh(geometry, material);
  if (name) result.name = name;
  result.castShadow = true;
  result.receiveShadow = true;
  return result;
}

function addBox(
  parent: THREE.Object3D,
  size: [number, number, number],
  position: [number, number, number],
  material: THREE.MeshStandardMaterial,
  name?: string,
): THREE.Mesh {
  const part = mesh(new THREE.BoxGeometry(...size), material, name);
  part.position.set(...position);
  parent.add(part);
  return part;
}

function addCylinder(
  parent: THREE.Object3D,
  radiusTop: number,
  radiusBottom: number,
  height: number,
  position: [number, number, number],
  material: THREE.MeshStandardMaterial,
  radialSegments = 8,
  name?: string,
): THREE.Mesh {
  const part = mesh(
    new THREE.CylinderGeometry(radiusTop, radiusBottom, height, radialSegments),
    material,
    name,
  );
  part.position.set(...position);
  parent.add(part);
  return part;
}

function registerMaterials(
  root: ProceduralEntity,
  primary: THREE.MeshStandardMaterial[],
  accent: THREE.MeshStandardMaterial[] = [],
): void {
  root.userData.primaryMaterials = primary;
  root.userData.accentMaterials = accent;
}

function socket(parent: THREE.Object3D, name: string, x: number, y: number, z: number): THREE.Object3D {
  const anchor = new THREE.Object3D();
  anchor.name = `socket:${name}`;
  anchor.position.set(x, y, z);
  parent.add(anchor);
  return anchor;
}

function createHumanoid(palette: Palette): ProceduralEntity {
  const root = new THREE.Group() as ProceduralEntity;
  const clothes = flatMaterial(palette.primary);
  const skin = flatMaterial(palette.light);
  const dark = flatMaterial(palette.dark);
  const body = new THREE.Group();
  body.name = "rig:body";
  root.add(body);

  addCylinder(body, 0.23, 0.29, 0.7, [0, 1.15, 0], clothes, 7);
  addCylinder(body, 0.17, 0.19, 0.22, [0, 0.72, 0], dark, 7);

  const head = new THREE.Group();
  head.name = "rig:head";
  head.position.set(0, 1.66, 0);
  head.add(mesh(new THREE.IcosahedronGeometry(0.23, 1), skin));
  body.add(head);

  const makeLimb = (
    name: string,
    x: number,
    y: number,
    length: number,
    radius: number,
    material: THREE.MeshStandardMaterial,
  ): THREE.Group => {
    const pivot = new THREE.Group();
    pivot.name = name;
    pivot.position.set(x, y, 0);
    const limb = addCylinder(pivot, radius * 0.82, radius, length, [0, -length / 2, 0], material, 7);
    limb.rotation.z = 0;
    body.add(pivot);
    return pivot;
  };

  const leftArm = makeLimb("rig:left_arm", -0.34, 1.39, 0.62, 0.09, clothes);
  const rightArm = makeLimb("rig:right_arm", 0.34, 1.39, 0.62, 0.09, clothes);
  const leftLeg = makeLimb("rig:left_leg", -0.15, 0.72, 0.72, 0.11, dark);
  const rightLeg = makeLimb("rig:right_leg", 0.15, 0.72, 0.72, 0.11, dark);

  socket(head, "head", 0, 0.24, 0);
  socket(body, "torso", 0, 1.17, 0.15);
  socket(leftArm, "left_hand", 0, -0.64, 0);
  socket(rightArm, "right_hand", 0, -0.64, 0);
  socket(body, "back", 0, 1.23, -0.22);
  socket(root, "feet", 0, 0.02, 0);

  root.userData.rig = { body, head, leftArm, rightArm, leftLeg, rightLeg };
  registerMaterials(root, [clothes], [skin, dark]);
  return root;
}

function createQuadruped(palette: Palette, bird: boolean): ProceduralEntity {
  const root = new THREE.Group() as ProceduralEntity;
  const primary = flatMaterial(palette.primary);
  const accent = flatMaterial(palette.accent);
  const legs: THREE.Object3D[] = [];
  let body: THREE.Object3D;
  let head: THREE.Object3D;
  let tail: THREE.Object3D | undefined;
  if (bird) {
    body = mesh(new THREE.IcosahedronGeometry(0.32, 1), primary);
    body.scale.set(0.85, 1.1, 1.1);
    body.position.y = 0.45;
    root.add(body);
    head = mesh(new THREE.IcosahedronGeometry(0.2, 1), accent);
    head.position.set(0, 0.82, 0.15);
    root.add(head);
    addBox(root, [0.1, 0.08, 0.24], [0, 0.8, 0.37], accent);
    legs.push(addCylinder(root, 0.025, 0.035, 0.34, [-0.1, 0.17, 0], accent, 6));
    legs.push(addCylinder(root, 0.025, 0.035, 0.34, [0.1, 0.17, 0], accent, 6));
  } else {
    body = mesh(new THREE.IcosahedronGeometry(0.42, 1), primary);
    body.scale.set(0.78, 0.65, 1.3);
    body.position.set(0, 0.67, 0);
    root.add(body);
    head = mesh(new THREE.IcosahedronGeometry(0.28, 1), accent);
    head.position.set(0, 0.82, 0.57);
    root.add(head);
    for (const x of [-0.24, 0.24]) {
      for (const z of [-0.34, 0.34]) {
        legs.push(addCylinder(root, 0.055, 0.075, 0.52, [x, 0.3, z], primary, 7));
      }
    }
    tail = addCylinder(root, 0.035, 0.07, 0.6, [0, 0.75, -0.65], primary, 7);
    tail.rotation.x = Math.PI / 3;
  }
  socket(root, "head", 0, 0.95, 0.45);
  socket(root, "torso", 0, 0.72, 0);
  socket(root, "back", 0, 0.9, -0.1);
  socket(root, "feet", 0, 0, 0);
  root.userData.animalRig = {
    body,
    head,
    legs,
    ...(tail ? { tail } : {}),
    bodyY: body.position.y,
    headY: head.position.y,
  };
  registerMaterials(root, [primary], [accent]);
  return root;
}

function createTable(palette: Palette): ProceduralEntity {
  const root = new THREE.Group() as ProceduralEntity;
  const wood = flatMaterial(palette.primary);
  const edge = flatMaterial(palette.dark);
  addBox(root, [1.7, 0.13, 0.9], [0, 0.78, 0], wood);
  for (const x of [-0.7, 0.7]) {
    for (const z of [-0.3, 0.3]) addBox(root, [0.12, 0.72, 0.12], [x, 0.36, z], edge);
  }
  socket(root, "top", 0, 0.86, 0);
  socket(root, "tabletop", 0, 0.86, 0);
  registerMaterials(root, [wood], [edge]);
  return root;
}

function createChair(palette: Palette): ProceduralEntity {
  const root = new THREE.Group() as ProceduralEntity;
  const wood = flatMaterial(palette.primary);
  const dark = flatMaterial(palette.dark);
  addBox(root, [0.62, 0.12, 0.58], [0, 0.5, 0], wood);
  addBox(root, [0.62, 0.72, 0.1], [0, 0.84, -0.24], wood);
  for (const x of [-0.23, 0.23]) {
    for (const z of [-0.2, 0.2]) addBox(root, [0.08, 0.48, 0.08], [x, 0.24, z], dark);
  }
  socket(root, "seat", 0, 0.58, 0);
  socket(root, "top", 0, 1.2, -0.24);
  registerMaterials(root, [wood], [dark]);
  return root;
}

function createBoxProp(palette: Palette): ProceduralEntity {
  const root = new THREE.Group() as ProceduralEntity;
  const primary = flatMaterial(palette.primary);
  const accent = flatMaterial(palette.dark);
  // Matches box_small_02's authoritative manifest bounds: 0.32 × 0.24 × 0.28 m.
  // The origin remains ground-center and the lid's rear edge is its hinge.
  addBox(root, [0.32, 0.2, 0.28], [0, 0.1, 0], primary);
  const lidPivot = new THREE.Group();
  lidPivot.name = "state:lid";
  lidPivot.position.set(0, 0.2, -0.14);
  addBox(lidPivot, [0.32, 0.04, 0.28], [0, 0.02, 0.14], accent);
  root.add(lidPivot);
  socket(root, "top", 0, 0.24, 0);
  registerMaterials(root, [primary], [accent]);
  return root;
}

function createBook(palette: Palette): ProceduralEntity {
  const root = new THREE.Group() as ProceduralEntity;
  const cover = flatMaterial(palette.primary);
  const pages = flatMaterial(0xf2e4c6);
  addBox(root, [0.48, 0.08, 0.68], [0, 0.07, 0], pages);
  addBox(root, [0.52, 0.025, 0.72], [0, 0.125, 0], cover);
  addBox(root, [0.52, 0.025, 0.72], [0, 0.015, 0], cover);
  registerMaterials(root, [cover], [pages]);
  return root;
}

function createLamp(palette: Palette): ProceduralEntity {
  const root = new THREE.Group() as ProceduralEntity;
  const metal = flatMaterial(palette.dark);
  const shade = flatMaterial(palette.accent, {
    emissive: new THREE.Color(0xffb84d),
    emissiveIntensity: 0.2,
  });
  addCylinder(root, 0.28, 0.32, 0.08, [0, 0.04, 0], metal, 12);
  addCylinder(root, 0.035, 0.05, 0.86, [0, 0.5, 0], metal, 8);
  const lampShade = mesh(new THREE.ConeGeometry(0.36, 0.44, 12, 1, true), shade, "state:bulb");
  lampShade.position.y = 1.03;
  root.add(lampShade);
  const light = new THREE.PointLight(0xffc477, 0, 6, 2);
  light.name = "state:powered-light";
  light.position.y = 0.93;
  root.add(light);
  root.userData.poweredLights = [light];
  socket(root, "top", 0, 1.25, 0);
  registerMaterials(root, [shade], [metal]);
  return root;
}

function createDoor(palette: Palette): ProceduralEntity {
  const root = new THREE.Group() as ProceduralEntity;
  const frame = flatMaterial(palette.light);
  const panelMaterial = flatMaterial(palette.primary);
  addBox(root, [1.25, 0.14, 0.18], [0, 2.05, 0], frame);
  addBox(root, [0.14, 2.1, 0.18], [-0.56, 1.04, 0], frame);
  addBox(root, [0.14, 2.1, 0.18], [0.56, 1.04, 0], frame);
  const pivot = new THREE.Group();
  pivot.name = "state:door-panel";
  pivot.position.set(-0.48, 0, 0);
  addBox(pivot, [0.96, 1.94, 0.1], [0.48, 0.98, 0], panelMaterial);
  const knob = flatMaterial(0xd3a94b, { metalness: 0.55 });
  const handle = mesh(new THREE.SphereGeometry(0.055, 8, 6), knob);
  handle.position.set(0.84, 0.98, 0.08);
  pivot.add(handle);
  root.add(pivot);
  socket(root, "center", 0, 1, 0);
  socket(root, "top", 0, 2.15, 0);
  registerMaterials(root, [panelMaterial], [frame]);
  return root;
}

function createWindow(palette: Palette): ProceduralEntity {
  const root = new THREE.Group() as ProceduralEntity;
  const frame = flatMaterial(palette.light);
  const glass = flatMaterial(0x9bcbd6, { transparent: true, opacity: 0.42, roughness: 0.25 });
  addBox(root, [1.5, 0.1, 0.12], [0, 1.7, 0], frame);
  addBox(root, [1.5, 0.1, 0.12], [0, 0.5, 0], frame);
  addBox(root, [0.1, 1.3, 0.12], [-0.7, 1.1, 0], frame);
  addBox(root, [0.1, 1.3, 0.12], [0.7, 1.1, 0], frame);
  addBox(root, [0.08, 1.2, 0.12], [0, 1.1, 0], frame);
  addBox(root, [1.4, 0.06, 0.12], [0, 1.1, 0], frame);
  addBox(root, [1.35, 1.1, 0.03], [0, 1.1, -0.02], glass);
  registerMaterials(root, [glass], [frame]);
  return root;
}

function createStructure(palette: Palette, tokens: string): ProceduralEntity {
  if (tokens.includes("door")) return createDoor(palette);
  if (tokens.includes("window")) return createWindow(palette);
  const root = new THREE.Group() as ProceduralEntity;
  const primary = flatMaterial(palette.primary);
  const accent = flatMaterial(palette.accent);
  addBox(root, [2.6, 1.8, 1.8], [0, 0.9, 0], primary);
  addBox(root, [0.72, 1.25, 0.08], [0, 0.625, 0.93], accent);
  for (const x of [-0.82, 0.82]) addBox(root, [0.5, 0.5, 0.08], [x, 1.15, 0.93], accent);
  registerMaterials(root, [primary], [accent]);
  return root;
}

function createTree(palette: Palette): ProceduralEntity {
  const root = new THREE.Group() as ProceduralEntity;
  const trunk = flatMaterial(0x79573a);
  const leaf = flatMaterial(0x668b62);
  addCylinder(root, 0.16, 0.23, 1.35, [0, 0.675, 0], trunk, 7);
  for (const [x, y, z, scale] of [
    [0, 1.6, 0, 0.72],
    [-0.35, 1.45, 0.08, 0.55],
    [0.32, 1.48, -0.08, 0.52],
    [0.05, 1.94, 0, 0.5],
  ] as const) {
    const crown = mesh(new THREE.IcosahedronGeometry(scale, 1), leaf);
    crown.position.set(x, y, z);
    root.add(crown);
  }
  registerMaterials(root, [leaf], [trunk]);
  return root;
}

function createVehicle(palette: Palette): ProceduralEntity {
  const root = new THREE.Group() as ProceduralEntity;
  const body = flatMaterial(palette.primary);
  const dark = flatMaterial(0x242a2b);
  const glass = flatMaterial(0x7097a1, { metalness: 0.12, roughness: 0.3 });
  addBox(root, [1.8, 0.48, 0.86], [0, 0.48, 0], body);
  addBox(root, [0.92, 0.38, 0.78], [-0.08, 0.85, 0], glass);
  for (const x of [-0.62, 0.62]) {
    for (const z of [-0.48, 0.48]) {
      const wheel = addCylinder(root, 0.2, 0.2, 0.13, [x, 0.28, z], dark, 12);
      wheel.rotation.x = Math.PI / 2;
    }
  }
  registerMaterials(root, [body], [glass, dark]);
  return root;
}

function createGenericProp(palette: Palette): ProceduralEntity {
  const root = new THREE.Group() as ProceduralEntity;
  const primary = flatMaterial(palette.primary);
  const accent = flatMaterial(palette.accent);
  addCylinder(root, 0.28, 0.34, 0.55, [0, 0.275, 0], primary, 8);
  const top = mesh(new THREE.IcosahedronGeometry(0.2, 1), accent);
  top.position.y = 0.67;
  root.add(top);
  registerMaterials(root, [primary], [accent]);
  return root;
}

function createEffect(palette: Palette, tokens: string): ProceduralEntity {
  const root = new THREE.Group() as ProceduralEntity;
  const content = new THREE.Group();
  content.name = "effect:content";
  root.add(content);
  const color = tokens.includes("fire") ? 0xff8b38 : tokens.includes("snow") ? 0xe8f6ff : palette.primary;
  const particles: THREE.Object3D[] = [];
  const material = flatMaterial(color, {
    emissive: new THREE.Color(color),
    emissiveIntensity: tokens.includes("fire") ? 0.75 : 0.12,
    transparent: true,
    opacity: 0.7,
  });
  const count = tokens.includes("fog") || tokens.includes("smoke") ? 9 : 18;
  for (let index = 0; index < count; index += 1) {
    const size = tokens.includes("fog") ? 0.32 : 0.055 + (index % 3) * 0.025;
    const particle = mesh(
      tokens.includes("rain")
        ? new THREE.BoxGeometry(0.018, 0.34, 0.018)
        : new THREE.IcosahedronGeometry(size, 0),
      material,
    );
    const angle = index * 2.399963;
    const radius = 0.12 + (index % 6) * 0.13;
    particle.position.set(Math.cos(angle) * radius, 0.1 + (index % 7) * 0.19, Math.sin(angle) * radius);
    particle.userData.animationBasePosition = particle.position.clone();
    particle.userData.animationBaseRotationY = particle.rotation.y;
    content.add(particle);
    particles.push(particle);
  }
  root.userData.effectParticles = particles;
  registerMaterials(root, [material]);
  return root;
}

function createPrimitive(palette: Palette, tokens: string): ProceduralEntity {
  const root = new THREE.Group() as ProceduralEntity;
  const material = flatMaterial(palette.primary);
  let geometry: THREE.BufferGeometry;
  if (tokens.includes("sphere")) geometry = new THREE.IcosahedronGeometry(0.5, 2);
  else if (tokens.includes("cylinder")) geometry = new THREE.CylinderGeometry(0.4, 0.4, 1, 10);
  else if (tokens.includes("capsule")) geometry = new THREE.CapsuleGeometry(0.32, 0.55, 4, 8);
  else if (tokens.includes("plane")) geometry = new THREE.BoxGeometry(1.2, 0.04, 1.2);
  else geometry = new THREE.BoxGeometry(0.9, 0.9, 0.9);
  const shape = mesh(geometry, material);
  const bounds = new THREE.Box3().setFromObject(shape);
  shape.position.y = -bounds.min.y;
  root.add(shape);
  registerMaterials(root, [material]);
  return root;
}

function orientPrimitiveGeometry(
  geometry: THREE.BufferGeometry,
  axis: "x" | "y" | "z",
  sourceAxis: "y" | "z",
): void {
  if (sourceAxis === "y") {
    if (axis === "x") geometry.rotateZ(-Math.PI / 2);
    else if (axis === "z") geometry.rotateX(Math.PI / 2);
    return;
  }
  if (axis === "x") geometry.rotateY(Math.PI / 2);
  else if (axis === "y") geometry.rotateX(-Math.PI / 2);
}

function exactPrimitiveGeometry(definition: ParametricPrimitive): THREE.BufferGeometry {
  switch (definition.kind) {
    case "box":
      return new THREE.BoxGeometry(definition.sizeM.x, definition.sizeM.y, definition.sizeM.z);
    case "sphere":
      return new THREE.SphereGeometry(definition.radiusM, 48, 24);
    case "cylinder": {
      const geometry = new THREE.CylinderGeometry(
        definition.radiusM,
        definition.radiusM,
        definition.heightM,
        48,
        1,
        false,
      );
      orientPrimitiveGeometry(geometry, definition.axis, "y");
      return geometry;
    }
    case "cone": {
      const geometry = new THREE.ConeGeometry(definition.radiusM, definition.heightM, 48, 1, false);
      orientPrimitiveGeometry(geometry, definition.axis, "y");
      return geometry;
    }
    case "capsule": {
      const geometry = new THREE.CapsuleGeometry(
        definition.radiusM,
        definition.cylinderHeightM,
        12,
        24,
      );
      orientPrimitiveGeometry(geometry, definition.axis, "y");
      return geometry;
    }
    case "plane": {
      const geometry = new THREE.PlaneGeometry(definition.sizeM.x, definition.sizeM.y, 1, 1);
      orientPrimitiveGeometry(geometry, definition.normalAxis, "z");
      return geometry;
    }
  }
}

function syncExactParametricEntity(entity: EntityState, root: ProceduralEntity): void {
  const source = entity.renderGeometry;
  if (!source || source.kind !== "parametric") return;
  const currentDigest = root.userData.parametricGeometryDigest;
  let shape = root.getObjectByName("parametric:shape");
  if (!(shape instanceof THREE.Mesh) || currentDigest !== source.digest) {
    if (shape) disposeObject(shape);
    const material = flatMaterial(new THREE.Color(source.material.baseColor).getHex(), {
      metalness: source.material.metallic,
      roughness: source.material.roughness,
      opacity: source.material.opacity,
      transparent: source.material.opacity < 1,
      depthWrite: source.material.opacity >= 1,
      emissive: new THREE.Color(source.material.emissiveColor),
      emissiveIntensity: source.material.emissiveIntensity,
      flatShading: false,
    });
    shape = mesh(exactPrimitiveGeometry(source.definition), material, "parametric:shape");
    shape.castShadow = source.castShadow;
    shape.receiveShadow = source.receiveShadow;
    root.add(shape);
    registerMaterials(root, [material]);
    root.userData.parametricGeometryDigest = source.digest;
  }
  if (shape instanceof THREE.Mesh) {
    shape.castShadow = source.castShadow;
    shape.receiveShadow = source.receiveShadow;
    const materials = Array.isArray(shape.material) ? shape.material : [shape.material];
    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      material.metalness = source.material.metallic;
      material.roughness = source.material.roughness;
      material.opacity = source.material.opacity;
      material.transparent = source.material.opacity < 1;
      material.depthWrite = source.material.opacity >= 1;
      material.emissive.set(source.material.emissiveColor);
      material.emissiveIntensity = source.material.emissiveIntensity;
      material.needsUpdate = true;
    }
  }
}

export function classifyAsset(entity: Pick<EntityState, "kind" | "assetId" | "label" | "tags">): string {
  const tokens = `${entity.assetId} ${entity.label} ${entity.tags.join(" ")}`.toLowerCase();
  if (entity.kind === "character") return "humanoid";
  if (entity.kind === "animal") return tokens.includes("bird") ? "bird" : "quadruped";
  if (entity.kind === "effect") return "effect";
  if (entity.kind === "structure") {
    if (tokens.includes("door")) return "door";
    if (tokens.includes("window")) return "window";
    return "structure";
  }
  if (entity.kind === "primitive") {
    for (const primitive of ["sphere", "cylinder", "capsule", "plane"] as const) {
      if (tokens.includes(primitive)) return primitive;
    }
    return "cube";
  }
  if (/table|desk/.test(tokens)) return "table";
  if (/chair|stool|seat/.test(tokens)) return "chair";
  if (/box|chest|case/.test(tokens)) return "box";
  if (/book|notebook|journal/.test(tokens)) return "book";
  if (/lamp|light|lantern/.test(tokens)) return "lamp";
  if (/tree|plant|shrub/.test(tokens)) return "tree";
  if (/car|vehicle|truck|van/.test(tokens)) return "vehicle";
  return "generic-prop";
}

export function createProceduralEntity(entity: EntityState): ProceduralEntity {
  if (entity.renderGeometry?.kind === "assembly") {
    const root = new THREE.Group() as ProceduralEntity;
    root.name = `entity:${entity.id}`;
    root.userData.entityId = entity.id;
    root.userData.renderIdentity = "assembly";
    return root;
  }
  if (entity.renderGeometry?.kind === "parametric") {
    const root = new THREE.Group() as ProceduralEntity;
    root.name = `entity:${entity.id}`;
    root.userData.entityId = entity.id;
    root.userData.animationPhase = stablePhase(entity.id);
    root.userData.renderIdentity = "parametric";
    syncExactParametricEntity(entity, root);
    root.traverse((object) => { object.userData.entityId = entity.id; });
    return root;
  }
  const palette = KIND_PALETTES[entity.kind];
  const tokens = `${entity.assetId} ${entity.label} ${entity.tags.join(" ")}`.toLowerCase();
  let root: ProceduralEntity;
  switch (classifyAsset(entity)) {
    case "humanoid":
      root = createHumanoid(palette);
      break;
    case "bird":
      root = createQuadruped(palette, true);
      break;
    case "quadruped":
      root = createQuadruped(palette, false);
      break;
    case "door":
    case "window":
    case "structure":
      root = createStructure(palette, tokens);
      break;
    case "table":
      root = createTable(palette);
      break;
    case "chair":
      root = createChair(palette);
      break;
    case "box":
      root = createBoxProp(palette);
      break;
    case "book":
      root = createBook(palette);
      break;
    case "lamp":
      root = createLamp(palette);
      break;
    case "tree":
      root = createTree(palette);
      break;
    case "vehicle":
      root = createVehicle(palette);
      break;
    case "effect":
      root = createEffect(palette, tokens);
      break;
    case "sphere":
    case "cylinder":
    case "capsule":
    case "plane":
    case "cube":
      root = createPrimitive(palette, tokens);
      break;
    default:
      root = createGenericProp(palette);
  }
  root.name = `entity:${entity.id}`;
  root.userData.entityId = entity.id;
  root.userData.animationPhase = stablePhase(entity.id);
  root.traverse((object) => {
    object.userData.entityId = entity.id;
  });
  return root;
}

function stablePhase(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1000) / 1000 * Math.PI * 2;
}

export function findSocket(parent: THREE.Object3D, requested?: string): THREE.Object3D {
  const normalized = requested?.replace(/^socket:/, "") ?? "torso";
  const direct = parent.getObjectByName(`socket:${normalized}`);
  if (direct) return direct;
  return (
    parent.getObjectByName("socket:torso") ??
    parent.getObjectByName("socket:center") ??
    parent
  );
}

export function applyEntityAppearance(entity: EntityState, root: ProceduralEntity): void {
  syncExactParametricEntity(entity, root);
  for (const material of [
    ...(root.userData.primaryMaterials ?? []),
    ...(root.userData.accentMaterials ?? []),
  ]) {
    const defaultColor = material.userData.defaultColor;
    if (typeof defaultColor === "number") material.color.setHex(defaultColor);
  }
  const requestedColor = entity.appearance.color;
  if (requestedColor) {
    for (const material of root.userData.primaryMaterials ?? []) material.color.set(requestedColor);
  }
  const variant = entity.appearance.variant?.toLowerCase() ?? "";
  if (!requestedColor && variant) {
    const variantColor =
      variant.includes("red") ? 0xc4554d
      : variant.includes("blue") ? 0x4d79af
      : variant.includes("green") ? 0x638c68
      : variant.includes("dark") ? 0x4d4b49
      : variant.includes("light") ? 0xd7c4a5
      : undefined;
    if (variantColor !== undefined) {
      for (const material of root.userData.primaryMaterials ?? []) material.color.setHex(variantColor);
    }
  }
  for (const [name, value] of Object.entries(entity.appearance.materialOverrides ?? {})) {
    const target = root.getObjectByName(name);
    if (!(target instanceof THREE.Mesh) || !(target.material instanceof THREE.MeshStandardMaterial)) continue;
    try {
      target.material.color.set(value);
    } catch {
      // Runtime state remains authoritative even if a non-color override is not visualizable.
    }
  }
  syncAppearanceAccessories(entity, root);
}

function syncAppearanceAccessories(entity: EntityState, root: ProceduralEntity): void {
  const existing: THREE.Object3D[] = [];
  root.traverse((object) => {
    if (object.userData.appearanceAccessory === true) existing.push(object);
  });
  for (const object of existing) disposeObject(object);
  const requested = entity.appearance.accessories ?? [];
  if (!requested.length) return;
  for (const [index, name] of requested.entries()) {
    const token = name.toLowerCase();
    const color = index % 2 ? 0xd7a469 : 0x4f666d;
    const accessoryMaterial = flatMaterial(color);
    const visual = new THREE.Group();
    visual.name = `appearance:accessory:${name}`;
    visual.userData.appearanceAccessory = true;
    if (/hat|cap|crown/.test(token)) {
      addCylinder(visual, 0.19, 0.25, 0.16, [0, 0, 0], accessoryMaterial, 9);
      const target = findSocket(root, "head");
      visual.position.set(0, 0.1 + index * 0.04, 0);
      target.add(visual);
    } else if (/bag|backpack|quiver/.test(token)) {
      addBox(visual, [0.32, 0.42, 0.18], [0, 0, 0], accessoryMaterial);
      findSocket(root, "back").add(visual);
    } else {
      const bead = mesh(new THREE.IcosahedronGeometry(0.09, 1), accessoryMaterial);
      visual.add(bead);
      visual.position.set(index * 0.12, 0, 0);
      findSocket(root, "torso").add(visual);
    }
  }
}

export function applyEntityState(entity: EntityState, root: ProceduralEntity): void {
  const state = entity.state;
  root.visible = state.type === "prop" ? state.visible !== false : state.type !== "effect" || state.enabled;
  if (state.type === "character") applyHumanoidPose(root, state.pose ?? "standing");

  if (state.type === "prop") {
    const lid = root.getObjectByName("state:lid");
    if (lid) lid.rotation.x = state.open ? -Math.PI * 0.58 : 0;
    const door = root.getObjectByName("state:door-panel");
    if (door) door.rotation.y = state.open ? -Math.PI * 0.52 : 0;
    const powered = state.powered ?? false;
    for (const light of root.userData.poweredLights ?? []) light.intensity = powered ? 1.4 : 0;
    const bulb = root.getObjectByName("state:bulb");
    if (bulb instanceof THREE.Mesh && bulb.material instanceof THREE.MeshStandardMaterial) {
      bulb.material.emissiveIntensity = powered ? 1.35 : 0.16;
    }
  }
  if (state.type === "generic") {
    const open = state.properties?.open === true;
    const powered = state.properties?.powered === true;
    const visible = state.properties?.visible;
    const door = root.getObjectByName("state:door-panel");
    if (door) door.rotation.y = open ? -Math.PI * 0.52 : 0;
    const lid = root.getObjectByName("state:lid");
    if (lid) lid.rotation.x = open ? -Math.PI * 0.58 : 0;
    for (const light of root.userData.poweredLights ?? []) light.intensity = powered ? 1.4 : 0;
    if (typeof visible === "boolean") root.visible = visible;
  }
  if (state.type === "effect") {
    const intensity = Math.max(0, state.intensity ?? 1);
    root.getObjectByName("effect:content")?.scale.setScalar(Math.max(0.05, Math.sqrt(intensity)));
  }
}

export function applyHumanoidPose(root: ProceduralEntity, pose: Pose): void {
  const rig = root.userData.rig;
  if (!rig) return;
  rig.body.rotation.set(0, 0, 0);
  rig.body.position.set(0, 0, 0);
  rig.leftArm.rotation.set(0, 0, -0.04);
  rig.rightArm.rotation.set(0, 0, 0.04);
  rig.leftLeg.rotation.set(0, 0, 0);
  rig.rightLeg.rotation.set(0, 0, 0);
  switch (pose) {
    case "sitting":
      rig.body.position.y = -0.28;
      rig.leftLeg.rotation.x = -Math.PI / 2;
      rig.rightLeg.rotation.x = -Math.PI / 2;
      break;
    case "lying":
      rig.body.rotation.z = -Math.PI / 2;
      rig.body.position.set(0, -0.02, 0);
      break;
    case "kneeling":
      rig.body.position.y = -0.38;
      rig.leftLeg.rotation.x = -1.1;
      rig.rightLeg.rotation.x = -1.1;
      break;
    case "standing":
    default:
      break;
  }
}

export function updateEntityAnimation(
  entity: EntityState,
  root: ProceduralEntity,
  _elapsedSeconds: number,
  deltaSeconds = 0,
  reducedMotion = false,
  onComplete?: (completion: AnimationCompletion) => void,
  paused = false,
): void {
  const playback = animationPlayback(entity);
  if (!playback) return;
  const { clip, playing, loop, speed, generation } = playback;
  const key = `${clip}:${playing}:${loop}:${speed}:${generation}`;
  let runtime = root.userData.playbackRuntime;
  if (!runtime || runtime.key !== key) {
    runtime = { key, elapsed: 0, completed: false };
    root.userData.playbackRuntime = runtime;
  }

  if (paused) {
    resetProceduralAnimation(entity, root);
    const pausedMixer = root.userData.animationMixer;
    if (pausedMixer instanceof THREE.AnimationMixer) pausedMixer.stopAllAction();
    root.userData.activeAnimation = `${key}:paused`;
    return;
  }

  const mixer = root.userData.animationMixer;
  const clips = root.userData.animationClips;
  const normalizedClip = clip.toLowerCase().replaceAll("_", "");
  const animationClip = Array.isArray(clips)
    ? clips.find((candidate): candidate is THREE.AnimationClip => candidate instanceof THREE.AnimationClip
      && candidate.name.toLowerCase().replaceAll(/[\s_-]/g, "").includes(normalizedClip))
    : undefined;
  const clipDuration = animationClip && animationClip.duration > 0
    ? animationClip.duration
    : PROCEDURAL_CLIP_DURATIONS[clip];
  if (playing && !reducedMotion) runtime.elapsed += Math.max(0, deltaSeconds) * speed;
  const clipTime = loop
    ? runtime.elapsed % clipDuration
    : Math.min(runtime.elapsed, clipDuration);
  const phase = clipTime + (root.userData.animationPhase ?? 0);

  resetProceduralAnimation(entity, root);
  if (mixer instanceof THREE.AnimationMixer && Array.isArray(clips)) {
    const animationKey = `${key}:${reducedMotion}`;
    if (root.userData.activeAnimation !== animationKey) {
      mixer.stopAllAction();
      if (playing && !reducedMotion) {
        if (animationClip) {
          const action = mixer.clipAction(animationClip).reset();
          action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
          action.clampWhenFinished = !loop;
          action.setEffectiveTimeScale(speed);
          action.play();
        }
      }
      root.userData.activeAnimation = animationKey;
    }
    if (!reducedMotion && playing) mixer.update(deltaSeconds);
  }

  if (playing && !reducedMotion && root.userData.rig) {
    const { rig } = root.userData;
    const pose = entity.state.type === "character" ? entity.state.pose ?? "standing" : "standing";
    if (pose === "standing") {
      if (clip === "walk" || clip === "run") {
        const rate = clip === "run" ? Math.PI * 2 / PROCEDURAL_CLIP_DURATIONS.run : Math.PI * 2 / PROCEDURAL_CLIP_DURATIONS.walk;
        const amount = clip === "run" ? 0.7 : 0.43;
        const swing = Math.sin(phase * rate) * amount;
        rig.leftArm.rotation.x = swing;
        rig.rightArm.rotation.x = -swing;
        rig.leftLeg.rotation.x = -swing;
        rig.rightLeg.rotation.x = swing;
        rig.body.position.y = Math.abs(Math.sin(phase * rate)) * 0.025;
      } else if (clip === "enter" || clip === "exit") {
        const progress = Math.min(1, clipTime / clipDuration);
        const offset = clip === "enter" ? -0.32 * (1 - progress) : -0.32 * progress;
        rig.body.position.y = offset;
        rig.leftArm.rotation.x = (1 - Math.abs(progress * 2 - 1)) * 0.32;
        rig.rightArm.rotation.x = -rig.leftArm.rotation.x;
      } else {
        rig.body.position.y = Math.sin(phase * 1.7) * 0.007;
        rig.head.rotation.y = Math.sin(phase * 0.65) * 0.025;
      }
    }
  }

  if (playing && !reducedMotion && root.userData.animalRig) {
    const rig = root.userData.animalRig;
    if (clip === "walk" || clip === "run") {
      const rate = Math.PI * 2 / PROCEDURAL_CLIP_DURATIONS[clip];
      const amount = clip === "run" ? 0.58 : 0.34;
      rig.legs.forEach((leg, index) => {
        leg.rotation.x = Math.sin(phase * rate + (index % 2 ? Math.PI : 0)) * amount;
      });
      rig.body.position.y = rig.bodyY + Math.abs(Math.sin(phase * rate)) * (clip === "run" ? 0.055 : 0.025);
      rig.head.rotation.x = Math.sin(phase * rate) * 0.04;
      if (rig.tail) rig.tail.rotation.z = Math.sin(phase * rate) * 0.18;
    } else if (clip === "enter" || clip === "exit") {
      const progress = Math.min(1, clipTime / clipDuration);
      rig.body.position.y = rig.bodyY - 0.22 * (clip === "enter" ? 1 - progress : progress);
      rig.head.position.y = rig.headY - 0.14 * (clip === "enter" ? 1 - progress : progress);
    } else {
      rig.body.position.y = rig.bodyY + Math.sin(phase * Math.PI) * 0.008;
      rig.head.rotation.y = Math.sin(phase * 0.9) * 0.035;
    }
  }

  if (entity.state.type === "effect" && playing && !reducedMotion) {
    const tokens = `${entity.assetId} ${entity.label}`.toLowerCase();
    for (const [index, particle] of (root.userData.effectParticles ?? []).entries()) {
      const base = particle.userData.animationBasePosition;
      if (!(base instanceof THREE.Vector3)) continue;
      if (tokens.includes("rain") || tokens.includes("snow")) {
        const rate = tokens.includes("rain") ? 1.9 : 0.48;
        particle.position.y = positiveModulo(base.y - clipTime * rate, 1.5);
      } else {
        particle.position.y = base.y + Math.sin(phase * 1.4 + index) * 0.045;
        const baseRotation = typeof particle.userData.animationBaseRotationY === "number"
          ? particle.userData.animationBaseRotationY
          : 0;
        particle.rotation.y = baseRotation + clipTime * (0.55 + (index % 3) * 0.18);
      }
    }
  }

  if (playing && !loop && (reducedMotion || runtime.elapsed >= clipDuration) && !runtime.completed) {
    runtime.completed = true;
    onComplete?.({ entityId: entity.id, clip, generation });
  }
}

function animationPlayback(entity: EntityState): Readonly<{
  clip: AnimationClip;
  playing: boolean;
  loop: boolean;
  speed: number;
  generation: number;
}> | undefined {
  const state = entity.state;
  if (state.type !== "character" && state.type !== "effect") return undefined;
  return {
    clip: state.animation ?? "idle",
    playing: state.animationPlaying !== false,
    loop: state.animationLoop ?? true,
    speed: Math.max(0.05, state.animationSpeed ?? 1),
    generation: state.animationGeneration ?? 0,
  };
}

function resetProceduralAnimation(entity: EntityState, root: ProceduralEntity): void {
  if (root.userData.rig) {
    const pose = entity.state.type === "character" ? entity.state.pose ?? "standing" : "standing";
    applyHumanoidPose(root, pose);
    root.userData.rig.head.rotation.y = 0;
  }
  const animal = root.userData.animalRig;
  if (animal) {
    animal.body.position.y = animal.bodyY;
    animal.head.position.y = animal.headY;
    animal.body.rotation.set(0, 0, 0);
    animal.head.rotation.set(0, 0, 0);
    animal.legs.forEach((leg) => leg.rotation.set(0, 0, 0));
    if (animal.tail) {
      animal.tail.rotation.set(Math.PI / 3, 0, 0);
    }
  }
  for (const particle of root.userData.effectParticles ?? []) {
    const base = particle.userData.animationBasePosition;
    if (base instanceof THREE.Vector3) particle.position.copy(base);
    if (typeof particle.userData.animationBaseRotationY === "number") {
      particle.rotation.y = particle.userData.animationBaseRotationY;
    }
  }
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

export function disposeObject(root: THREE.Object3D): void {
  const mixer = root.userData.animationMixer;
  if (mixer instanceof THREE.AnimationMixer) mixer.stopAllAction();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!("geometry" in object) || !(object.geometry instanceof THREE.BufferGeometry)) return;
    object.geometry.dispose();
    if (!("material" in object)) return;
    const objectMaterial = object.material;
    const entries = Array.isArray(objectMaterial) ? objectMaterial : [objectMaterial];
    for (const material of entries) materials.add(material);
  });
  for (const material of materials) material.dispose();
  root.removeFromParent();
}
