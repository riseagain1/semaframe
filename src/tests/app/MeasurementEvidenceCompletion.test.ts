// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { prepareMeasurementSourceEvidence, parseCaptureCandidate } from "../../app/captureEvidenceCompletion";
import { MemoryPrecisionEvidenceVault } from "../../workspace/precision/evidenceVault";
import { sha256DigestBytes } from "../../workspace/assets/digest";
import type { AgentAssetCandidateDescriptor } from "../../agent/AgentGatewayClient";

function fixture(text = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n") {
  const bytes = new TextEncoder().encode(text);
  const descriptor: AgentAssetCandidateDescriptor = {
    version: 1, candidateHandle: "x".repeat(43), requestId: "measurement_test", workspaceId: "workspace",
    displayName: "measurement.obj", format: "obj", purpose: "measurement_source", mediaType: "model/obj",
    byteLength: bytes.length, sha256: sha256DigestBytes(bytes), status: "ready", expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const body = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  const client = { openAssetCandidate: vi.fn(async () => ({ descriptor, body: body() })) };
  return { descriptor, bytes, client };
}

describe("authoritative measurement evidence completion", () => {
  it("stores exact source bytes only after digest and stream length validation", async () => {
    const f = fixture(); const vault = new MemoryPrecisionEvidenceVault();
    const ref = await prepareMeasurementSourceEvidence(f.client, f.descriptor, "workspace", vault);
    expect(new Uint8Array(await (await vault.open(ref)).arrayBuffer())).toEqual(f.bytes);
  });
  it("rejects purpose swaps and metadata changes before retaining any bytes", async () => {
    const f = fixture(); const vault = new MemoryPrecisionEvidenceVault();
    await expect(prepareMeasurementSourceEvidence(f.client, { ...f.descriptor, purpose: "generic_import" }, "workspace", vault)).rejects.toThrow(/Invalid/);
    expect(f.client.openAssetCandidate).not.toHaveBeenCalled();
    const stream = new ReadableStream<Uint8Array>(); const cancel = vi.spyOn(stream, "cancel");
    f.client.openAssetCandidate.mockResolvedValue({ descriptor: { ...f.descriptor, purpose: "photo_reconstruction" }, body: stream });
    await expect(prepareMeasurementSourceEvidence(f.client, f.descriptor, "workspace", vault)).rejects.toThrow(/changed/);
    expect(cancel).toHaveBeenCalled();
  });
  it("rejects a too-long stream and a wrong digest without populating the vault", async () => {
    const f = fixture(); const vault = new MemoryPrecisionEvidenceVault();
    const wrong = { ...f.descriptor, sha256: `sha256:${"0".repeat(64)}` };
    f.client.openAssetCandidate.mockImplementation(async () => ({ descriptor: wrong, body: new Blob([f.bytes]).stream() }));
    await expect(prepareMeasurementSourceEvidence(f.client, wrong, "workspace", vault)).rejects.toThrow(/SHA-256/);
    const short = { ...f.descriptor, byteLength: 1 };
    f.client.openAssetCandidate.mockImplementation(async () => ({ descriptor: short, body: new Blob([f.bytes]).stream() }));
    await expect(prepareMeasurementSourceEvidence(f.client, short, "workspace", vault)).rejects.toThrow(/exceeded/);
  });
  it("strictly separates capture candidates from visual and raw measurement candidates", () => {
    const candidate = { candidateHandle: "x".repeat(43), format: "capture-bundle", mediaType: "application/vnd.semaframe.capture+zip", byteLength: 12, sha256: `sha256:${"a".repeat(64)}` };
    expect(parseCaptureCandidate(candidate)).toEqual(candidate);
    expect(() => parseCaptureCandidate({ ...candidate, extra: "untrusted" })).toThrow();
    expect(() => parseCaptureCandidate({ ...candidate, format: "obj" })).toThrow();
    expect(() => parseCaptureCandidate({ ...candidate, byteLength: 300 * 1024 * 1024 })).toThrow();
  });
});
