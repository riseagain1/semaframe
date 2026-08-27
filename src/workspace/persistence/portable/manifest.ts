import type { RealityAssetDescriptor } from "../../assets/types";
import { parseRealityAssetDescriptor } from "../../assets/validation";
import type { WorkspaceProjectFile } from "../WorkspaceProjectSerializer";
import { canonicalJson, canonicalJsonBytes } from "./canonicalJson";
import {
  PORTABLE_PROJECT_FORMAT,
  PORTABLE_PROJECT_FORMAT_VERSION,
  PORTABLE_PROJECT_LIMITS,
  PORTABLE_PROJECT_MANIFEST_PATH,
  PORTABLE_PROJECT_WORKSPACE_PATH,
  portableRealityObjectPath,
} from "./constants";
import { PortableProjectError } from "./errors";

export type PortableProjectAssetManifestEntry = Readonly<{
  assetId: string;
  digest: string;
  byteLength: number;
  format: RealityAssetDescriptor["format"];
  mediaType: RealityAssetDescriptor["mediaType"];
  objectPath: string;
  descriptor: RealityAssetDescriptor;
}>;

export type PortableProjectManifest = Readonly<{
  format: typeof PORTABLE_PROJECT_FORMAT;
  version: typeof PORTABLE_PROJECT_FORMAT_VERSION;
  project: Readonly<{
    path: typeof PORTABLE_PROJECT_WORKSPACE_PATH;
    digest: string;
    byteLength: number;
    projectId: string;
    formatVersion: string;
    protocolVersion: string;
    workspaceSchemaVersion: string;
  }>;
  assets: readonly PortableProjectAssetManifestEntry[];
}>;

const MANIFEST_KEYS = ["assets", "format", "project", "version"] as const;
const PROJECT_KEYS = [
  "byteLength", "digest", "formatVersion", "path", "projectId", "protocolVersion", "workspaceSchemaVersion",
] as const;
const ASSET_KEYS = ["assetId", "byteLength", "descriptor", "digest", "format", "mediaType", "objectPath"] as const;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PortableProjectError("invalid_manifest", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new PortableProjectError("invalid_manifest", `${label} contains unknown or missing fields`);
  }
}

function string(value: unknown, label: string, maximumLength = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new PortableProjectError("invalid_manifest", `${label} must be non-empty bounded text`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new PortableProjectError("size_limit_exceeded", `${label} is outside the supported range`);
  }
  return value as number;
}

function digest(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!SHA256_PATTERN.test(parsed)) {
    throw new PortableProjectError("invalid_manifest", `${label} must be canonical SHA-256`);
  }
  return parsed;
}

function sameDescriptor(left: RealityAssetDescriptor, right: RealityAssetDescriptor): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function createPortableProjectManifest(
  project: WorkspaceProjectFile,
  projectDigest: string,
  projectByteLength: number,
  descriptors: readonly RealityAssetDescriptor[],
): PortableProjectManifest {
  const assets = [...descriptors]
    .sort((left, right) => left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0)
    .map((descriptor): PortableProjectAssetManifestEntry => Object.freeze({
      assetId: descriptor.assetId,
      digest: descriptor.digest,
      byteLength: descriptor.byteLength,
      format: descriptor.format,
      mediaType: descriptor.mediaType,
      objectPath: portableRealityObjectPath(descriptor.digest),
      descriptor: structuredClone(descriptor),
    }));
  return Object.freeze({
    format: PORTABLE_PROJECT_FORMAT,
    version: PORTABLE_PROJECT_FORMAT_VERSION,
    project: Object.freeze({
      path: PORTABLE_PROJECT_WORKSPACE_PATH,
      digest: projectDigest,
      byteLength: projectByteLength,
      projectId: project.projectId,
      formatVersion: project.formatVersion,
      protocolVersion: project.protocolVersion,
      workspaceSchemaVersion: project.workspaceSchemaVersion,
    }),
    assets: Object.freeze(assets),
  });
}

export function parsePortableProjectManifest(value: unknown): PortableProjectManifest {
  const manifest = object(value, "Portable manifest");
  exactKeys(manifest, MANIFEST_KEYS, "Portable manifest");
  if (manifest.format !== PORTABLE_PROJECT_FORMAT) {
    throw new PortableProjectError("invalid_manifest", "File is not a SemaFrame portable project");
  }
  if (manifest.version !== PORTABLE_PROJECT_FORMAT_VERSION) {
    throw new PortableProjectError("unsupported_version", `Portable project version ${String(manifest.version)} is not supported`);
  }
  const projectValue = object(manifest.project, "Portable manifest project");
  exactKeys(projectValue, PROJECT_KEYS, "Portable manifest project");
  if (projectValue.path !== PORTABLE_PROJECT_WORKSPACE_PATH) {
    throw new PortableProjectError("invalid_path", "Portable project payload path is not canonical");
  }
  const project = Object.freeze({
    path: PORTABLE_PROJECT_WORKSPACE_PATH,
    digest: digest(projectValue.digest, "project.digest"),
    byteLength: positiveInteger(
      projectValue.byteLength,
      "project.byteLength",
      PORTABLE_PROJECT_LIMITS.maximumProjectBytes,
    ),
    projectId: string(projectValue.projectId, "project.projectId", 512),
    formatVersion: string(projectValue.formatVersion, "project.formatVersion", 32),
    protocolVersion: string(projectValue.protocolVersion, "project.protocolVersion", 32),
    workspaceSchemaVersion: string(projectValue.workspaceSchemaVersion, "project.workspaceSchemaVersion", 32),
  });
  if (!Array.isArray(manifest.assets) || manifest.assets.length > PORTABLE_PROJECT_LIMITS.maximumAssets) {
    throw new PortableProjectError("size_limit_exceeded", "Portable manifest has too many Reality assets");
  }
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  let priorDigest = "";
  const assets = manifest.assets.map((item, index): PortableProjectAssetManifestEntry => {
    const asset = object(item, `assets[${index}]`);
    exactKeys(asset, ASSET_KEYS, `assets[${index}]`);
    let descriptor: RealityAssetDescriptor;
    try {
      descriptor = parseRealityAssetDescriptor(asset.descriptor);
    } catch (error) {
      throw new PortableProjectError("invalid_manifest", `assets[${index}].descriptor is invalid`, { cause: error });
    }
    const assetId = string(asset.assetId, `assets[${index}].assetId`);
    const assetDigest = digest(asset.digest, `assets[${index}].digest`);
    const objectPath = string(asset.objectPath, `assets[${index}].objectPath`, PORTABLE_PROJECT_LIMITS.maximumPathBytes);
    const byteLength = positiveInteger(
      asset.byteLength,
      `assets[${index}].byteLength`,
      PORTABLE_PROJECT_LIMITS.maximumAssetBytes,
    );
    if (
      assetId !== descriptor.assetId
      || assetDigest !== descriptor.digest
      || byteLength !== descriptor.byteLength
      || asset.format !== descriptor.format
      || asset.mediaType !== descriptor.mediaType
      || objectPath !== portableRealityObjectPath(assetDigest)
    ) {
      throw new PortableProjectError("invalid_manifest", `assets[${index}] disagrees with its descriptor`);
    }
    if (seenIds.has(assetId) || seenPaths.has(objectPath)) {
      throw new PortableProjectError("duplicate_entry", `Portable manifest repeats Reality asset ${assetId}`);
    }
    if (priorDigest && priorDigest >= assetDigest) {
      throw new PortableProjectError("invalid_manifest", "Portable manifest assets are not in canonical digest order");
    }
    priorDigest = assetDigest;
    seenIds.add(assetId);
    seenPaths.add(objectPath);
    return Object.freeze({
      assetId,
      digest: assetDigest,
      byteLength,
      format: descriptor.format,
      mediaType: descriptor.mediaType,
      objectPath,
      descriptor: structuredClone(descriptor),
    });
  });
  return Object.freeze({
    format: PORTABLE_PROJECT_FORMAT,
    version: PORTABLE_PROJECT_FORMAT_VERSION,
    project,
    assets: Object.freeze(assets),
  });
}

export function parseCanonicalPortableProjectManifestBytes(bytes: Uint8Array): PortableProjectManifest {
  if (bytes.byteLength < 2 || bytes.byteLength > PORTABLE_PROJECT_LIMITS.maximumManifestBytes) {
    throw new PortableProjectError("size_limit_exceeded", "Portable manifest size is outside the supported range");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new PortableProjectError("invalid_manifest", "Portable manifest is not valid UTF-8", { cause: error });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new PortableProjectError("invalid_manifest", "Portable manifest is not valid JSON", { cause: error });
  }
  const parsed = parsePortableProjectManifest(raw);
  const canonical = canonicalJsonBytes(parsed);
  if (canonical.byteLength !== bytes.byteLength || canonical.some((byte, index) => byte !== bytes[index])) {
    throw new PortableProjectError("invalid_manifest", "Portable manifest is not in canonical JSON form");
  }
  return parsed;
}

export function assertPortableManifestMatchesProject(
  manifest: PortableProjectManifest,
  project: WorkspaceProjectFile,
): void {
  if (
    manifest.project.projectId !== project.projectId
    || manifest.project.formatVersion !== project.formatVersion
    || manifest.project.protocolVersion !== project.protocolVersion
    || manifest.project.workspaceSchemaVersion !== project.workspaceSchemaVersion
  ) {
    throw new PortableProjectError("project_corrupt", "Portable manifest does not describe the embedded Workspace project");
  }
}

export function portableManifestEntryPaths(manifest: PortableProjectManifest): readonly string[] {
  return Object.freeze([
    PORTABLE_PROJECT_MANIFEST_PATH,
    PORTABLE_PROJECT_WORKSPACE_PATH,
    ...manifest.assets.map((asset) => asset.objectPath),
  ]);
}

export function samePortableRealityDescriptor(
  left: RealityAssetDescriptor,
  right: RealityAssetDescriptor,
): boolean {
  return sameDescriptor(left, right);
}
