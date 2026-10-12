import type { AgentGatewayClient } from "../agent/AgentGatewayClient";
import { inspectCaptureBundle } from "../reconstruction/captureBundle";
import { parsePrecisionEvidenceRef, type PrecisionEvidenceRef, type PrecisionEvidenceVault } from "../workspace/precision/evidenceVault";

export type CaptureCandidate = Readonly<{
  candidateHandle: string; format: "capture-bundle"; mediaType: "application/vnd.semaframe.capture+zip";
  byteLength: number; sha256: `sha256:${string}`;
}>;

export function parseCaptureCandidate(value: unknown): CaptureCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid capture candidate");
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== "byteLength,candidateHandle,format,mediaType,sha256"
    || candidate.format !== "capture-bundle" || typeof candidate.candidateHandle !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(candidate.candidateHandle)) throw new Error("Invalid capture candidate");
  parsePrecisionEvidenceRef({ digest: candidate.sha256, byteLength: candidate.byteLength, kind: "capture-bundle", mediaType: candidate.mediaType });
  return structuredClone(candidate) as CaptureCandidate;
}

export function captureEvidenceRef(candidate: CaptureCandidate): PrecisionEvidenceRef {
  return parsePrecisionEvidenceRef({ digest: candidate.sha256, byteLength: candidate.byteLength, kind: "capture-bundle", mediaType: candidate.mediaType });
}

export async function prepareMeasurementSourceEvidence(
  client: Pick<AgentGatewayClient, "openAssetCandidate">,
  inspected: Awaited<ReturnType<AgentGatewayClient["inspectAssetCandidate"]>>,
  workspaceId: string,
  vault: PrecisionEvidenceVault,
): Promise<PrecisionEvidenceRef> {
  if (inspected.purpose !== "measurement_source" || !["obj", "ply", "xyz-csv"].includes(inspected.format)
    || inspected.byteLength > 16 * 1024 * 1024) throw new Error("Invalid measurement source candidate");
  const ref = parsePrecisionEvidenceRef({ digest: inspected.sha256, byteLength: inspected.byteLength, kind: "measurement-source", mediaType: inspected.mediaType });
  const opened = await client.openAssetCandidate(inspected.candidateHandle, workspaceId);
  if (["candidateHandle", "purpose", "format", "sha256", "byteLength", "mediaType"].some((key) =>
    opened.descriptor[key as keyof typeof inspected] !== inspected[key as keyof typeof inspected])) {
    await opened.body.cancel(); throw new Error("Measurement source changed before streaming");
  }
  const reader = opened.body.getReader(); const chunks: BlobPart[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > ref.byteLength) throw new Error("Measurement stream exceeded its declared length");
      chunks.push(next.value.slice().buffer);
    }
    if (size !== ref.byteLength) throw new Error("Measurement stream ended early");
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
  await vault.put(ref, new Blob(chunks, { type: ref.mediaType }));
  return ref;
}

/** Authenticate each handoff, bound streaming, check the full closure and bind it to the visual result. */
export async function prepareCaptureEvidence(
  client: Pick<AgentGatewayClient, "inspectAssetCandidate" | "openAssetCandidate">,
  candidate: CaptureCandidate,
  workspaceId: string,
  visualSha256: string,
  vault: PrecisionEvidenceVault,
): Promise<PrecisionEvidenceRef> {
  parseCaptureCandidate(candidate);
  const matches = (descriptor: Awaited<ReturnType<AgentGatewayClient["inspectAssetCandidate"]>>): boolean => (
    descriptor.candidateHandle === candidate.candidateHandle && descriptor.purpose === "photo_measurement"
    && descriptor.format === candidate.format && descriptor.sha256 === candidate.sha256
    && descriptor.byteLength === candidate.byteLength && descriptor.mediaType === candidate.mediaType
  );
  const inspected = await client.inspectAssetCandidate(candidate.candidateHandle, workspaceId);
  if (!matches(inspected)) throw new Error("Capture candidate metadata changed");
  const opened = await client.openAssetCandidate(candidate.candidateHandle, workspaceId);
  if (!matches(opened.descriptor)) {
    await opened.body.cancel();
    throw new Error("Capture stream metadata changed");
  }
  const chunks: BlobPart[] = [];
  let length = 0;
  const reader = opened.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > candidate.byteLength) throw new Error("Capture stream exceeded its declared size");
      chunks.push(next.value.slice().buffer);
    }
    if (length !== candidate.byteLength) throw new Error("Capture stream ended at the wrong size");
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
  const blob = new Blob(chunks, { type: candidate.mediaType });
  await inspectCaptureBundle(blob, { expectedSha256: candidate.sha256, expectedVisualSha256: visualSha256 });
  const ref = captureEvidenceRef(candidate);
  await vault.put(ref, blob);
  return ref;
}
