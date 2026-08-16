import * as THREE from "three";
import type {
  Dimensions,
  EnvironmentState,
  EntityId,
  LightingState,
  LightState,
} from "./sceneRenderTypes";

const LEGACY_BLANK_DIMENSIONS: Dimensions = { width: 12, height: 4, depth: 12 };
const LEGACY_ROOM_DIMENSIONS: Dimensions = { width: 8, height: 3.2, depth: 7 };
const LEGACY_GRASSLAND_DIMENSIONS: Dimensions = { width: 42, height: 8, depth: 42 };
const LEGACY_STREET_DIMENSIONS: Dimensions = { width: 30, height: 12, depth: 30 };
export const MAX_STAGE_GRID_DIVISIONS = 256;

function material(
  color: number,
  options: Partial<THREE.MeshStandardMaterialParameters> = {},
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.9,
    metalness: 0,
    flatShading: true,
    ...options,
  });
}

function box(
  parent: THREE.Object3D,
  size: [number, number, number],
  position: [number, number, number],
  color: number,
  name?: string,
): THREE.Mesh {
  const result = new THREE.Mesh(new THREE.BoxGeometry(...size), material(color));
  if (name) result.name = name;
  result.position.set(...position);
  result.receiveShadow = true;
  result.castShadow = true;
  parent.add(result);
  return result;
}

function ground(
  parent: THREE.Object3D,
  width: number,
  depth: number,
  color: number,
): THREE.Mesh {
  const result = box(parent, [width, 0.08, depth], [0, -0.04, 0], color, "environment:ground");
  result.receiveShadow = true;
  result.castShadow = false;
  return result;
}

function addBounds(root: THREE.Group, dimensions: Dimensions): void {
  const geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(
    dimensions.width,
    dimensions.height,
    dimensions.depth,
  ));
  const bounds = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({
      color: 0x9ca9a3,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
    }),
  );
  bounds.name = "environment:bounds";
  bounds.position.y = dimensions.height / 2;
  bounds.renderOrder = 1;
  root.add(bounds);
}

function addStage(root: THREE.Group, dimensions: Dimensions): void {
  const { width, depth } = dimensions;
  ground(root, width, depth, 0xd8d3c7);
  // Stage dimensions are semantic extents and legacy 1.0 legitimately allowed
  // very large finite values. Keep those extents in geometry/metadata, but cap
  // the density-derived allocation so an old project cannot ask GridHelper to
  // build billions or trillions of line segments.
  const divisions = Math.max(
    1,
    Math.min(MAX_STAGE_GRID_DIVISIONS, Math.round(Math.max(width, depth))),
  );
  const grid = new THREE.GridHelper(1, divisions, 0x8d948e, 0xbec0b8);
  grid.name = "environment:grid";
  grid.userData.divisions = divisions;
  grid.position.y = 0.006;
  grid.scale.set(width, 1, depth);
  const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
  for (const lineMaterial of materials) {
    lineMaterial.transparent = true;
    lineMaterial.opacity = 0.22;
  }
  root.add(grid);
  addBounds(root, dimensions);
}

function addRoom(root: THREE.Group, dimensions: Dimensions, dark: boolean, bedroom: boolean): void {
  const { width, height, depth } = dimensions;
  const floorColor = dark ? 0x403e3b : 0xb4a58f;
  const wallColor = dark ? 0x34383b : 0xd8d3c8;
  ground(root, width, depth, floorColor);
  box(root, [width, height, 0.12], [0, height / 2, -depth / 2], wallColor, "environment:room:north-wall");
  box(root, [0.12, height, depth], [-width / 2, height / 2, 0], wallColor, "environment:room:west-wall");
  // A short right return preserves the room silhouette without blocking orbit view.
  box(root, [0.12, height, depth * 0.32], [width / 2, height / 2, -depth * 0.34], wallColor, "environment:room:east-return");

  const skirting = dark ? 0x242829 : 0x8b7b68;
  box(root, [width, 0.11, 0.08], [0, 0.055, -depth / 2 + 0.08], skirting);
  box(root, [0.08, 0.11, depth], [-width / 2 + 0.08, 0.055, 0], skirting);

  if (bedroom) {
    const rugWidth = Math.min(3.4, width * 0.55);
    const rugDepth = Math.min(2.3, depth * 0.42);
    const rug = new THREE.Mesh(
      new THREE.BoxGeometry(rugWidth, 0.025, rugDepth),
      material(0x997468, { roughness: 1 }),
    );
    rug.name = "environment:room:rug";
    rug.position.set(width * 0.09, 0.014, depth * 0.1);
    rug.receiveShadow = true;
    root.add(rug);
  }
  addBounds(root, dimensions);
}

function addGrassland(root: THREE.Group, dimensions: Dimensions): void {
  const { width, height, depth } = dimensions;
  ground(root, width, depth, 0x78966b);
  const distant = material(0x5f7f61);
  const horizontalUnit = Math.min(width, depth);
  for (let index = 0; index < 18; index += 1) {
    const angle = index * 2.399963;
    const radiusFactor = 0.24 + (index % 4) * 0.045;
    const moundHeight = Math.max(0.08, height * (0.1 + (index % 5) * 0.025));
    const moundRadius = Math.max(0.04, horizontalUnit * (0.025 + (index % 3) * 0.009));
    const mound = new THREE.Mesh(new THREE.ConeGeometry(moundRadius, moundHeight, 7), distant);
    mound.name = `environment:grass:mound:${index}`;
    mound.position.set(
      Math.cos(angle) * width * radiusFactor,
      moundHeight / 2 - 0.02,
      Math.sin(angle) * depth * radiusFactor,
    );
    mound.receiveShadow = true;
    root.add(mound);
  }
  addBounds(root, dimensions);
}

function addStreet(root: THREE.Group, dimensions: Dimensions): void {
  const { width, height, depth } = dimensions;
  ground(root, width, depth, 0x6e7475);
  const roadWidth = width * 0.36;
  const sidewalkWidth = width * 0.1;
  const buildingBand = Math.max(0.04, (width - roadWidth - sidewalkWidth * 2) / 2);
  box(root, [roadWidth, 0.08, depth], [0, 0.02, 0], 0x3f4648, "environment:street:road");
  box(
    root,
    [sidewalkWidth, 0.18, depth],
    [-(roadWidth + sidewalkWidth) / 2, 0.05, 0],
    0xa9aaa2,
    "environment:street:sidewalk-left",
  );
  box(
    root,
    [sidewalkWidth, 0.18, depth],
    [(roadWidth + sidewalkWidth) / 2, 0.05, 0],
    0xa9aaa2,
    "environment:street:sidewalk-right",
  );
  const stripeMaterial = material(0xe2d28d);
  const stripeCount = Math.max(1, Math.min(24, Math.round(depth / 2.5)));
  const stripeStep = depth / stripeCount;
  for (let index = 0; index < stripeCount; index += 1) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.04, roadWidth * 0.025), 0.025, stripeStep * 0.55), stripeMaterial);
    stripe.name = `environment:street:stripe:${index}`;
    stripe.position.set(0, 0.065, -depth / 2 + (index + 0.5) * stripeStep);
    root.add(stripe);
  }
  const buildingColors = [0x7e8785, 0x8d8178, 0x687777, 0x938c80];
  const segmentDepth = depth / 8;
  for (const side of [-1, 1]) {
    for (let index = 0; index < 8; index += 1) {
      const buildingHeight = height * (0.46 + (index % 4) * 0.13);
      box(
        root,
        [buildingBand * (0.76 + (index % 2) * 0.08), buildingHeight, segmentDepth * 0.8],
        [side * (roadWidth / 2 + sidewalkWidth + buildingBand / 2), buildingHeight / 2, -depth / 2 + (index + 0.5) * segmentDepth],
        buildingColors[index % buildingColors.length],
        `environment:street:building:${side}:${index}`,
      );
    }
  }
  addBounds(root, dimensions);
}

function dimensionsFor(environment: EnvironmentState, preset: string): Dimensions {
  const fallback = /room|interior|bedroom/.test(preset)
    ? LEGACY_ROOM_DIMENSIONS
    : /grass|field|outdoor/.test(preset)
      ? LEGACY_GRASSLAND_DIMENSIONS
      : /street|city|urban/.test(preset)
        ? LEGACY_STREET_DIMENSIONS
        : LEGACY_BLANK_DIMENSIONS;
  return {
    width: positiveDimension(environment.dimensions?.width, fallback.width),
    height: positiveDimension(environment.dimensions?.height, fallback.height),
    depth: positiveDimension(environment.dimensions?.depth, fallback.depth),
  };
}

function positiveDimension(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function describeStage(root: THREE.Group, preset: string, dimensions: Dimensions): void {
  root.userData.environmentPreset = preset;
  root.userData.stageDimensions = { ...dimensions };
  root.userData.stageBounds = {
    min: { x: -dimensions.width / 2, y: 0, z: -dimensions.depth / 2 },
    max: { x: dimensions.width / 2, y: dimensions.height, z: dimensions.depth / 2 },
  };
}

export function createEnvironment(
  environment: EnvironmentState,
): { root: THREE.Group; background: THREE.Color; fog?: THREE.Fog } {
  const root = new THREE.Group();
  root.name = `environment:${environment.preset}`;
  const preset = environment.preset.toLowerCase();
  let background = new THREE.Color(0xd7ddd9);
  let fog: THREE.Fog | undefined;

  if (preset === "__workspace_empty__") {
    // A Workspace without a registered stage has no implicit ground, grid, or
    // room. Keep the WebGL layer visually neutral until a stage is created.
    background = new THREE.Color(0x0b0e13);
  } else {
    const dimensions = dimensionsFor(environment, preset);
    describeStage(root, preset, dimensions);
    if (/dark[_ -]?room/.test(preset)) {
      addRoom(root, dimensions, true, false);
      background = new THREE.Color(0x1d2428);
      const extent = Math.max(dimensions.width, dimensions.height, dimensions.depth);
      fog = new THREE.Fog(0x1d2428, Math.max(4, extent * 0.75), Math.max(10, extent * 2));
    } else if (/bedroom/.test(preset)) {
      addRoom(root, dimensions, false, true);
      background = new THREE.Color(0xcbd4d2);
    } else if (/room|interior/.test(preset)) {
      addRoom(root, dimensions, false, false);
      background = new THREE.Color(0xcbd4d2);
    } else if (/grass|field|outdoor/.test(preset)) {
      addGrassland(root, dimensions);
      background = new THREE.Color(0xabc8d1);
      const extent = Math.max(dimensions.width, dimensions.height, dimensions.depth);
      fog = new THREE.Fog(0xabc8d1, Math.max(6, extent * 0.7), Math.max(14, extent * 1.75));
    } else if (/street|city|urban/.test(preset)) {
      addStreet(root, dimensions);
      background = new THREE.Color(0xaab8bb);
      const extent = Math.max(dimensions.width, dimensions.height, dimensions.depth);
      fog = new THREE.Fog(0xaab8bb, Math.max(6, extent * 0.8), Math.max(14, extent * 1.8));
    } else {
      addStage(root, dimensions);
      background = new THREE.Color(0xe1e5e1);
    }

  }

  const grid = root.getObjectByName("environment:grid");
  if (grid && environment.properties?.gridVisible === false) grid.visible = false;

  const requestedBackground = environment.properties?.background;
  if (typeof requestedBackground === "string"
    && /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(requestedBackground)) {
    // WebGLRenderer is intentionally opaque, so an accepted #RRGGBBAA value
    // uses its RGB channels for the clear color while retaining protocol
    // compatibility with the manifest's color format.
    background = new THREE.Color(requestedBackground.slice(0, 7));
  }

  return { root, background, ...(fog ? { fog } : {}) };
}

type LightingBuildContext = {
  resolveTarget: (target: EntityId) => THREE.Vector3 | undefined;
};

function presetLights(preset: string): LightState[] {
  const normalized = preset.toLowerCase();
  if (/dim|dark/.test(normalized)) {
    return [
      { kind: "ambient", intensity: 0.44, color: "#8293a0" },
      { kind: "point", intensity: 28, color: "#d39a5e", position: { x: 0, y: 2.5, z: 1.2 } },
    ];
  }
  if (/single[_ -]?lamp/.test(normalized)) {
    return [
      { kind: "ambient", intensity: 0.32, color: "#6e7d8f" },
      { kind: "point", intensity: 36, color: "#ffc277", position: { x: 0, y: 2.7, z: 0 } },
    ];
  }
  if (/moon/.test(normalized)) {
    return [
      { kind: "ambient", intensity: 0.32, color: "#7185ad" },
      { kind: "directional", intensity: 1.05, color: "#aebfe8", position: { x: -4, y: 8, z: -5 } },
    ];
  }
  if (/sunset/.test(normalized)) {
    return [
      { kind: "ambient", intensity: 0.55, color: "#a8a0ad" },
      { kind: "directional", intensity: 2.2, color: "#ff9d66", position: { x: -8, y: 4, z: 6 } },
    ];
  }
  if (/overcast/.test(normalized)) {
    return [
      { kind: "ambient", intensity: 0.9, color: "#cbd4d6" },
      { kind: "directional", intensity: 0.7, color: "#e0e8e8", position: { x: -5, y: 9, z: 4 } },
    ];
  }
  if (/dramatic/.test(normalized)) {
    return [
      { kind: "ambient", intensity: 0.24, color: "#617184" },
      { kind: "spot", intensity: 3.2, color: "#f4d19b", position: { x: -3, y: 7, z: 4 }, target: { x: 0, y: 0.8, z: 0 } },
      { kind: "directional", intensity: 0.8, color: "#7691b8", position: { x: 5, y: 3, z: -5 } },
    ];
  }
  return [
    { kind: "ambient", intensity: 0.72, color: "#d6dddc" },
    { kind: "directional", intensity: 1.85, color: "#fff1d4", position: { x: -5, y: 9, z: 5 } },
  ];
}

function targetVector(
  target: LightState["target"],
  context: LightingBuildContext,
): THREE.Vector3 {
  if (typeof target === "string") return context.resolveTarget(target) ?? new THREE.Vector3();
  if (target) return new THREE.Vector3(target.x, target.y, target.z);
  return new THREE.Vector3();
}

export function createLighting(
  state: LightingState,
  context: LightingBuildContext,
): THREE.Group {
  const root = new THREE.Group();
  root.name = `lighting:${state.preset}`;
  const specifications = state.lights?.length ? state.lights : presetLights(state.preset);
  for (const specification of specifications) {
    const color = specification.color ?? "#ffffff";
    let light: THREE.Light;
    switch (specification.kind) {
      case "directional": {
        const directional = new THREE.DirectionalLight(color, specification.intensity);
        directional.position.set(
          specification.position?.x ?? -5,
          specification.position?.y ?? 9,
          specification.position?.z ?? 5,
        );
        directional.target.position.copy(targetVector(specification.target, context));
        directional.castShadow = true;
        directional.shadow.mapSize.set(1024, 1024);
        directional.shadow.camera.near = 0.5;
        directional.shadow.camera.far = 45;
        directional.shadow.camera.left = -12;
        directional.shadow.camera.right = 12;
        directional.shadow.camera.top = 12;
        directional.shadow.camera.bottom = -12;
        root.add(directional.target);
        light = directional;
        break;
      }
      case "point": {
        const point = new THREE.PointLight(color, specification.intensity, 18, 2);
        point.position.set(
          specification.position?.x ?? 0,
          specification.position?.y ?? 3,
          specification.position?.z ?? 0,
        );
        point.castShadow = true;
        point.shadow.mapSize.set(512, 512);
        light = point;
        break;
      }
      case "spot": {
        const spot = new THREE.SpotLight(color, specification.intensity, 24, Math.PI / 5, 0.5, 1.4);
        spot.position.set(
          specification.position?.x ?? 0,
          specification.position?.y ?? 7,
          specification.position?.z ?? 4,
        );
        spot.target.position.copy(targetVector(specification.target, context));
        spot.castShadow = true;
        spot.shadow.mapSize.set(1024, 1024);
        root.add(spot.target);
        light = spot;
        break;
      }
      case "ambient":
      default:
        light = new THREE.HemisphereLight(color, 0x4a5355, specification.intensity);
        break;
    }
    light.name = specification.id ? `light:${specification.id}` : `light:${specification.kind}`;
    root.add(light);
  }
  return root;
}
