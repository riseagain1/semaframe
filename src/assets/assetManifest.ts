import manifestJson from "./assetManifest.json";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type {
  AnimationClip,
  Dimensions,
  EntityKind,
} from "../renderer/sceneRenderTypes";
import assetManifestSchema from "./assetManifest.schema.json";

export const NEUTRAL_LOW_POLY_STYLE = "neutral_low_poly_v1" as const;

export type AssetOriginRule = "ground_center" | "logical_center";
export type AssetRenderShape =
  | "box"
  | "sphere"
  | "capsule"
  | "cylinder"
  | "cone"
  | "plane"
  | "humanoid"
  | "quadruped"
  | "table"
  | "chair"
  | "door"
  | "window"
  | "lamp"
  | "tree"
  | "vehicle"
  | "effect";

export type AssetRuntime = {
  uri: string;
  format: "glb";
  unitScaleMeters: number;
  upAxis: "+Y";
  forwardAxis: "+Z";
  originRule: AssetOriginRule;
};

/**
 * Procedural render hints keep the starter product useful before the curated
 * GLB library is installed. They are renderer hints, never semantic identity.
 */
export type AssetRenderHint = {
  shape: AssetRenderShape;
  primaryColor: `#${string}`;
  accentColor?: `#${string}`;
};

export type AssetRecord = {
  assetId: string;
  kind: EntityKind;
  displayName: string;
  tags: string[];
  styleFamily: string;
  runtime?: AssetRuntime;
  bounds: Dimensions;
  defaultScale: number;
  anchors: string[];
  sockets: string[];
  animations: AnimationClip[];
  supportedStates: string[];
  variants: string[];
  source: "bundled" | "procedural";
  license: "project_owned_or_permissive";
  renderHint: AssetRenderHint;
  fallback?: boolean;
};

export type AssetManifest = {
  assetLibraryVersion: string;
  styleFamily: string;
  assets: AssetRecord[];
};

const manifestAjv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictNumbers: true,
});
const manifestSchemaValidator: ValidateFunction<AssetManifest> =
  manifestAjv.compile<AssetManifest>(assetManifestSchema);

function schemaErrorText(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .slice(0, 8)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`)
    .join("; ");
}

/** Runtime gate for shipped and arbitrary caller-supplied asset manifests. */
export function assertAssetManifest(value: unknown): asserts value is AssetManifest {
  if (!manifestSchemaValidator(value)) {
    throw new TypeError(
      `Asset manifest does not match assetManifest.schema.json: ${schemaErrorText(manifestSchemaValidator.errors)}`,
    );
  }

  const ids = new Set<string>();
  for (const record of value.assets) {
    if (!record.assetId || ids.has(record.assetId)) {
      throw new TypeError(`Duplicate or empty assetId: ${record.assetId}`);
    }
    ids.add(record.assetId);
    if (record.styleFamily !== value.styleFamily) {
      throw new TypeError(
        `Asset ${record.assetId} uses style family ${record.styleFamily}; manifest declares ${value.styleFamily}`,
      );
    }
  }
}

assertAssetManifest(manifestJson);

export const ASSET_MANIFEST: AssetManifest = manifestJson;
export const ASSET_LIBRARY_VERSION = ASSET_MANIFEST.assetLibraryVersion;
