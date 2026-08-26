// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  RECONSTRUCTION_BACKEND_MODES,
  createReconstructionBackendFactory,
} from "../../../server/reconstruction/ReconstructionBackendFactory";
import type {
  PhotoReconstructionBackend,
  PhotoReconstructionBackendRequest,
  PhotoReconstructionBackendResult,
} from "../../../server/reconstruction/PhotoReconstructionService";

class FakeBackend implements PhotoReconstructionBackend {
  readonly identity: Readonly<{ id: string; version: string }>;

  constructor(
    id: string,
    private readonly available = true,
    private readonly probeFailure?: Error,
  ) {
    this.identity = Object.freeze({ id, version: "1" });
  }

  async probe() {
    if (this.probeFailure) throw this.probeFailure;
    return { available: this.available, ...(this.available ? {} : { reason: "/private/provider/path" }) };
  }

  async run(_request: PhotoReconstructionBackendRequest): Promise<PhotoReconstructionBackendResult> {
    return { outputPath: "output.ply", format: "ply" };
  }
}

describe("ReconstructionBackendFactory", () => {
  it("supports the complete explicit capability selection contract", () => {
    expect(RECONSTRUCTION_BACKEND_MODES).toEqual(["auto", "apple", "remote", "none"]);
    expect(() => createReconstructionBackendFactory({ mode: "invalid" as "auto" }))
      .toThrow("must be auto, apple, remote, or none");
  });

  it("preserves the existing Apple provider behavior for auto on macOS", async () => {
    const apple = new FakeBackend("apple-object-capture-gaussian");
    const appleFactory = vi.fn(() => apple);
    const result = createReconstructionBackendFactory({ platform: "darwin", appleFactory });
    expect(result).toMatchObject({ requested: "auto", selected: "apple", backend: apple });
    expect(appleFactory).toHaveBeenCalledOnce();
    await expect(result.capability()).resolves.toEqual({
      version: 1,
      requested: "auto",
      selected: "apple",
      backend: { id: "apple-object-capture-gaussian", version: "1" },
      available: true,
    });
  });

  it("uses an explicitly injected remote adapter for auto on non-macOS hosts", async () => {
    const remote = new FakeBackend("remote-photogrammetry");
    const appleFactory = vi.fn(() => new FakeBackend("apple"));
    const result = createReconstructionBackendFactory({
      platform: "win32",
      appleFactory,
      remoteBackend: remote,
    });
    expect(result).toMatchObject({ requested: "auto", selected: "remote", backend: remote });
    expect(appleFactory).not.toHaveBeenCalled();
    await expect(result.capability()).resolves.toMatchObject({ available: true, selected: "remote" });
  });

  it("fails closed when auto has no provider on the current platform", async () => {
    const result = createReconstructionBackendFactory({ platform: "win32" });
    expect(result.selected).toBe("none");
    await expect(result.capability()).resolves.toMatchObject({
      available: false,
      reason: "no_platform_backend",
      backend: { id: "reconstruction-unavailable", version: "1" },
    });
    await expect(result.backend.run({} as PhotoReconstructionBackendRequest))
      .rejects.toMatchObject({ code: "backend_unavailable", retryable: false });
  });

  it("allows explicit Apple probing on another OS without claiming it is supported", async () => {
    const apple = new FakeBackend("apple-object-capture-gaussian", false);
    const result = createReconstructionBackendFactory({
      mode: "apple",
      platform: "win32",
      appleFactory: () => apple,
    });
    expect(result.selected).toBe("apple");
    await expect(result.capability()).resolves.toEqual({
      version: 1,
      requested: "apple",
      selected: "apple",
      backend: { id: "apple-object-capture-gaussian", version: "1" },
      available: false,
      reason: "provider_unavailable",
    });
  });

  it("does not invent a remote backend or leak provider probe failures", async () => {
    const missing = createReconstructionBackendFactory({ mode: "remote", platform: "win32" });
    await expect(missing.capability()).resolves.toMatchObject({
      selected: "none",
      available: false,
      reason: "remote_not_configured",
    });

    const failing = createReconstructionBackendFactory({
      mode: "remote",
      platform: "win32",
      remoteBackend: new FakeBackend("remote", true, new Error("token at /private/path")),
    });
    const capability = await failing.capability();
    expect(capability).toMatchObject({ selected: "remote", available: false, reason: "provider_unavailable" });
    expect(JSON.stringify(capability)).not.toContain("private");
    expect(JSON.stringify(capability)).not.toContain("token");
  });

  it("keeps explicit none disabled even when providers are configured", async () => {
    const result = createReconstructionBackendFactory({
      mode: "none",
      platform: "darwin",
      appleFactory: vi.fn(() => new FakeBackend("apple")),
      remoteBackend: new FakeBackend("remote"),
    });
    await expect(result.capability()).resolves.toMatchObject({
      requested: "none",
      selected: "none",
      available: false,
      reason: "disabled",
    });
  });
});
