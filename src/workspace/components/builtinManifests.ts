import type {
  ComponentManifest,
  ComponentResizePolicies,
  ComponentResizePolicy,
  JSONSchema,
  JSONObject,
  PlacementSpace,
  Size2,
} from "./componentTypes";
import { deterministicDigest } from "./manifestDigest";
import { DEFAULT_SPATIAL_COLLISION } from "../spatial/spatialTypes";
import { DEFAULT_SPATIAL_PHYSICS } from "../physics/physicsTypes";
import {
  PARAMETRIC_PRIMITIVE_JSON_SCHEMA,
  type ParametricPrimitive,
} from "../modeling/parametricGeometry";

type ManifestInput = Omit<ComponentManifest, "digest" | "trustTier" | "requiredPermissions" | "resizePolicy"> & {
  requiredPermissions?: string[];
};

const ALL_PLACEMENTS: PlacementSpace[] = [
  "world3d",
  "canvas2d",
  "surface",
  "billboard",
  "viewport",
];
const UI_PLACEMENTS: PlacementSpace[] = ["canvas2d", "surface", "billboard", "viewport"];

const emptyObjectSchema: JSONSchema = {
  type: "object",
  additionalProperties: false,
};

const colorSchema: JSONSchema = { type: "string", pattern: "^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$" };

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): JSONSchema {
  return {
    type: "object",
    additionalProperties: false,
    ...(required.length ? { required } : {}),
    properties,
  };
}

const modelReferenceSchema = objectSchema({
  modelId: { type: "string", minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]*$" },
  version: { type: "string", minLength: 1, maxLength: 64 },
  digest: { type: "string", minLength: 1, maxLength: 256 },
}, ["modelId", "version", "digest"]);

const parametricMaterialSchema = objectSchema({
  baseColor: colorSchema,
  metallic: { type: "number", minimum: 0, maximum: 1 },
  roughness: { type: "number", minimum: 0, maximum: 1 },
  opacity: { type: "number", minimum: 0, maximum: 1 },
  emissiveColor: colorSchema,
  emissiveIntensity: { type: "number", minimum: 0, maximum: 8 },
}, ["baseColor", "metallic", "roughness", "opacity", "emissiveColor", "emissiveIntensity"]);

const realityAssetReferenceSchema: JSONSchema = {
  oneOf: [
    { type: "null" },
    objectSchema({
      assetId: { type: "string", pattern: "^ra_[0-9a-f]{64}$" },
      digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    }, ["assetId", "digest"]),
  ],
};

const realityCoordinateSystemSchema: JSONSchema = {
  enum: [
    "UNKNOWN",
    "LDB", "RDB", "LUB", "RUB", "LDF", "RDF", "LUF", "RUF",
    "LFD", "RFD", "LFU", "RFU", "LBD", "RBD", "LBU", "RBU",
  ],
};

const realityCalibrationCommon = {
  version: { const: 1 },
  sourceCoordinateSystem: realityCoordinateSystemSchema,
  targetCoordinateSystem: { const: "RUB" },
};

const realityCalibrationSchema: JSONSchema = {
  oneOf: [
    objectSchema({
      ...realityCalibrationCommon,
      status: { const: "uncalibrated" },
      metersPerSourceUnit: { type: "null" },
    }, ["version", "status", "sourceCoordinateSystem", "targetCoordinateSystem", "metersPerSourceUnit"]),
    objectSchema({
      ...realityCalibrationCommon,
      status: { const: "metadata-declared" },
      metersPerSourceUnit: { type: "number", exclusiveMinimum: 0, maximum: 1_000_000 },
      declaredUnit: { enum: ["metre", "centimetre", "millimetre", "inch", "foot"] },
    }, ["version", "status", "sourceCoordinateSystem", "targetCoordinateSystem", "metersPerSourceUnit", "declaredUnit"]),
    objectSchema({
      ...realityCalibrationCommon,
      status: { const: "reference-distance" },
      metersPerSourceUnit: { type: "number", exclusiveMinimum: 0, maximum: 1_000_000 },
      sourceDistance: { type: "number", exclusiveMinimum: 0, maximum: 1_000_000_000 },
      referenceDistanceM: { type: "number", exclusiveMinimum: 0, maximum: 1_000_000 },
    }, ["version", "status", "sourceCoordinateSystem", "targetCoordinateSystem", "metersPerSourceUnit", "sourceDistance", "referenceDistanceM"]),
  ],
};

function action(inputSchema: JSONSchema = emptyObjectSchema) {
  return { inputSchema, effectClass: "semantic" as const };
}

function noResizePolicies(placements: readonly PlacementSpace[]): ComponentResizePolicies {
  return Object.fromEntries(placements.map((placement) => [placement, { kind: "none", mode: "none" }])) as ComponentResizePolicies;
}

function spatialVectorSchema(positive = false): JSONSchema {
  return objectSchema({
    x: positive
      ? { type: "number", exclusiveMinimum: 0, maximum: 1_000 }
      : { type: "number", minimum: -1_000, maximum: 1_000 },
    y: positive
      ? { type: "number", exclusiveMinimum: 0, maximum: 1_000 }
      : { type: "number", minimum: -1_000, maximum: 1_000 },
    z: positive
      ? { type: "number", exclusiveMinimum: 0, maximum: 1_000 }
      : { type: "number", minimum: -1_000, maximum: 1_000 },
  }, ["x", "y", "z"]);
}

const moveToTargetSchema = objectSchema({
  space: { const: "world3d" },
  position: spatialVectorSchema(),
  rotation: spatialVectorSchema(),
}, ["space", "position", "rotation"]);

const moveToInputSchema = objectSchema({ target: moveToTargetSchema }, ["target"]);

const movedEventSchema = objectSchema({
  placement: objectSchema({
    ...(moveToTargetSchema.properties as Record<string, unknown>),
    scale: spatialVectorSchema(true),
  }, ["space", "position", "rotation", "scale"]),
}, ["placement"]);

function currentSpatialCollisionSchema(): JSONSchema {
  const vectorSchema = spatialVectorSchema();
  const positiveVectorSchema = spatialVectorSchema(true);
  const collisionBase = {
    enabled: { type: "boolean" },
    role: { enum: ["solid", "trigger", "none"] },
    margin: { type: "number", minimum: 0, maximum: 10 },
  };
  return {
    oneOf: [
      objectSchema({ ...collisionBase, shape: { const: "asset_bounds" } }, ["enabled", "role", "shape", "margin"]),
      objectSchema({
        ...collisionBase,
        shape: { const: "box" },
        center: vectorSchema,
        size: positiveVectorSchema,
      }, ["enabled", "role", "shape", "margin", "center", "size"]),
      objectSchema({
        ...collisionBase,
        shape: { const: "compound" },
        parts: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          items: objectSchema({
            id: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
            center: vectorSchema,
            size: positiveVectorSchema,
            rotation: vectorSchema,
          }, ["id", "center", "size", "rotation"]),
        },
      }, ["enabled", "role", "shape", "margin", "parts"]),
    ],
  };
}

function currentSpatialPhysicsSchema(): JSONSchema {
  const vectorSchema = spatialVectorSchema();
  const constraintSchema = objectSchema({
    id: { type: "string", minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]*$" },
    type: { enum: ["fixed", "hinge", "slider", "ball"] },
    targetId: { type: "string", minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]*$" },
    anchor: vectorSchema,
    targetAnchor: vectorSchema,
    axis: objectSchema({
      x: { type: "number", minimum: -1, maximum: 1 },
      y: { type: "number", minimum: -1, maximum: 1 },
      z: { type: "number", minimum: -1, maximum: 1 },
    }, ["x", "y", "z"]),
    limits: objectSchema({
      min: { type: "number", minimum: -1_000_000, maximum: 1_000_000 },
      max: { type: "number", minimum: -1_000_000, maximum: 1_000_000 },
    }, ["min", "max"]),
    enabled: { type: "boolean" },
  }, ["id", "type", "targetId", "anchor", "targetAnchor", "axis", "enabled"]);
  return objectSchema({
    enabled: { type: "boolean" },
    bodyType: { enum: ["static", "dynamic", "kinematic"] },
    massKg: { type: "number", minimum: 0.001, maximum: 1_000_000 },
    centerOfMass: vectorSchema,
    friction: { type: "number", minimum: 0, maximum: 2 },
    restitution: { type: "number", minimum: 0, maximum: 1 },
    gravityScale: { type: "number", minimum: 0, maximum: 10 },
    stabilityMode: { enum: ["report", "enforce"] },
    constraints: { type: "array", maxItems: 16, items: constraintSchema },
  }, ["enabled", "bodyType", "massKg", "centerOfMass", "friction", "restitution", "gravityScale", "stabilityMode", "constraints"]);
}

/**
 * Preserve the exact Protocol 1.0 manifest digest. Resize policy was not part
 * of that protocol, so the compatibility view is deliberately added after
 * hashing.
 */
function manifest(input: ManifestInput): ComponentManifest {
  const content = {
    ...input,
    trustTier: "builtin" as const,
    requiredPermissions: input.requiredPermissions ?? [],
  };
  return Object.freeze({
    ...content,
    resizePolicy: noResizePolicies(input.allowedPlacements),
    digest: deterministicDigest(content),
  });
}

type ModernManifestInput = Omit<ComponentManifest, "digest" | "trustTier" | "requiredPermissions"> & {
  requiredPermissions?: string[];
};

/** New built-ins hash every authoritative manifest field, including resize policy. */
function modernManifest(input: ModernManifestInput): ComponentManifest {
  const content: Omit<ComponentManifest, "digest"> = {
    ...structuredClone(input),
    trustTier: "builtin",
    requiredPermissions: structuredClone(input.requiredPermissions ?? []),
  };
  return Object.freeze({ ...content, digest: deterministicDigest(content) });
}

function boxPolicy(
  placements: readonly PlacementSpace[],
  defaultSize: Size2,
  minSize: Size2,
  mode: "free" | "aspect_locked" = "free",
): ComponentResizePolicies {
  return Object.fromEntries(placements.map((placement) => [placement, {
    kind: "box2d" as const,
    mode,
    defaultSize: { ...defaultSize },
    minSize: { ...minSize },
    maxSize: { width: 4_096, height: 4_096 },
    ...(mode === "aspect_locked" ? { aspectRatio: defaultSize.width / defaultSize.height } : {}),
    allowedAxes: ["width", "height"] as const,
    units: "px" as const,
  }])) as ComponentResizePolicies;
}

function resizeAwareManifest(
  legacy: ComponentManifest,
  resizePolicy: ComponentResizePolicies,
  defaultPropsPatch: JSONObject = {},
  writableProps: string[] = legacy.writableProps,
): ComponentManifest {
  const { digest: _legacyDigest, ...legacyContent } = legacy;
  const content = {
    ...structuredClone(legacyContent),
    version: "1.1.0",
    resizePolicy: structuredClone(resizePolicy),
    defaultProps: { ...structuredClone(legacy.defaultProps), ...structuredClone(defaultPropsPatch) },
    writableProps: structuredClone(writableProps),
  };
  return Object.freeze({ ...content, digest: deterministicDigest(content) });
}

const visibilityActions = Object.freeze({
  show: action(),
  hide: action(),
  toggle_visibility: action(),
});

const visibilityEvents = Object.freeze({
  visibility_changed: objectSchema({
    visibility: { enum: ["visible", "hidden", "collapsed"] },
  }, ["visibility"]),
});

/**
 * Protocol 1.2 adds host-owned interaction primitives without changing the
 * exact 1.0/1.1 manifests (and therefore without invalidating saved refs).
 */
function interactiveManifest(previous: ComponentManifest): ComponentManifest {
  const { digest: _previousDigest, ...previousContent } = previous;
  const inheritedEvents = structuredClone(previous.events);
  // Host selection is ephemeral UI state, not a durable semantic interaction.
  // Current manifests must not advertise events the host never emits. Exact
  // 1.0/1.1 manifests remain registered unchanged for saved-project replay.
  delete inheritedEvents.selected;
  if (previous.typeId === "document") delete inheritedEvents.citation_selected;
  const content: Omit<ComponentManifest, "digest"> = {
    ...structuredClone(previousContent),
    version: "1.2.0",
    actions: {
      ...structuredClone(previous.actions),
      ...structuredClone(visibilityActions),
    },
    events: {
      ...inheritedEvents,
      ...structuredClone(visibilityEvents),
    },
  };
  if (previous.typeId === "spatial-entity") {
    content.writableProps = [
      "assetId", "entityKind", "appearance", "state", "castShadow", "receiveShadow",
    ];
    content.durableStateSchema = objectSchema({
      playback: objectSchema({
        clip: { enum: ["idle", "walk", "run", "enter", "exit"] },
        playing: { type: "boolean" },
        loop: { type: "boolean" },
        speed: { type: "number", minimum: 0.05, maximum: 8 },
        generation: { type: "integer", minimum: 0 },
      }, ["clip", "playing", "loop", "speed", "generation"]),
    });
    // Playback is materialized by the first play/stop action. Keeping the
    // neutral default empty lets compatibility tooling repin a newly-created
    // entity to its exact 1.0/1.1 schema without leaking a 1.2-only field.
    content.defaultDurableState = {};
    content.actions = {
      ...content.actions,
      activate: action(),
      play_animation: action(objectSchema({
        clip: { enum: ["idle", "walk", "run", "enter", "exit"] },
        loop: { type: "boolean" },
        speed: { type: "number", minimum: 0.05, maximum: 8 },
      }, ["clip"])),
      stop_animation: action(),
      complete_animation: {
        ...action(objectSchema({
          generation: { type: "integer", minimum: 1 },
        }, ["generation"])),
        // Only trusted host callbacks may assert that renderer playback ended.
        // This permission is deliberately absent from external agent scopes.
        requiredPermissions: ["host:signal"],
        routable: false,
      },
    };
    content.events = {
      ...content.events,
      activated: emptyObjectSchema,
      animation_started: objectSchema({
        clip: { enum: ["idle", "walk", "run", "enter", "exit"] },
        generation: { type: "integer", minimum: 1 },
      }, ["clip", "generation"]),
      animation_stopped: objectSchema({
        clip: { enum: ["idle", "walk", "run", "enter", "exit"] },
        generation: { type: "integer", minimum: 1 },
      }, ["clip", "generation"]),
      animation_finished: objectSchema({
        clip: { enum: ["idle", "walk", "run", "enter", "exit"] },
        generation: { type: "integer", minimum: 1 },
      }, ["clip", "generation"]),
    };
  }
  if (previous.typeId === "timer") {
    content.actions = {
      ...content.actions,
      complete_if_due: action(),
    };
  }
  if (previous.typeId === "chart") {
    const pointSelection = objectSchema({
      pointId: { type: "string", minLength: 1, maxLength: 1_000 },
    }, ["pointId"]);
    content.actions = {
      ...content.actions,
      select_point: action(pointSelection),
    };
    content.events = {
      ...content.events,
      point_selected: structuredClone(pointSelection),
    };
  }
  if (previous.typeId === "table") {
    const rowSelection = objectSchema({
      rowId: { type: "string", minLength: 1, maxLength: 1_000 },
    }, ["rowId"]);
    content.actions = {
      ...content.actions,
      select_row: action(rowSelection),
    };
    content.events = {
      ...content.events,
      row_selected: structuredClone(rowSelection),
    };
  }
  return Object.freeze({ ...content, digest: deterministicDigest(content) });
}

const stage3d = manifest({
  typeId: "stage-3d",
  version: "1.0.0",
  displayName: "3D Stage",
  allowedPlacements: ["world3d"],
  propsSchema: objectSchema({
    environmentPreset: { type: "string", minLength: 1 },
    dimensions: objectSchema({
      width: { type: "number", exclusiveMinimum: 0 },
      height: { type: "number", exclusiveMinimum: 0 },
      depth: { type: "number", exclusiveMinimum: 0 },
    }, ["width", "height", "depth"]),
    background: colorSchema,
    gridVisible: { type: "boolean" },
    environment: { type: "object" },
    lighting: { type: "object" },
    activeCamera: { type: "object" },
    relations: { type: "array" },
    assetLibraryVersion: { type: "string" },
    sceneMetadata: { type: "object" },
  }, ["environmentPreset"]),
  durableStateSchema: emptyObjectSchema,
  defaultProps: { environmentPreset: "blank_stage", gridVisible: true },
  defaultDurableState: {},
  writableProps: ["environmentPreset", "dimensions", "background", "gridVisible", "lighting", "activeCamera"],
  actions: {},
  events: {},
});

const spatialEntity = manifest({
  typeId: "spatial-entity",
  version: "1.0.0",
  displayName: "Spatial Entity",
  allowedPlacements: ["world3d"],
  propsSchema: objectSchema({
    assetId: { type: "string", minLength: 1 },
    entityKind: { enum: ["character", "animal", "prop", "structure", "effect", "primitive"] },
    appearance: { type: "object" },
    state: { type: "object" },
    parentSocket: { type: "string" },
    castShadow: { type: "boolean" },
    receiveShadow: { type: "boolean" },
  }, ["assetId", "entityKind"]),
  durableStateSchema: emptyObjectSchema,
  defaultProps: { assetId: "primitive_box", entityKind: "primitive", appearance: {}, state: {} },
  defaultDurableState: {},
  writableProps: ["appearance", "state", "castShadow", "receiveShadow"],
  actions: {},
  events: { selected: emptyObjectSchema },
});

const group = manifest({
  typeId: "group",
  version: "1.0.0",
  displayName: "Group",
  allowedPlacements: ALL_PLACEMENTS,
  propsSchema: objectSchema({
    layout: { enum: ["free", "stack", "grid", "overlay"] },
    gap: { type: "number", minimum: 0 },
    columns: { type: "integer", minimum: 1, maximum: 24 },
    clip: { type: "boolean" },
  }),
  durableStateSchema: emptyObjectSchema,
  defaultProps: { layout: "free", gap: 8, columns: 1, clip: false },
  defaultDurableState: {},
  writableProps: ["layout", "gap", "columns", "clip"],
  actions: {},
  events: {},
});

const button = manifest({
  typeId: "button",
  version: "1.0.0",
  displayName: "Button",
  allowedPlacements: UI_PLACEMENTS,
  propsSchema: objectSchema({
    label: { type: "string", minLength: 1, maxLength: 1_000 },
    variant: { enum: ["primary", "secondary", "ghost", "danger"] },
  }, ["label"]),
  durableStateSchema: objectSchema({
    pressCount: { type: "integer", minimum: 0 },
    lastPressedAtMs: { type: "integer", minimum: 0 },
  }, ["pressCount"]),
  defaultProps: { label: "Button", variant: "primary" },
  defaultDurableState: { pressCount: 0 },
  writableProps: ["label", "variant"],
  actions: { press: action() },
  events: {
    pressed: objectSchema({
      pressCount: { type: "integer", minimum: 1 },
      pressedAtMs: { type: "integer", minimum: 0 },
    }, ["pressCount", "pressedAtMs"]),
  },
});

const panel = manifest({
  typeId: "panel",
  version: "1.0.0",
  displayName: "Panel",
  allowedPlacements: UI_PLACEMENTS,
  propsSchema: objectSchema({
    title: { type: "string", maxLength: 500 },
    backgroundColor: colorSchema,
    borderColor: colorSchema,
    opacity: { type: "number", minimum: 0, maximum: 1 },
    padding: { type: "number", minimum: 0, maximum: 256 },
    radius: { type: "number", minimum: 0, maximum: 256 },
  }),
  durableStateSchema: emptyObjectSchema,
  defaultProps: { title: "", backgroundColor: "#161B22", opacity: 0.94, padding: 16, radius: 12 },
  defaultDurableState: {},
  writableProps: ["title", "backgroundColor", "borderColor", "opacity", "padding", "radius"],
  actions: {},
  events: { selected: emptyObjectSchema },
});

const text = manifest({
  typeId: "text",
  version: "1.0.0",
  displayName: "Text",
  allowedPlacements: UI_PLACEMENTS,
  propsSchema: objectSchema({
    text: { type: "string", maxLength: 100_000 },
    variant: { enum: ["body", "caption", "label", "heading", "display", "code"] },
    color: colorSchema,
    align: { enum: ["left", "center", "right"] },
    wrap: { type: "boolean" },
  }, ["text"]),
  durableStateSchema: emptyObjectSchema,
  defaultProps: { text: "Text", variant: "body", color: "#F5F7FA", align: "left", wrap: true },
  defaultDurableState: {},
  writableProps: ["text", "variant", "color", "align", "wrap"],
  actions: {},
  events: { selected: emptyObjectSchema },
});

const image = manifest({
  typeId: "image",
  version: "1.0.0",
  displayName: "Image",
  allowedPlacements: ALL_PLACEMENTS,
  propsSchema: objectSchema({
    assetRef: { type: "string", minLength: 1 },
    alt: { type: "string", maxLength: 2_000 },
    caption: { type: "string", maxLength: 10_000 },
    fit: { enum: ["contain", "cover", "fill", "none"] },
    opacity: { type: "number", minimum: 0, maximum: 1 },
  }, ["assetRef", "alt"]),
  durableStateSchema: emptyObjectSchema,
  defaultProps: { assetRef: "asset:placeholder", alt: "", fit: "contain", opacity: 1 },
  defaultDurableState: {},
  writableProps: ["assetRef", "alt", "caption", "fit", "opacity"],
  actions: {},
  events: { selected: emptyObjectSchema },
});

const videoPlayer = manifest({
  typeId: "video-player",
  version: "1.0.0",
  displayName: "Video Player",
  allowedPlacements: UI_PLACEMENTS,
  propsSchema: objectSchema({
    sourceUrl: { type: "string", minLength: 1, maxLength: 8_192 },
    sourceKind: { enum: ["auto", "direct", "youtube", "vimeo"] },
    title: { type: "string", minLength: 1, maxLength: 2_000 },
    caption: { type: "string", maxLength: 10_000 },
    posterAssetRef: { type: "string", maxLength: 8_192 },
    controls: { type: "boolean" },
    autoplay: { type: "boolean" },
    muted: { type: "boolean" },
    loop: { type: "boolean" },
    allowFullscreen: { type: "boolean" },
    startAtSeconds: { type: "integer", minimum: 0, maximum: 86_400 },
    preload: { enum: ["none", "metadata"] },
    fit: { enum: ["contain", "cover", "fill", "none"] },
  }, ["sourceUrl", "title"]),
  // These fields record an agent/user command intent, not observed provider
  // playback. Buffering, volume, actual position, and fullscreen stay local so
  // media frames never create a stream of Workspace revisions.
  durableStateSchema: objectSchema({
    desiredPlayback: { enum: ["stopped", "playing", "paused"] },
    lastCommand: { enum: ["none", "play", "pause", "seek", "stop"] },
    requestedTimeSeconds: { type: "number", minimum: 0, maximum: 86_400 },
    commandGeneration: { type: "integer", minimum: 0 },
  }, ["desiredPlayback", "lastCommand", "requestedTimeSeconds", "commandGeneration"]),
  defaultProps: {
    sourceUrl: "https://www.youtube.com/watch?v=M7lc1UVf-VE",
    sourceKind: "youtube",
    title: "YouTube player demo",
    controls: true,
    autoplay: false,
    muted: true,
    loop: false,
    allowFullscreen: true,
    startAtSeconds: 0,
    preload: "none",
    fit: "contain",
  },
  defaultDurableState: {
    desiredPlayback: "stopped",
    lastCommand: "none",
    requestedTimeSeconds: 0,
    commandGeneration: 0,
  },
  writableProps: [
    "sourceUrl", "sourceKind", "title", "caption", "posterAssetRef",
    "controls", "autoplay", "muted", "loop", "allowFullscreen",
    "startAtSeconds", "preload", "fit",
  ],
  // These are desired-state commands. The renderer applies them only after a
  // human has activated the facade, so an agent cannot silently load a remote
  // player or bypass browser autoplay policy.
  actions: {
    play: action(),
    pause: action(),
    seek: action(objectSchema({
      timeSeconds: { type: "number", minimum: 0, maximum: 86_400 },
    }, ["timeSeconds"])),
    stop: action(),
  },
  events: {
    play_requested: objectSchema({ generation: { type: "integer", minimum: 1 } }, ["generation"]),
    pause_requested: objectSchema({ generation: { type: "integer", minimum: 1 } }, ["generation"]),
    seek_requested: objectSchema({
      generation: { type: "integer", minimum: 1 },
      timeSeconds: { type: "number", minimum: 0, maximum: 86_400 },
    }, ["generation", "timeSeconds"]),
    stop_requested: objectSchema({ generation: { type: "integer", minimum: 1 } }, ["generation"]),
  },
});

const webPanel = manifest({
  typeId: "web-panel",
  version: "1.0.0",
  displayName: "Website Panel",
  allowedPlacements: UI_PLACEMENTS,
  propsSchema: objectSchema({
    sourceUrl: { type: "string", minLength: 1, maxLength: 8_192 },
    title: { type: "string", minLength: 1, maxLength: 2_000 },
  }, ["sourceUrl", "title"]),
  // Frame activation is deliberately local, ephemeral user intent. Persisting
  // it here would let project replay or an Agent-created panel make a request.
  durableStateSchema: emptyObjectSchema,
  defaultProps: {
    sourceUrl: "https://example.com/",
    title: "Website",
  },
  defaultDurableState: {},
  writableProps: ["sourceUrl", "title"],
  actions: {},
  events: {},
});

const dataPanel = manifest({
  typeId: "data-panel",
  version: "1.0.0",
  displayName: "Data Panel",
  allowedPlacements: UI_PLACEMENTS,
  propsSchema: objectSchema({
    title: { type: "string", maxLength: 2_000 },
    // Feed payloads are validated at the Resource boundary and again after
    // binding projection. The generic panel accepts any bounded JSON value and
    // renders it as text/table/cards; it never evaluates markup or expressions.
    data: {},
    view: { enum: ["auto", "table", "cards", "json"] },
    emptyMessage: { type: "string", maxLength: 2_000 },
  }),
  durableStateSchema: emptyObjectSchema,
  defaultProps: {
    title: "Data panel",
    data: null,
    view: "auto",
    emptyMessage: "No feed data yet.",
  },
  defaultDurableState: {},
  writableProps: ["title", "data", "view", "emptyMessage"],
  actions: {},
  events: {},
});

const annotation = manifest({
  typeId: "annotation",
  version: "1.0.0",
  displayName: "Annotation",
  allowedPlacements: ALL_PLACEMENTS,
  propsSchema: objectSchema({
    text: { type: "string", minLength: 1, maxLength: 50_000 },
    tone: { enum: ["neutral", "info", "success", "warning", "critical"] },
    sourceResourceId: { type: "string" },
    citation: { type: "string", maxLength: 10_000 },
    resolved: { type: "boolean" },
  }, ["text"]),
  durableStateSchema: emptyObjectSchema,
  defaultProps: { text: "Annotation", tone: "neutral", resolved: false },
  defaultDurableState: {},
  writableProps: ["text", "tone", "sourceResourceId", "citation", "resolved"],
  actions: {},
  events: { selected: emptyObjectSchema },
});

const timer = manifest({
  typeId: "timer",
  version: "1.0.0",
  displayName: "Timer",
  allowedPlacements: UI_PLACEMENTS,
  propsSchema: objectSchema({
    durationMs: { type: "integer", minimum: 0, maximum: 31_536_000_000 },
    label: { type: "string", maxLength: 1_000 },
    format: { enum: ["clock", "seconds", "compact"] },
    showProgress: { type: "boolean" },
  }, ["durationMs"]),
  durableStateSchema: objectSchema({
    phase: { enum: ["idle", "running", "paused", "completed"] },
    durationMs: { type: "integer", minimum: 0, maximum: 31_536_000_000 },
    remainingMs: { type: "integer", minimum: 0, maximum: 31_536_000_000 },
    startedAtMs: { type: "integer", minimum: 0 },
    deadlineAtMs: { type: "integer", minimum: 0 },
    runGeneration: { type: "integer", minimum: 0 },
    completionEventId: { type: "string" },
  }, ["phase", "durationMs", "remainingMs", "runGeneration"]),
  defaultProps: { durationMs: 600_000, label: "Timer", format: "clock", showProgress: true },
  defaultDurableState: { phase: "idle", durationMs: 600_000, remainingMs: 600_000, runGeneration: 0 },
  writableProps: ["durationMs", "label", "format", "showProgress"],
  actions: {
    start: action(objectSchema({ durationMs: { type: "integer", minimum: 0, maximum: 31_536_000_000 } })),
    pause: action(),
    resume: action(),
    reset: action(objectSchema({ durationMs: { type: "integer", minimum: 0, maximum: 31_536_000_000 } })),
    add_time: action(objectSchema({ amountMs: { type: "integer", minimum: -31_536_000_000, maximum: 31_536_000_000 } }, ["amountMs"])),
  },
  events: {
    started: objectSchema({ generation: { type: "integer", minimum: 1 } }, ["generation"]),
    paused: objectSchema({ remainingMs: { type: "integer", minimum: 0 } }, ["remainingMs"]),
    resumed: objectSchema({ generation: { type: "integer", minimum: 1 } }, ["generation"]),
    reset: emptyObjectSchema,
    finished: objectSchema({ generation: { type: "integer", minimum: 1 } }, ["generation"]),
  },
});

const checklist = manifest({
  typeId: "checklist",
  version: "1.0.0",
  displayName: "Checklist",
  allowedPlacements: UI_PLACEMENTS,
  propsSchema: objectSchema({ title: { type: "string", maxLength: 2_000 }, showCompleted: { type: "boolean" } }),
  durableStateSchema: objectSchema({
    items: {
      type: "array",
      maxItems: 5_000,
      items: objectSchema({
        id: { type: "string", minLength: 1 },
        text: { type: "string", maxLength: 10_000 },
        completed: { type: "boolean" },
      }, ["id", "text", "completed"]),
    },
  }, ["items"]),
  defaultProps: { title: "Checklist", showCompleted: true },
  defaultDurableState: { items: [] },
  writableProps: ["title", "showCompleted"],
  actions: {
    add_item: action(objectSchema({ id: { type: "string", minLength: 1 }, text: { type: "string", minLength: 1, maxLength: 10_000 } }, ["id", "text"])),
    toggle_item: action(objectSchema({ id: { type: "string", minLength: 1 } }, ["id"])),
    remove_item: action(objectSchema({ id: { type: "string", minLength: 1 } }, ["id"])),
    clear_completed: action(),
  },
  events: { changed: emptyObjectSchema },
});

const chart = manifest({
  typeId: "chart",
  version: "1.0.0",
  displayName: "Chart",
  allowedPlacements: UI_PLACEMENTS,
  propsSchema: objectSchema({
    title: { type: "string", maxLength: 2_000 },
    chartType: { enum: ["line", "bar", "area", "pie", "scatter"] },
    labels: { type: "array", maxItems: 10_000, items: { type: "string" } },
    series: {
      type: "array",
      maxItems: 100,
      items: objectSchema({
        id: { type: "string" },
        label: { type: "string" },
        values: { type: "array", maxItems: 10_000, items: { type: "number" } },
        color: colorSchema,
      }, ["id", "label", "values"]),
    },
    xLabel: { type: "string" },
    yLabel: { type: "string" },
  }, ["chartType", "labels", "series"]),
  durableStateSchema: objectSchema({ selectedPoint: { type: "string" } }),
  defaultProps: { title: "Chart", chartType: "line", labels: [], series: [] },
  defaultDurableState: {},
  writableProps: ["title", "chartType", "labels", "series", "xLabel", "yLabel"],
  actions: {},
  events: { point_selected: objectSchema({ pointId: { type: "string" } }, ["pointId"]) },
});

const table = manifest({
  typeId: "table",
  version: "1.0.0",
  displayName: "Table",
  allowedPlacements: UI_PLACEMENTS,
  propsSchema: objectSchema({
    title: { type: "string", maxLength: 2_000 },
    columns: {
      type: "array", maxItems: 200,
      items: objectSchema({ key: { type: "string" }, label: { type: "string" }, align: { enum: ["left", "center", "right"] } }, ["key", "label"]),
    },
    rows: { type: "array", maxItems: 10_000, items: { type: "object" } },
    striped: { type: "boolean" },
  }, ["columns", "rows"]),
  durableStateSchema: objectSchema({ selectedRow: { type: "string" } }),
  defaultProps: { title: "Table", columns: [], rows: [], striped: true },
  defaultDurableState: {},
  writableProps: ["title", "columns", "rows", "striped"],
  actions: {},
  events: { row_selected: objectSchema({ rowId: { type: "string" } }, ["rowId"]) },
});

const document = manifest({
  typeId: "document",
  version: "1.0.0",
  displayName: "Document",
  allowedPlacements: UI_PLACEMENTS,
  propsSchema: objectSchema({
    title: { type: "string", maxLength: 2_000 },
    content: { type: "string", maxLength: 2_000_000 },
    format: { enum: ["plain", "markdown"] },
    sourceResourceId: { type: "string" },
  }, ["content"]),
  durableStateSchema: objectSchema({ scrollOffset: { type: "number", minimum: 0 } }),
  defaultProps: { title: "Document", content: "", format: "markdown" },
  defaultDurableState: { scrollOffset: 0 },
  writableProps: ["title", "content", "format", "sourceResourceId"],
  actions: {},
  events: { citation_selected: objectSchema({ citation: { type: "string" } }, ["citation"]) },
});

export const BUILTIN_PARAMETRIC_PRIMITIVE_DEFAULTS: Readonly<Record<ParametricPrimitive["kind"], ParametricPrimitive>> = Object.freeze({
  box: Object.freeze({ kind: "box", sizeM: Object.freeze({ x: 1, y: 1, z: 1 }) }),
  sphere: Object.freeze({ kind: "sphere", radiusM: 0.5 }),
  cylinder: Object.freeze({ kind: "cylinder", radiusM: 0.5, heightM: 1, axis: "y" }),
  cone: Object.freeze({ kind: "cone", radiusM: 0.5, heightM: 1, axis: "y" }),
  capsule: Object.freeze({ kind: "capsule", radiusM: 0.25, cylinderHeightM: 0.5, axis: "y" }),
  plane: Object.freeze({ kind: "plane", sizeM: Object.freeze({ x: 2, y: 2 }), normalAxis: "y" }),
});

export const BUILTIN_PARAMETRIC_MATERIAL_DEFAULT: Readonly<JSONObject> = Object.freeze({
  baseColor: "#68D5FF",
  metallic: 0,
  roughness: 0.55,
  opacity: 1,
  emissiveColor: "#000000",
  emissiveIntensity: 0,
});

const spatialPrimitive = modernManifest({
  typeId: "spatial-primitive",
  version: "1.0.0",
  displayName: "Parametric Primitive",
  allowedPlacements: ["world3d"],
  resizePolicy: noResizePolicies(["world3d"]),
  propsSchema: objectSchema({
    geometry: PARAMETRIC_PRIMITIVE_JSON_SCHEMA,
    material: parametricMaterialSchema,
    collision: currentSpatialCollisionSchema(),
    physics: currentSpatialPhysicsSchema(),
    castShadow: { type: "boolean" },
    receiveShadow: { type: "boolean" },
  }, ["geometry", "material", "collision", "physics", "castShadow", "receiveShadow"]),
  durableStateSchema: emptyObjectSchema,
  defaultProps: {
    geometry: structuredClone(BUILTIN_PARAMETRIC_PRIMITIVE_DEFAULTS.box) as unknown as JSONObject,
    material: structuredClone(BUILTIN_PARAMETRIC_MATERIAL_DEFAULT),
    collision: structuredClone(DEFAULT_SPATIAL_COLLISION) as unknown as JSONObject,
    physics: structuredClone(DEFAULT_SPATIAL_PHYSICS) as unknown as JSONObject,
    castShadow: true,
    receiveShadow: true,
  },
  defaultDurableState: {},
  writableProps: ["geometry", "material", "collision", "physics", "castShadow", "receiveShadow"],
  actions: structuredClone(visibilityActions),
  events: structuredClone(visibilityEvents),
});

const modelAssembly = modernManifest({
  typeId: "model-assembly",
  version: "1.0.0",
  displayName: "Model Assembly",
  allowedPlacements: ["world3d"],
  resizePolicy: {
    world3d: {
      kind: "scale3d",
      mode: "uniform",
      defaultScale: { x: 1, y: 1, z: 1 },
      minScale: { x: 0.01, y: 0.01, z: 0.01 },
      maxScale: { x: 100, y: 100, z: 100 },
      allowedAxes: ["x", "y", "z"],
      units: "ratio",
    },
  },
  propsSchema: objectSchema({
    description: { type: "string", maxLength: 2_000 },
    collisionPolicy: { enum: ["external_only", "all", "none"] },
    modelRef: modelReferenceSchema,
  }, ["description", "collisionPolicy"]),
  durableStateSchema: emptyObjectSchema,
  defaultProps: { description: "", collisionPolicy: "external_only" },
  defaultDurableState: {},
  writableProps: ["description", "collisionPolicy", "modelRef"],
  actions: structuredClone(visibilityActions),
  events: structuredClone(visibilityEvents),
});

const gaussianSplat = modernManifest({
  typeId: "gaussian-splat",
  version: "1.0.0",
  displayName: "Gaussian Splat Reality Layer",
  allowedPlacements: ["world3d"],
  resizePolicy: {
    world3d: {
      kind: "scale3d",
      mode: "uniform",
      defaultScale: { x: 1, y: 1, z: 1 },
      minScale: { x: 0.01, y: 0.01, z: 0.01 },
      maxScale: { x: 100, y: 100, z: 100 },
      allowedAxes: ["x", "y", "z"],
      units: "ratio",
    },
  },
  propsSchema: objectSchema({
    assetRef: realityAssetReferenceSchema,
    calibration: realityCalibrationSchema,
    quality: { enum: ["auto", "low", "medium", "high"] },
    semanticProxyIds: {
      type: "array",
      maxItems: 128,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]*$" },
    },
  }, ["assetRef", "calibration", "quality", "semanticProxyIds"]),
  durableStateSchema: emptyObjectSchema,
  defaultProps: {
    assetRef: null,
    calibration: {
      version: 1,
      status: "uncalibrated",
      sourceCoordinateSystem: "UNKNOWN",
      targetCoordinateSystem: "RUB",
      metersPerSourceUnit: null,
    },
    quality: "auto",
    semanticProxyIds: [],
  },
  defaultDurableState: {},
  writableProps: ["assetRef", "calibration", "quality", "semanticProxyIds"],
  actions: structuredClone(visibilityActions),
  events: structuredClone(visibilityEvents),
});

const MODELING_BUILTIN_COMPONENT_MANIFESTS: readonly ComponentManifest[] = Object.freeze([
  spatialPrimitive,
  modelAssembly,
  gaussianSplat,
]);

const LEGACY_BUILTIN_COMPONENT_MANIFESTS: readonly ComponentManifest[] = Object.freeze([
  stage3d,
  spatialEntity,
  group,
  panel,
  text,
  image,
  videoPlayer,
  webPanel,
  dataPanel,
  annotation,
  timer,
  checklist,
  chart,
  table,
  document,
]);

const RESIZE_AWARE_BUILTIN_COMPONENT_MANIFESTS: readonly ComponentManifest[] = Object.freeze([
  resizeAwareManifest(stage3d, {
    world3d: {
      kind: "stage_dimensions",
      mode: "free",
      defaultDimensions: { width: 12, height: 4, depth: 10 },
      minDimensions: { width: 1, height: 1, depth: 1 },
      maxDimensions: { width: 1_000, height: 100, depth: 1_000 },
      allowedAxes: ["width", "height", "depth"],
      units: "m",
    },
  }, { dimensions: { width: 12, height: 4, depth: 10 } }, [
    "environmentPreset", "background", "gridVisible", "lighting", "activeCamera",
  ]),
  resizeAwareManifest(spatialEntity, {
    world3d: {
      kind: "scale3d",
      mode: "free",
      defaultScale: { x: 1, y: 1, z: 1 },
      minScale: { x: 0.01, y: 0.01, z: 0.01 },
      maxScale: { x: 100, y: 100, z: 100 },
      allowedAxes: ["x", "y", "z"],
      units: "ratio",
    },
  }),
  resizeAwareManifest(group, boxPolicy(ALL_PLACEMENTS, { width: 320, height: 240 }, { width: 48, height: 48 })),
  resizeAwareManifest(panel, boxPolicy(UI_PLACEMENTS, { width: 320, height: 220 }, { width: 120, height: 80 })),
  resizeAwareManifest(text, boxPolicy(UI_PLACEMENTS, { width: 280, height: 72 }, { width: 80, height: 32 })),
  resizeAwareManifest(image, boxPolicy(ALL_PLACEMENTS, { width: 320, height: 220 }, { width: 64, height: 44 }, "aspect_locked")),
  resizeAwareManifest(videoPlayer, boxPolicy(UI_PLACEMENTS, { width: 480, height: 306 }, { width: 356, height: 236 }, "aspect_locked")),
  resizeAwareManifest(webPanel, boxPolicy(UI_PLACEMENTS, { width: 560, height: 420 }, { width: 280, height: 200 })),
  resizeAwareManifest(dataPanel, boxPolicy(UI_PLACEMENTS, { width: 520, height: 340 }, { width: 260, height: 160 })),
  resizeAwareManifest(annotation, boxPolicy(ALL_PLACEMENTS, { width: 260, height: 128 }, { width: 120, height: 64 })),
  resizeAwareManifest(timer, boxPolicy(UI_PLACEMENTS, { width: 210, height: 112 }, { width: 140, height: 80 })),
  resizeAwareManifest(checklist, boxPolicy(UI_PLACEMENTS, { width: 280, height: 240 }, { width: 180, height: 120 })),
  resizeAwareManifest(chart, boxPolicy(UI_PLACEMENTS, { width: 360, height: 240 }, { width: 200, height: 140 })),
  resizeAwareManifest(table, boxPolicy(UI_PLACEMENTS, { width: 420, height: 260 }, { width: 240, height: 140 })),
  resizeAwareManifest(document, boxPolicy(UI_PLACEMENTS, { width: 420, height: 520 }, { width: 220, height: 180 })),
]);

const INTERACTIVE_BUILTIN_COMPONENT_MANIFESTS: readonly ComponentManifest[] = Object.freeze([
  ...RESIZE_AWARE_BUILTIN_COMPONENT_MANIFESTS.map(interactiveManifest),
  interactiveManifest(resizeAwareManifest(
    button,
    boxPolicy(UI_PLACEMENTS, { width: 160, height: 48 }, { width: 80, height: 32 }),
  )),
]);

/**
 * Protocol 1.3 makes collision intent part of newly-created spatial entities.
 * Older pinned manifests remain exact and non-blocking so saved history stays
 * replayable; an explicit manifest upgrade is required to opt old entities in.
 */
function collisionAwareSpatialManifest(previous: ComponentManifest): ComponentManifest {
  const { digest: _previousDigest, ...previousContent } = previous;
  const previousSchema = previous.propsSchema as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const collisionSchema = objectSchema({
    enabled: { type: "boolean" },
    role: { enum: ["solid", "trigger", "none"] },
    shape: { const: "asset_bounds" },
    margin: { type: "number", minimum: 0, maximum: 10 },
  }, ["enabled", "role", "shape", "margin"]);
  const content: Omit<ComponentManifest, "digest"> = {
    ...structuredClone(previousContent),
    version: "1.3.0",
    propsSchema: objectSchema({
      ...structuredClone(previousSchema.properties ?? {}),
      collision: collisionSchema,
    }, [...(previousSchema.required ?? []), "collision"]),
    defaultProps: {
      ...structuredClone(previous.defaultProps),
      collision: structuredClone(DEFAULT_SPATIAL_COLLISION) as unknown as JSONObject,
    },
    writableProps: [...new Set([...previous.writableProps, "collision"])],
  };
  return Object.freeze({ ...content, digest: deterministicDigest(content) });
}

const COLLISION_AWARE_BUILTIN_COMPONENT_MANIFESTS: readonly ComponentManifest[] = Object.freeze([
  collisionAwareSpatialManifest(
    INTERACTIVE_BUILTIN_COMPONENT_MANIFESTS.find((manifest) => manifest.typeId === "spatial-entity")!,
  ),
]);

/**
 * Protocol 1.4 adds deterministic rigid-body intent, compound box colliders,
 * support/stability policy, and bounded joint metadata. This is a validation
 * contract rather than a frame-by-frame physics authority.
 */
function physicsAwareSpatialManifest(previous: ComponentManifest): ComponentManifest {
  const { digest: _previousDigest, ...previousContent } = previous;
  const previousSchema = previous.propsSchema as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const vectorSchema = objectSchema({
    x: { type: "number", minimum: -1_000, maximum: 1_000 },
    y: { type: "number", minimum: -1_000, maximum: 1_000 },
    z: { type: "number", minimum: -1_000, maximum: 1_000 },
  }, ["x", "y", "z"]);
  const positiveVectorSchema = objectSchema({
    x: { type: "number", exclusiveMinimum: 0, maximum: 1_000 },
    y: { type: "number", exclusiveMinimum: 0, maximum: 1_000 },
    z: { type: "number", exclusiveMinimum: 0, maximum: 1_000 },
  }, ["x", "y", "z"]);
  const collisionBase = {
    enabled: { type: "boolean" },
    role: { enum: ["solid", "trigger", "none"] },
    margin: { type: "number", minimum: 0, maximum: 10 },
  };
  const collisionSchema: JSONSchema = {
    oneOf: [
      objectSchema({ ...collisionBase, shape: { const: "asset_bounds" } }, ["enabled", "role", "shape", "margin"]),
      objectSchema({
        ...collisionBase,
        shape: { const: "box" },
        center: vectorSchema,
        size: positiveVectorSchema,
      }, ["enabled", "role", "shape", "margin", "center", "size"]),
      objectSchema({
        ...collisionBase,
        shape: { const: "compound" },
        parts: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          items: objectSchema({
            id: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
            center: vectorSchema,
            size: positiveVectorSchema,
            rotation: vectorSchema,
          }, ["id", "center", "size", "rotation"]),
        },
      }, ["enabled", "role", "shape", "margin", "parts"]),
    ],
  };
  const constraintSchema = objectSchema({
    id: { type: "string", minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]*$" },
    type: { enum: ["fixed", "hinge", "slider", "ball"] },
    targetId: { type: "string", minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]*$" },
    anchor: vectorSchema,
    targetAnchor: vectorSchema,
    axis: objectSchema({
      x: { type: "number", minimum: -1, maximum: 1 },
      y: { type: "number", minimum: -1, maximum: 1 },
      z: { type: "number", minimum: -1, maximum: 1 },
    }, ["x", "y", "z"]),
    limits: objectSchema({
      min: { type: "number", minimum: -1_000_000, maximum: 1_000_000 },
      max: { type: "number", minimum: -1_000_000, maximum: 1_000_000 },
    }, ["min", "max"]),
    enabled: { type: "boolean" },
  }, ["id", "type", "targetId", "anchor", "targetAnchor", "axis", "enabled"]);
  const physicsSchema = objectSchema({
    bodyType: { enum: ["static", "dynamic", "kinematic"] },
    massKg: { type: "number", minimum: 0.001, maximum: 1_000_000 },
    centerOfMass: vectorSchema,
    friction: { type: "number", minimum: 0, maximum: 2 },
    restitution: { type: "number", minimum: 0, maximum: 1 },
    gravityScale: { type: "number", minimum: 0, maximum: 10 },
    stabilityMode: { enum: ["report", "enforce"] },
    constraints: { type: "array", maxItems: 16, items: constraintSchema },
  }, ["bodyType", "massKg", "centerOfMass", "friction", "restitution", "gravityScale", "stabilityMode", "constraints"]);
  const content: Omit<ComponentManifest, "digest"> = {
    ...structuredClone(previousContent),
    version: "1.4.0",
    propsSchema: objectSchema({
      ...structuredClone(previousSchema.properties ?? {}),
      collision: collisionSchema,
      physics: physicsSchema,
    }, [...new Set([...(previousSchema.required ?? []), "collision", "physics"])]),
    defaultProps: {
      ...structuredClone(previous.defaultProps),
      // Keep the exact 1.4 contract: the master switch is introduced by 1.5.
      physics: (() => {
        const { enabled: _enabled, ...legacyPhysics } = structuredClone(DEFAULT_SPATIAL_PHYSICS);
        return legacyPhysics as unknown as JSONObject;
      })(),
    },
    writableProps: [...new Set([...previous.writableProps, "collision", "physics"])],
  };
  return Object.freeze({ ...content, digest: deterministicDigest(content) });
}

const PHYSICS_AWARE_BUILTIN_COMPONENT_MANIFESTS: readonly ComponentManifest[] = Object.freeze([
  physicsAwareSpatialManifest(COLLISION_AWARE_BUILTIN_COMPONENT_MANIFESTS[0]!),
]);

function switchablePhysicsSpatialManifest(previous: ComponentManifest): ComponentManifest {
  const { digest: _previousDigest, ...previousContent } = previous;
  const previousSchema = structuredClone(previous.propsSchema) as JSONSchema & {
    properties?: Record<string, JSONSchema>;
    required?: string[];
  };
  const previousPhysics = structuredClone(previousSchema.properties?.physics ?? {}) as JSONSchema & {
    properties?: Record<string, JSONSchema>;
    required?: string[];
  };
  const physicsSchema = objectSchema({
    enabled: { type: "boolean" },
    ...structuredClone(previousPhysics.properties ?? {}),
  }, ["enabled", ...(previousPhysics.required ?? [])]);
  const content: Omit<ComponentManifest, "digest"> = {
    ...structuredClone(previousContent),
    version: "1.5.0",
    propsSchema: objectSchema({
      ...structuredClone(previousSchema.properties ?? {}),
      physics: physicsSchema,
    }, previousSchema.required ?? []),
    defaultProps: {
      ...structuredClone(previous.defaultProps),
      physics: structuredClone(DEFAULT_SPATIAL_PHYSICS) as unknown as JSONObject,
    },
  };
  return Object.freeze({ ...content, digest: deterministicDigest(content) });
}

const SWITCHABLE_PHYSICS_BUILTIN_COMPONENT_MANIFESTS: readonly ComponentManifest[] = Object.freeze([
  switchablePhysicsSpatialManifest(PHYSICS_AWARE_BUILTIN_COMPONENT_MANIFESTS[0]!),
]);

/**
 * Current spatial contracts expose one bounded, event-routable movement
 * action. The input deliberately omits scale so a route cannot resize a
 * component as a side effect; the Store records the complete placement in the
 * declared moved event.
 */
function movableSpatialManifest(previous: ComponentManifest, version: string): ComponentManifest {
  const { digest: _previousDigest, ...previousContent } = previous;
  const content: Omit<ComponentManifest, "digest"> = {
    ...structuredClone(previousContent),
    version,
    actions: {
      ...structuredClone(previous.actions),
      move_to: {
        inputSchema: structuredClone(moveToInputSchema),
        effectClass: "semantic",
        requiredPermissions: ["component:update"],
      },
    },
    events: {
      ...structuredClone(previous.events),
      moved: structuredClone(movedEventSchema),
    },
  };
  return Object.freeze({ ...content, digest: deterministicDigest(content) });
}

const MOVABLE_SPATIAL_BUILTIN_COMPONENT_MANIFESTS: readonly ComponentManifest[] = Object.freeze([
  movableSpatialManifest(SWITCHABLE_PHYSICS_BUILTIN_COMPONENT_MANIFESTS[0]!, "1.6.0"),
  movableSpatialManifest(spatialPrimitive, "1.1.0"),
  movableSpatialManifest(modelAssembly, "1.1.0"),
]);

function legacyCompatibilityPolicy(policy: ComponentResizePolicy): ComponentResizePolicy {
  if (policy.kind === "none") return { kind: "none", mode: "none" };
  if (policy.kind === "box2d") {
    return {
      kind: "box2d",
      mode: "free",
      defaultSize: structuredClone(policy.defaultSize),
      minSize: { width: 1, height: 1 },
      maxSize: { width: 4_096, height: 4_096 },
      allowedAxes: ["width", "height"],
      units: "px",
    };
  }
  if (policy.kind === "scale3d") {
    return {
      kind: "scale3d",
      mode: "free",
      defaultScale: structuredClone(policy.defaultScale),
      minScale: { x: 0.01, y: 0.01, z: 0.01 },
      maxScale: { x: 100, y: 100, z: 100 },
      allowedAxes: ["x", "y", "z"],
      units: "ratio",
    };
  }
  return {
    kind: "stage_dimensions",
    mode: "free",
    defaultDimensions: structuredClone(policy.defaultDimensions),
    // Protocol 1.0 accepted every finite positive Stage dimension. Preserve
    // that persisted contract instead of imposing the narrower 1.1 authoring
    // limits while a component remains pinned to its 1.0 manifest.
    minDimensions: {
      width: Number.MIN_VALUE,
      height: Number.MIN_VALUE,
      depth: Number.MIN_VALUE,
    },
    maxDimensions: {
      width: Number.MAX_VALUE,
      height: Number.MAX_VALUE,
      depth: Number.MAX_VALUE,
    },
    allowedAxes: ["width", "height", "depth"],
    units: "m",
  };
}

// A 1.0 digest intentionally covers only the 1.0 manifest fields. When a 1.0
// project is opened by a 1.1 engine, this host-owned compatibility view supplies
// the corresponding resize policy without rewriting the pinned type reference.
const RESIZE_ADAPTED_LEGACY_BUILTIN_COMPONENT_MANIFESTS: readonly ComponentManifest[] = Object.freeze(
  LEGACY_BUILTIN_COMPONENT_MANIFESTS.map((legacy) => {
    const current = RESIZE_AWARE_BUILTIN_COMPONENT_MANIFESTS.find(
      (candidate) => candidate.typeId === legacy.typeId,
    );
    if (!current) throw new Error(`Missing resize-aware manifest for ${legacy.typeId}`);
    return Object.freeze({
      ...legacy,
      resizePolicy: Object.fromEntries(current.allowedPlacements.map((placement) => [
        placement,
        legacyCompatibilityPolicy(current.resizePolicy[placement]!),
      ])) as ComponentResizePolicies,
    });
  }),
);

export const BUILTIN_COMPONENT_MANIFESTS: readonly ComponentManifest[] = Object.freeze([
  ...RESIZE_ADAPTED_LEGACY_BUILTIN_COMPONENT_MANIFESTS,
  ...RESIZE_AWARE_BUILTIN_COMPONENT_MANIFESTS,
  ...INTERACTIVE_BUILTIN_COMPONENT_MANIFESTS,
  ...COLLISION_AWARE_BUILTIN_COMPONENT_MANIFESTS,
  ...PHYSICS_AWARE_BUILTIN_COMPONENT_MANIFESTS,
  ...SWITCHABLE_PHYSICS_BUILTIN_COMPONENT_MANIFESTS,
  ...MOVABLE_SPATIAL_BUILTIN_COMPONENT_MANIFESTS,
  ...MODELING_BUILTIN_COMPONENT_MANIFESTS,
]);

export const BUILTIN_COMPONENT_TYPE_IDS = Object.freeze(
  [...new Set(BUILTIN_COMPONENT_MANIFESTS.map((item) => item.typeId))],
);

export function builtinManifest(typeId: string): ComponentManifest | undefined {
  return [...BUILTIN_COMPONENT_MANIFESTS]
    .reverse()
    .find((item) => item.typeId === typeId);
}
