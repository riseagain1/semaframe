import { openAsBlob } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import {
  CAPTURE_BUNDLE_LIMITS,
  assertCaptureSourcePath,
  parseCaptureBundleManifest,
  type CaptureBundleFile,
} from "../../src/reconstruction/captureBundle";
import { digestBlobSha256 } from "../../src/workspace/assets/digest";
import { crc32Blob } from "../../src/workspace/persistence/portable/crc32";
import {
  planPortableArchive,
  streamPortableArchive,
  type PortableArchiveSourceEntry,
} from "../../src/workspace/persistence/portable/archive";
import type { PhotoReconstructionBackendIdentity, PhotoReconstructionProfile } from "../../src/reconstruction/contracts";

function contained(root: string, path: string): boolean {
  const part = relative(root, path);
  return part.length > 0 && part !== ".." && !part.startsWith("../") && !isAbsolute(part);
}

/** Packs original native output bytes, never source photo bytes or host paths. */
export async function createCaptureBundle(options: Readonly<{
  outputDirectory: string;
  objPath: string;
  artifacts: readonly string[];
  outputPath: string;
  visualPath: string;
  backend: PhotoReconstructionBackendIdentity;
  profile: PhotoReconstructionProfile;
  inputPhotoCount: number;
  registeredPhotoCount?: number;
  signal: AbortSignal;
  reserveOutputBytes(bytes: number): Promise<void>;
}>): Promise<void> {
  const root = await realpath(options.outputDirectory);
  const files: CaptureBundleFile[] = [];
  const objects = new Map<string, PortableArchiveSourceEntry>();
  let totalBytes = 0;
  let geometryPath: string | undefined;
  if (!options.artifacts.includes(options.objPath) || options.artifacts.length > CAPTURE_BUNDLE_LIMITS.maximumFiles) {
    throw new Error("Native capture artifact set is incomplete or exceeds its limit");
  }
  for (const path of [...options.artifacts].sort()) {
    options.signal.throwIfAborted();
    const info = await lstat(path);
    const canonical = await realpath(path);
    if (!info.isFile() || info.isSymbolicLink() || !contained(root, canonical)) throw new Error("Unsafe native capture artifact");
    const name = relative(root, canonical);
    assertCaptureSourcePath(name);
    const extension = name.split(".").at(-1)?.toLowerCase();
    const type = extension === "obj" ? ["mesh", "model/obj"] as const
      : extension === "mtl" ? ["material", "text/plain"] as const
        : extension === "png" ? ["texture", "image/png"] as const
          : extension === "jpg" || extension === "jpeg" ? ["texture", "image/jpeg"] as const
            : extension === "webp" ? ["texture", "image/webp"] as const : undefined;
    if (!type) throw new Error("Unsupported native capture artifact; no partial bundle is produced");
    if (!Number.isSafeInteger(info.size) || info.size < 1 || info.size > CAPTURE_BUNDLE_LIMITS.maximumFileBytes) {
      throw new Error("Native capture artifact exceeds its byte limit");
    }
    totalBytes += info.size;
    if (totalBytes > CAPTURE_BUNDLE_LIMITS.maximumBytes - CAPTURE_BUNDLE_LIMITS.maximumManifestBytes) {
      throw new Error("Native capture bundle exceeds its byte limit");
    }
    const blob = await openAsBlob(canonical);
    const sha256 = await digestBlobSha256(blob, { signal: options.signal });
    const objectPath = `objects/${sha256.slice(7)}`;
    if (!objects.has(objectPath)) {
      objects.set(objectPath, { path: objectPath, blob, crc32: await crc32Blob(blob, { signal: options.signal }) });
    }
    files.push({ path: name, objectPath, role: type[0], mediaType: type[1], byteLength: info.size, sha256 });
    if (path === options.objPath) geometryPath = name;
  }
  const visualSha256 = await digestBlobSha256(await openAsBlob(options.visualPath), { signal: options.signal });
  const manifest = parseCaptureBundleManifest({
    schema: "semaframe.capture-bundle.v1",
    backend: options.backend,
    profile: options.profile,
    inputPhotoCount: options.inputPhotoCount,
    ...(options.registeredPhotoCount === undefined ? {} : { registeredPhotoCount: options.registeredPhotoCount }),
    sourcePhotosRetained: false,
    units: "unknown",
    axes: "unknown",
    engineeringAuthority: "unverified_measurement",
    visualSha256,
    geometryPath,
    files,
  });
  const manifestBlob = new Blob([JSON.stringify(manifest)]);
  if (manifestBlob.size > CAPTURE_BUNDLE_LIMITS.maximumManifestBytes) throw new Error("Capture manifest exceeds its limit");
  const plan = planPortableArchive([
    { path: "manifest.json", blob: manifestBlob, crc32: await crc32Blob(manifestBlob) },
    ...objects.values(),
  ]);
  if (plan.byteLength > CAPTURE_BUNDLE_LIMITS.maximumBytes) throw new Error("Capture archive exceeds its byte limit");
  const outputPath = join(await realpath(dirname(options.outputPath)), basename(options.outputPath));
  if (!contained(root, outputPath)) throw new Error("Unsafe capture output path");
  await options.reserveOutputBytes(plan.byteLength);
  const file = await open(outputPath, "wx", 0o600);
  const reader = streamPortableArchive(plan, options.signal).getReader();
  let complete = false;
  let remaining = plan.byteLength;
  try {
    while (true) {
      options.signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      await options.reserveOutputBytes(remaining);
      let offset = 0;
      while (offset < next.value.byteLength) {
        const written = await file.write(next.value, offset, next.value.byteLength - offset);
        if (written.bytesWritten < 1) throw new Error("Capture archive write made no progress");
        offset += written.bytesWritten;
      }
      remaining -= next.value.byteLength;
    }
    if (remaining !== 0) throw new Error("Capture archive byte count changed");
    await file.sync();
    complete = true;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    await file.close();
    if (!complete) await unlink(outputPath);
  }
}
