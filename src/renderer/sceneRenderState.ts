import type {
  Dimensions,
  EntityId,
  EnvironmentState,
  JSONScalar,
  SceneDelta,
  SceneState,
  Transform,
  Vec3,
} from "./sceneRenderTypes";

export const IDENTITY_ROTATION: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 });
export const IDENTITY_SCALE: Vec3 = Object.freeze({ x: 1, y: 1, z: 1 });

export function transformAt(position: Vec3, rotation: Vec3 = IDENTITY_ROTATION): Transform {
  return {
    position: { ...position },
    rotation: { ...rotation },
    scale: { ...IDENTITY_SCALE },
  };
}

const ROOM_PRESETS = new Set(["simple_room", "dark_room", "bedroom", "interior_room"]);

export function defaultEnvironmentDimensions(preset: string): Dimensions | undefined {
  if (ROOM_PRESETS.has(preset)) {
    return preset === "bedroom"
      ? { width: 8, height: 3, depth: 7 }
      : { width: 10, height: 3.2, depth: 8 };
  }
  if (preset === "grassland") return { width: 30, height: 8, depth: 30 };
  if (preset === "city_street" || preset === "street") {
    return { width: 18, height: 12, depth: 32 };
  }
  return undefined;
}

export function createEnvironmentState(
  preset: string,
  dimensions = defaultEnvironmentDimensions(preset),
  properties?: Record<string, JSONScalar>,
): EnvironmentState {
  const anchors: Record<string, Transform> = {
    center: transformAt({ x: 0, y: 0, z: 0 }),
    ground_center: transformAt({ x: 0, y: 0, z: 0 }),
  };

  if (dimensions && ROOM_PRESETS.has(preset)) {
    const halfWidth = dimensions.width / 2;
    const halfDepth = dimensions.depth / 2;
    anchors["room.center"] = transformAt({ x: 0, y: 0, z: 0 });
    anchors.north_wall = transformAt({ x: 0, y: 0, z: -halfDepth });
    anchors.south_wall = transformAt({ x: 0, y: 0, z: halfDepth }, { x: 0, y: Math.PI, z: 0 });
    anchors.window_1 = transformAt({ x: -halfWidth + 1.8, y: 1.2, z: -halfDepth + 0.08 });
    anchors.door_1 = transformAt({ x: halfWidth - 1.1, y: 0, z: -halfDepth + 0.08 });
    anchors.ceiling_center = transformAt({ x: 0, y: dimensions.height, z: 0 });
  } else if (dimensions && preset === "grassland") {
    anchors["field.center"] = transformAt({ x: 0, y: 0, z: 0 });
    anchors["field.north"] = transformAt({ x: 0, y: 0, z: -dimensions.depth / 3 });
    anchors["field.south"] = transformAt({ x: 0, y: 0, z: dimensions.depth / 3 });
  } else if (dimensions && (preset === "city_street" || preset === "street")) {
    anchors["street.center"] = transformAt({ x: 0, y: 0, z: 0 });
    anchors.sidewalk_left = transformAt({ x: -4.5, y: 0.12, z: 0 });
    anchors.sidewalk_right = transformAt({ x: 4.5, y: 0.12, z: 0 });
    anchors.building_front = transformAt({ x: -7, y: 0, z: -2 });
  }

  return {
    preset,
    ...(dimensions ? { dimensions: { ...dimensions } } : {}),
    anchors,
    ...(properties ? { properties: { ...properties } } : {}),
  };
}

export function createInitialScene(): SceneState {
  return {
    revision: 0,
    environment: createEnvironmentState("blank_stage"),
    lighting: { preset: "neutral", exposure: 1 },
    entities: new Map(),
    activeCamera: {
      position: { x: 7.5, y: 5.5, z: 9.5 },
      target: { x: 0, y: 1, z: 0 },
      fovDeg: 45,
      shot: "wide",
    },
  };
}

function stableObject(value: unknown): unknown {
  if (value instanceof Map) {
    return [...value.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, stableObject(item)]);
  }
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, stableObject(item)]),
    );
  }
  return value;
}

function semanticEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableObject(left)) === JSON.stringify(stableObject(right));
}

export function computeSceneDelta(before: SceneState, after: SceneState): SceneDelta {
  const added: EntityId[] = [];
  const updated: EntityId[] = [];
  const removed: EntityId[] = [];

  for (const [id, entity] of after.entities) {
    const previous = before.entities.get(id);
    if (!previous) added.push(id);
    else if (!semanticEqual(previous, entity)) updated.push(id);
  }
  for (const id of before.entities.keys()) {
    if (!after.entities.has(id)) removed.push(id);
  }

  const sortIds = (ids: EntityId[]) => ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    fromRevision: before.revision,
    toRevision: after.revision,
    added: sortIds(added),
    updated: sortIds(updated),
    removed: sortIds(removed),
    environmentChanged: !semanticEqual(before.environment, after.environment),
    lightingChanged: !semanticEqual(before.lighting, after.lighting),
    cameraChanged: !semanticEqual(before.activeCamera, after.activeCamera),
  };
}
