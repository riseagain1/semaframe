import { digestBlobSha256 } from "../workspace/assets/digest";
import { readPortableBlobRange } from "../workspace/persistence/portable/crc32";
import {
  inspectPortableArchive,
  verifyPortableArchiveEntryCrc,
} from "../workspace/persistence/portable/archive";

export const CAPTURE_BUNDLE_MEDIA_TYPE = "application/vnd.semaframe.capture+zip" as const;
export const CAPTURE_BUNDLE_LIMITS = Object.freeze({
  maximumBytes: 256 * 1024 * 1024,
  maximumFileBytes: 128 * 1024 * 1024,
  maximumFiles: 127,
  maximumManifestBytes: 128 * 1024,
});

export type CaptureBundleFile = Readonly<{
  /** Original backend-relative name. Never resolved against the host filesystem. */
  path: string;
  objectPath: string;
  role: "mesh" | "material" | "texture";
  mediaType: string;
  byteLength: number;
  sha256: `sha256:${string}`;
}>;

export type CaptureBundleManifest = Readonly<{
  schema: "semaframe.capture-bundle.v1";
  backend: Readonly<{ id: string; version: string }>;
  profile: "preview" | "balanced" | "quality";
  inputPhotoCount: number;
  registeredPhotoCount?: number;
  sourcePhotosRetained: false;
  units: "unknown";
  axes: "unknown";
  engineeringAuthority: "unverified_measurement";
  visualSha256: `sha256:${string}`;
  geometryPath: string;
  files: readonly CaptureBundleFile[];
}>;

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const decoder = new TextDecoder("utf-8", { fatal: true });

function fail(message: string): never {
  throw new TypeError(`Invalid capture bundle: ${message}`);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("expected object");
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail("unsupported manifest field");
}

export function assertCaptureSourcePath(path: unknown): asserts path is string {
  if (typeof path !== "string" || path.length < 1 || path.length > 256
    || !/^[A-Za-z0-9._ /-]+$/u.test(path) || path.trim() !== path
    || path.split("/").some((part) => !part || part === "." || part === ".." || part.trim() !== part)) {
    fail("unsafe source-relative path");
  }
}

export function parseCaptureBundleManifest(value: unknown): CaptureBundleManifest {
  const item = record(value);
  keys(item, ["schema", "backend", "profile", "inputPhotoCount", "registeredPhotoCount", "sourcePhotosRetained",
    "units", "axes", "engineeringAuthority", "visualSha256", "geometryPath", "files"]);
  if (item.schema !== "semaframe.capture-bundle.v1" || item.sourcePhotosRetained !== false
    || item.units !== "unknown" || item.axes !== "unknown" || item.engineeringAuthority !== "unverified_measurement") {
    fail("unsupported schema or measurement authority");
  }
  const backend = record(item.backend);
  keys(backend, ["id", "version"]);
  if (![backend.id, backend.version].every((text) => typeof text === "string" && /^[a-zA-Z0-9._-]{1,96}$/u.test(text))) {
    fail("invalid backend identity");
  }
  if (!["preview", "balanced", "quality"].includes(String(item.profile))) fail("invalid profile");
  if (!Number.isSafeInteger(item.inputPhotoCount) || (item.inputPhotoCount as number) < 2 || (item.inputPhotoCount as number) > 400) {
    fail("invalid photo count");
  }
  if (item.registeredPhotoCount !== undefined && (!Number.isSafeInteger(item.registeredPhotoCount)
    || (item.registeredPhotoCount as number) < 0 || (item.registeredPhotoCount as number) > (item.inputPhotoCount as number))) {
    fail("invalid registered photo count");
  }
  if (typeof item.visualSha256 !== "string" || !DIGEST.test(item.visualSha256)) fail("invalid visual digest");
  assertCaptureSourcePath(item.geometryPath);
  if (!Array.isArray(item.files) || item.files.length < 1 || item.files.length > CAPTURE_BUNDLE_LIMITS.maximumFiles) {
    fail("invalid artifact count");
  }
  const names = new Set<string>();
  let total = 0;
  for (const rawFile of item.files) {
    const file = record(rawFile);
    keys(file, ["path", "objectPath", "role", "mediaType", "byteLength", "sha256"]);
    assertCaptureSourcePath(file.path);
    if (names.has(file.path.toLowerCase())) fail("duplicate artifact path");
    names.add(file.path.toLowerCase());
    if (typeof file.sha256 !== "string" || !DIGEST.test(file.sha256)
      || file.objectPath !== `objects/${file.sha256.slice(7)}`) fail("invalid content address");
    if (!Number.isSafeInteger(file.byteLength) || (file.byteLength as number) < 1
      || (file.byteLength as number) > CAPTURE_BUNDLE_LIMITS.maximumFileBytes) fail("artifact byte limit");
    total += file.byteLength as number;
    if (total > CAPTURE_BUNDLE_LIMITS.maximumBytes) fail("aggregate byte limit");
    const extension = file.path.split(".").at(-1)?.toLowerCase();
    const expected = extension === "obj" ? ["mesh", "model/obj"]
      : extension === "mtl" ? ["material", "text/plain"]
        : extension === "png" ? ["texture", "image/png"]
          : extension === "jpg" || extension === "jpeg" ? ["texture", "image/jpeg"]
            : extension === "webp" ? ["texture", "image/webp"] : undefined;
    if (!expected || file.role !== expected[0] || file.mediaType !== expected[1]) fail("unsupported artifact type");
  }
  if (!item.files.some((file) => file.path === item.geometryPath && file.role === "mesh")) fail("missing primary OBJ");
  return structuredClone(item) as CaptureBundleManifest;
}

/** Verifies all bytes before exposing measurement inputs. Does not extract or load materials. */
export async function inspectCaptureBundle(
  blob: Blob,
  options: Readonly<{ expectedSha256?: string; expectedVisualSha256?: string; signal?: AbortSignal }> = {},
): Promise<Readonly<{ manifest: CaptureBundleManifest; mesh: Blob; files: ReadonlyMap<string, Blob>; sha256: `sha256:${string}` }>> {
  if (blob.size < 1 || blob.size > CAPTURE_BUNDLE_LIMITS.maximumBytes) fail("bundle byte limit");
  options.signal?.throwIfAborted();
  const digest = await digestBlobSha256(blob, { signal: options.signal });
  if (options.expectedSha256 !== undefined && options.expectedSha256 !== digest) fail("bundle digest mismatch");
  const archive = await inspectPortableArchive(blob, options.signal);
  if (archive.entries.length > CAPTURE_BUNDLE_LIMITS.maximumFiles + 1) fail("archive entry limit");
  const entries = new Map(archive.entries.map((entry) => [entry.path, entry]));
  const manifestEntry = entries.get("manifest.json");
  if (!manifestEntry || manifestEntry.byteLength > CAPTURE_BUNDLE_LIMITS.maximumManifestBytes) fail("manifest missing or oversized");
  const manifestBlob = await verifyPortableArchiveEntryCrc(blob, manifestEntry, options.signal);
  const manifest = parseCaptureBundleManifest(JSON.parse(decoder.decode(
    await readPortableBlobRange(manifestBlob, 0, manifestBlob.size, options.signal),
  )));
  if (options.expectedVisualSha256 !== undefined && manifest.visualSha256 !== options.expectedVisualSha256) {
    fail("visual digest mismatch");
  }
  const expectedPaths = new Set(["manifest.json", ...manifest.files.map((file) => file.objectPath)]);
  if (expectedPaths.size !== entries.size || [...entries.keys()].some((path) => !expectedPaths.has(path))) {
    fail("archive content differs from manifest");
  }
  const verified = new Map<string, Blob>();
  const files = new Map<string, Blob>();
  for (const file of manifest.files) {
    options.signal?.throwIfAborted();
    const entry = entries.get(file.objectPath);
    if (!entry || entry.byteLength !== file.byteLength) fail("artifact length mismatch");
    let bytes = verified.get(file.objectPath);
    if (!bytes) {
      bytes = await verifyPortableArchiveEntryCrc(blob, entry, options.signal);
      if (await digestBlobSha256(bytes, { signal: options.signal }) !== file.sha256) fail("artifact digest mismatch");
      verified.set(file.objectPath, bytes);
    }
    files.set(file.path, bytes.slice(0, bytes.size, file.mediaType));
  }
  return Object.freeze({ manifest, mesh: files.get(manifest.geometryPath)!, files, sha256: digest });
}
