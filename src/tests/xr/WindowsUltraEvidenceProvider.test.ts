// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { createWindowsUltraEvidenceProvider } from "../../../server/xr/ultra";
import { ULTRA_POLICY_VERSION } from "../../xr/ultra";

const STATIC = JSON.stringify({
  operatingSystemVersion: "10.0.26100",
  logicalProcessorCount: 24,
  systemMemoryBytes: 32 * 1024 * 1024 * 1024,
  adapterIdentity: "PCI\\VEN_10DE&DEV_TEST",
  driverVersion: "32.0.15.9000",
  hardwareAccelerated: true,
  metaRuntimeActive: true,
  runtimeVersion: "1.100.0",
  nvidiaTelemetryAvailable: true,
  nvidiaAdapterCount: 1,
});

const SAMPLE = JSON.stringify({
  processRssBytes: 2 * 1024 * 1024 * 1024,
  gpuMemoryUsageRatio: 0.5,
  gpuMemoryHeadroomBytes: 6 * 1024 * 1024 * 1024,
  hardwareThermalSlowdown: "Not Active",
  softwareThermalSlowdown: "Not Active",
  runtimeConnected: true,
});

const SCOPE_A = { rendererSessionId: "renderer-session-ultra-a" } as const;
const SCOPE_B = { rendererSessionId: "renderer-session-ultra-b" } as const;

describe("bundled Windows Ultra evidence provider", () => {
  it("stays disabled off Windows or until the physical transport is configured", () => {
    expect(createWindowsUltraEvidenceProvider({
      platform: "darwin",
      architecture: "arm64",
      transport: "link_cable",
    })).toBeUndefined();
    expect(createWindowsUltraEvidenceProvider({
      platform: "win32",
      architecture: "x64",
      transport: undefined,
    })).toBeUndefined();
    expect(() => createWindowsUltraEvidenceProvider({
      platform: "win32",
      architecture: "x64",
      transport: "force",
    })).toThrow("must be link_cable or air_link");
  });

  it("combines native Windows facts with live browser WebXR evidence without exposing adapter identity", async () => {
    const runCommand = vi.fn(async () => STATIC);
    const provider = createWindowsUltraEvidenceProvider({
      platform: "win32",
      architecture: "x64",
      transport: "link_cable",
      now: () => Date.parse("2026-08-25T09:00:00.000Z"),
      runCommand,
    });
    const probe = await provider!.collectStaticProbe(SCOPE_A, {
      browserEngine: "chromium",
      secureContext: true,
      immersiveVrSupported: true,
    });
    expect(probe).toMatchObject({
      version: 1,
      policyVersion: ULTRA_POLICY_VERSION,
      platform: "windows",
      architecture: "x64",
      logicalProcessorCount: 24,
      runtime: { kind: "meta_horizon_link", openXrActive: true },
      webXr: { browserEngine: "chromium", secureContext: true, immersiveVrSupported: true },
    });
    expect(probe.graphics.adapterFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(probe)).not.toContain("PCI");
    expect(runCommand).toHaveBeenCalledOnce();
  });

  it("returns bounded native memory, throttle, runtime, and configured transport samples", async () => {
    const provider = createWindowsUltraEvidenceProvider({
      platform: "win32",
      architecture: "x64",
      transport: "air_link",
      now: () => Date.parse("2026-08-25T09:01:00.000Z"),
      runCommand: async () => SAMPLE,
    });
    await expect(provider!.sampleRuntime(SCOPE_A)).resolves.toEqual({
      version: 1,
      transport: "air_link",
      processRssBytes: 2 * 1024 * 1024 * 1024,
      gpuMemoryUsageRatio: 0.5,
      gpuMemoryHeadroomBytes: 6 * 1024 * 1024 * 1024,
      thermalThrottleObserved: false,
      runtimeConnected: true,
      sampledAt: "2026-08-25T09:01:00.000Z",
    });
  });

  it("coalesces concurrent native probes globally while scoping fingerprints to each renderer session", async () => {
    let resolveNative!: (value: string) => void;
    const native = new Promise<string>((resolve) => { resolveNative = resolve; });
    const runCommand = vi.fn(() => native);
    const provider = createWindowsUltraEvidenceProvider({
      platform: "win32",
      architecture: "x64",
      transport: "link_cable",
      fingerprintKey: new Uint8Array(32).fill(7),
      runCommand,
    })!;
    const browser = {
      browserEngine: "chromium",
      secureContext: true,
      immersiveVrSupported: true,
    } as const;

    const first = provider.collectStaticProbe(SCOPE_A, browser);
    const second = provider.collectStaticProbe(SCOPE_B, browser);
    expect(runCommand).toHaveBeenCalledOnce();
    resolveNative(STATIC);
    const [firstProbe, secondProbe] = await Promise.all([first, second]);
    expect(firstProbe.graphics.adapterFingerprint).not.toBe(secondProbe.graphics.adapterFingerprint);

    const repeated = await provider.collectStaticProbe(SCOPE_A, browser);
    expect(repeated.graphics.adapterFingerprint).toBe(firstProbe.graphics.adapterFingerprint);
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent runtime telemetry subprocesses across renderer sessions", async () => {
    let resolveNative!: (value: string) => void;
    const native = new Promise<string>((resolve) => { resolveNative = resolve; });
    const runCommand = vi.fn(() => native);
    const provider = createWindowsUltraEvidenceProvider({
      platform: "win32",
      architecture: "x64",
      transport: "air_link",
      runCommand,
    })!;

    const first = provider.sampleRuntime(SCOPE_A);
    const second = provider.sampleRuntime(SCOPE_B);
    expect(runCommand).toHaveBeenCalledOnce();
    resolveNative(SAMPLE);
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ transport: "air_link", thermalThrottleObserved: false }),
      expect.objectContaining({ transport: "air_link", thermalThrottleObserved: false }),
    ]);
  });

  it("uses only a fixed signed System32 NVIDIA utility and thermal-specific clock reasons", async () => {
    const scripts: string[] = [];
    const executables: string[] = [];
    const provider = createWindowsUltraEvidenceProvider({
      platform: "win32",
      architecture: "x64",
      transport: "link_cable",
      windowsDirectory: String.raw`D:\Windows`,
      runCommand: async (executable, args) => {
        executables.push(executable);
        const script = args.at(-1) ?? "";
        scripts.push(script);
        return script.includes("--query-gpu") ? SAMPLE : STATIC;
      },
    })!;
    await provider.collectStaticProbe(SCOPE_A, {
      browserEngine: "chromium",
      secureContext: true,
      immersiveVrSupported: true,
    });
    await provider.sampleRuntime(SCOPE_A);

    expect(executables).toEqual([
      String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
      String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    ]);

    for (const script of scripts) {
      expect(script).toContain("[Environment+SpecialFolder]::Windows");
      expect(script).toContain("'System32'");
      expect(script).toContain("Get-AuthenticodeSignature -LiteralPath");
      expect(script).toContain("O=NVIDIA Corporation");
      expect(script).not.toContain("Get-Command nvidia-smi");
    }
    expect(scripts[1]).toContain("clocks_throttle_reasons.hw_thermal_slowdown");
    expect(scripts[1]).toContain("clocks_throttle_reasons.sw_thermal_slowdown");
    expect(scripts[1]).not.toContain("clocks_throttle_reasons.active");
    expect(scripts[1]).toContain("$rows.Count -ne 1");
  });

  it("rejects relative or traversal-based Windows directories", () => {
    for (const windowsDirectory of ["Windows", String.raw`C:\safe\..\evil`, String.raw`\\server\Windows`]) {
      expect(() => createWindowsUltraEvidenceProvider({
        platform: "win32",
        architecture: "x64",
        transport: "link_cable",
        windowsDirectory,
      })).toThrow("Windows system directory");
    }
  });

  it("fails Ultra eligibility closed when multiple NVIDIA adapters make the WebXR GPU ambiguous", async () => {
    const provider = createWindowsUltraEvidenceProvider({
      platform: "win32",
      architecture: "x64",
      transport: "link_cable",
      runCommand: async () => JSON.stringify({ ...JSON.parse(STATIC), nvidiaAdapterCount: 2 }),
    })!;
    const probe = await provider.collectStaticProbe(SCOPE_A, {
      browserEngine: "chromium",
      secureContext: true,
      immersiveVrSupported: true,
    });
    expect(probe.graphics.supportedByRuntime).toBe(false);
  });

  it("fails closed instead of interpreting non-thermal clock reasons as thermal slowdown", async () => {
    const provider = createWindowsUltraEvidenceProvider({
      platform: "win32",
      architecture: "x64",
      transport: "link_cable",
      runCommand: async () => JSON.stringify({
        ...JSON.parse(SAMPLE),
        hardwareThermalSlowdown: "Idle",
        softwareThermalSlowdown: "Power cap",
      }),
    })!;
    await expect(provider.sampleRuntime(SCOPE_A)).rejects.toThrow("evidence was invalid");
  });

  it("fails closed on malformed or oversized native evidence", async () => {
    const malformed = createWindowsUltraEvidenceProvider({
      platform: "win32",
      architecture: "x64",
      transport: "link_cable",
      runCommand: async () => JSON.stringify({ ...JSON.parse(STATIC), extra: "not allowed" }),
    });
    await expect(malformed!.collectStaticProbe(SCOPE_A, {
      browserEngine: "chromium",
      secureContext: true,
      immersiveVrSupported: true,
    })).rejects.toThrow("evidence was invalid");

    const oversized = createWindowsUltraEvidenceProvider({
      platform: "win32",
      architecture: "x64",
      transport: "link_cable",
      runCommand: async () => "x".repeat(70 * 1024),
    });
    await expect(oversized!.sampleRuntime(SCOPE_A)).rejects.toThrow("evidence was invalid");
  });
});
