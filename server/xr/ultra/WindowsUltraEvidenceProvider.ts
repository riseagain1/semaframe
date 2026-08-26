import { execFile } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { win32 as windowsPath } from "node:path";
import { promisify } from "node:util";
import {
  ULTRA_POLICY_VERSION,
  type UltraStaticProbe,
  type UltraTransport,
} from "../../../src/xr/ultra/contracts";

const execFileAsync = promisify(execFile);
const POWERSHELL_TIMEOUT_MS = 8_000;
const POWERSHELL_MAX_BUFFER_BYTES = 64 * 1024;

export type UltraBrowserProbeEvidence = Readonly<{
  browserEngine: "chromium" | "unknown";
  secureContext: boolean;
  immersiveVrSupported: boolean;
}>;

export type UltraRuntimeSystemSample = Readonly<{
  version: 1;
  transport: UltraTransport;
  processRssBytes: number;
  gpuMemoryUsageRatio: number;
  gpuMemoryHeadroomBytes: number;
  thermalThrottleObserved: boolean;
  runtimeConnected: boolean;
  sampledAt: string;
}>;

export type WindowsUltraSessionScope = Readonly<{
  /** Authenticated renderer session identity; never supplied by the browser body. */
  rendererSessionId: string;
}>;

export interface WindowsUltraEvidenceProvider {
  collectStaticProbe(
    scope: WindowsUltraSessionScope,
    browser: UltraBrowserProbeEvidence,
    signal?: AbortSignal,
  ): Promise<UltraStaticProbe>;
  sampleRuntime(
    scope: WindowsUltraSessionScope,
    signal?: AbortSignal,
  ): Promise<UltraRuntimeSystemSample>;
}

export type WindowsUltraCommandRunner = (
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<string>;

export type WindowsUltraEvidenceProviderOptions = Readonly<{
  platform?: NodeJS.Platform;
  architecture?: string;
  transport?: string;
  powershellExecutable?: string;
  /** Injectable Windows directory for deterministic tests; production uses SystemRoot/WINDIR. */
  windowsDirectory?: string;
  runCommand?: WindowsUltraCommandRunner;
  now?: () => number;
  /** Process-private 256-bit HMAC key; injectable only for deterministic tests. */
  fingerprintKey?: Uint8Array;
}>;

type StaticNativeEvidence = Readonly<{
  operatingSystemVersion: string;
  logicalProcessorCount: number;
  systemMemoryBytes: number;
  adapterIdentity: string;
  driverVersion: string;
  hardwareAccelerated: boolean;
  metaRuntimeActive: boolean;
  runtimeVersion: string | null;
  nvidiaTelemetryAvailable: boolean;
  nvidiaAdapterCount: number;
}>;

const TRUSTED_NVIDIA_SMI_SCRIPT = String.raw`
function Get-TrustedNvidiaSmiPath {
  $windowsDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
  if (-not $windowsDirectory) { return $null }
  $system32 = [IO.Path]::GetFullPath([IO.Path]::Combine($windowsDirectory, 'System32'))
  $candidate = [IO.Path]::GetFullPath([IO.Path]::Combine($system32, 'nvidia-smi.exe'))
  if (-not [string]::Equals([IO.Path]::GetDirectoryName($candidate), $system32, [StringComparison]::OrdinalIgnoreCase)) {
    return $null
  }
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $null }
  $signature = Get-AuthenticodeSignature -LiteralPath $candidate
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) { return $null }
  $subject = [string]$signature.SignerCertificate.Subject
  if ($subject -notmatch '(?i)(?:^|,\s*)O=NVIDIA Corporation(?:,|$)') { return $null }
  return $candidate
}
`.trim();

const STATIC_PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
${TRUSTED_NVIDIA_SMI_SCRIPT}
$computer = Get-CimInstance Win32_ComputerSystem
$operatingSystem = Get-CimInstance Win32_OperatingSystem
$graphicsCandidates = @(Get-CimInstance Win32_VideoController |
  Where-Object { $_.PNPDeviceID -and $_.DriverVersion } |
  Sort-Object -Property AdapterRAM -Descending)
$nvidiaGraphics = @($graphicsCandidates | Where-Object { $_.PNPDeviceID -match '(?i)VEN_10DE' })
$graphics = if ($nvidiaGraphics.Count -eq 1) { $nvidiaGraphics[0] } else { $graphicsCandidates | Select-Object -First 1 }
if (-not $graphics) { throw 'No usable graphics adapter was reported.' }
$runtimePath = $null
foreach ($registryPath in @('HKLM:\SOFTWARE\Khronos\OpenXR\1', 'HKLM:\SOFTWARE\WOW6432Node\Khronos\OpenXR\1')) {
  try {
    $candidate = (Get-ItemProperty -Path $registryPath -Name ActiveRuntime -ErrorAction Stop).ActiveRuntime
    if ($candidate) { $runtimePath = [string]$candidate; break }
  } catch {}
}
$runtimeProcess = Get-Process -Name OVRServer_x64 -ErrorAction SilentlyContinue | Select-Object -First 1
$runtimeVersion = $null
if ($runtimeProcess -and $runtimeProcess.Path) {
  try { $runtimeVersion = [string](Get-Item $runtimeProcess.Path).VersionInfo.FileVersion } catch {}
}
$metaRuntimeActive = [bool]($runtimePath -and ($runtimePath -match '(?i)(oculus|meta)') -and $runtimeProcess)
$nvidiaTelemetryAvailable = [bool](Get-TrustedNvidiaSmiPath)
[ordered]@{
  operatingSystemVersion = [string]$operatingSystem.Version
  logicalProcessorCount = [int64]$computer.NumberOfLogicalProcessors
  systemMemoryBytes = [int64]$computer.TotalPhysicalMemory
  adapterIdentity = [string]$graphics.PNPDeviceID
  driverVersion = [string]$graphics.DriverVersion
  hardwareAccelerated = [bool]($graphics.Status -eq 'OK')
  metaRuntimeActive = $metaRuntimeActive
  runtimeVersion = $runtimeVersion
  nvidiaTelemetryAvailable = $nvidiaTelemetryAvailable
  nvidiaAdapterCount = [int64]$nvidiaGraphics.Count
} | ConvertTo-Json -Compress
`.trim();

const RUNTIME_SAMPLE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
${TRUSTED_NVIDIA_SMI_SCRIPT}
$nvidiaSmi = Get-TrustedNvidiaSmiPath
if (-not $nvidiaSmi) { throw 'Trusted GPU telemetry was unavailable.' }
$rows = @(& $nvidiaSmi --query-gpu=memory.used,memory.total,clocks_throttle_reasons.hw_thermal_slowdown,clocks_throttle_reasons.sw_thermal_slowdown --format=csv,noheader,nounits)
if ($LASTEXITCODE -ne 0 -or $rows.Count -ne 1) { throw 'GPU telemetry was unavailable or its WebXR adapter binding was ambiguous.' }
$parts = ([string]$rows[0]).Split(',') | ForEach-Object { $_.Trim() }
if ($parts.Count -ne 4) { throw 'GPU telemetry was invalid.' }
$used = [double]$parts[0]
$total = [double]$parts[1]
if ($total -le 0 -or $used -lt 0 -or $used -gt $total) { throw 'GPU telemetry was invalid.' }
$processNames = @('chrome', 'msedge', 'OVRServer_x64', 'OculusClient')
$rss = 0L
foreach ($name in $processNames) {
  Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object { $rss += [int64]$_.WorkingSet64 }
}
$runtimeConnected = [bool](Get-Process -Name OVRServer_x64 -ErrorAction SilentlyContinue | Select-Object -First 1)
[ordered]@{
  processRssBytes = [int64]$rss
  gpuMemoryUsageRatio = [double]($used / $total)
  gpuMemoryHeadroomBytes = [int64](($total - $used) * 1MB)
  hardwareThermalSlowdown = [string]$parts[2]
  softwareThermalSlowdown = [string]$parts[3]
  runtimeConnected = $runtimeConnected
} | ConvertTo-Json -Compress
`.trim();

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join("\u0000") !== [...keys].sort().join("\u0000")) {
    throw new Error("Windows Ultra evidence was invalid.");
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, maximum = 512): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /\p{Cc}/u.test(value)) {
    throw new Error("Windows Ultra evidence was invalid.");
  }
  return value;
}

function safeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("Windows Ultra evidence was invalid.");
  }
  return Number(value);
}

function finiteRatio(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Windows Ultra evidence was invalid.");
  }
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Windows Ultra evidence was invalid.");
  return value;
}

function thermalReasonActive(value: unknown): boolean {
  const normalized = boundedString(value, 64).trim().toLowerCase();
  if (["active", "yes", "true", "1"].includes(normalized)) return true;
  if (["not active", "no", "false", "0", "n/a"].includes(normalized)) return false;
  throw new Error("Windows Ultra evidence was invalid.");
}

function parseJson(text: string): unknown {
  if (Buffer.byteLength(text, "utf8") > POWERSHELL_MAX_BUFFER_BYTES) {
    throw new Error("Windows Ultra evidence was invalid.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Windows Ultra evidence was invalid.");
  }
}

function parseStaticNativeEvidence(text: string): StaticNativeEvidence {
  const body = exactRecord(parseJson(text), [
    "operatingSystemVersion", "logicalProcessorCount", "systemMemoryBytes",
    "adapterIdentity", "driverVersion", "hardwareAccelerated",
    "metaRuntimeActive", "runtimeVersion", "nvidiaTelemetryAvailable", "nvidiaAdapterCount",
  ]);
  const runtimeVersion = body.runtimeVersion === null
    ? null
    : boundedString(body.runtimeVersion, 256);
  const native: StaticNativeEvidence = {
    operatingSystemVersion: boundedString(body.operatingSystemVersion, 256),
    logicalProcessorCount: safeInteger(body.logicalProcessorCount),
    systemMemoryBytes: safeInteger(body.systemMemoryBytes),
    adapterIdentity: boundedString(body.adapterIdentity, 2_048),
    driverVersion: boundedString(body.driverVersion, 256),
    hardwareAccelerated: boolean(body.hardwareAccelerated),
    metaRuntimeActive: boolean(body.metaRuntimeActive),
    runtimeVersion,
    nvidiaTelemetryAvailable: boolean(body.nvidiaTelemetryAvailable),
    nvidiaAdapterCount: safeInteger(body.nvidiaAdapterCount),
  };
  return Object.freeze(native);
}

function parseRuntimeNativeEvidence(text: string): Omit<
  UltraRuntimeSystemSample,
  "version" | "transport" | "sampledAt"
> {
  const body = exactRecord(parseJson(text), [
    "processRssBytes", "gpuMemoryUsageRatio", "gpuMemoryHeadroomBytes",
    "hardwareThermalSlowdown", "softwareThermalSlowdown", "runtimeConnected",
  ]);
  return Object.freeze({
    processRssBytes: safeInteger(body.processRssBytes),
    gpuMemoryUsageRatio: finiteRatio(body.gpuMemoryUsageRatio),
    gpuMemoryHeadroomBytes: safeInteger(body.gpuMemoryHeadroomBytes),
    thermalThrottleObserved: thermalReasonActive(body.hardwareThermalSlowdown)
      || thermalReasonActive(body.softwareThermalSlowdown),
    runtimeConnected: boolean(body.runtimeConnected),
  });
}

function checkedBrowserEvidence(value: UltraBrowserProbeEvidence): UltraBrowserProbeEvidence {
  if ((value.browserEngine !== "chromium" && value.browserEngine !== "unknown")
    || typeof value.secureContext !== "boolean"
    || typeof value.immersiveVrSupported !== "boolean") {
    throw new TypeError("Windows Ultra browser evidence is invalid.");
  }
  return Object.freeze({ ...value });
}

function checkedSessionScope(value: WindowsUltraSessionScope): WindowsUltraSessionScope {
  if (typeof value !== "object" || value === null
    || Object.keys(value).length !== 1
    || typeof value.rendererSessionId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/u.test(value.rendererSessionId)) {
    throw new TypeError("Windows Ultra session scope is invalid.");
  }
  return Object.freeze({ rendererSessionId: value.rendererSessionId });
}

function checkedFingerprintKey(value: Uint8Array | undefined): Buffer {
  if (value !== undefined && (!(value instanceof Uint8Array) || value.byteLength !== 32)) {
    throw new TypeError("fingerprintKey must contain exactly 32 bytes.");
  }
  return value === undefined ? randomBytes(32) : Buffer.from(value);
}

function waitForShared<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new DOMException("Windows Ultra evidence request was cancelled.", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new DOMException(
      "Windows Ultra evidence request was cancelled.",
      "AbortError",
    ));
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

function checkedTransport(value: string | undefined): UltraTransport | undefined {
  const transport = value?.trim();
  if (!transport) return undefined;
  if (transport !== "link_cable" && transport !== "air_link") {
    throw new Error("SEMAFRAME_XR_ULTRA_TRANSPORT must be link_cable or air_link.");
  }
  return transport;
}

function windowsPowerShellExecutable(value: string | undefined): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("The Windows system directory is unavailable for Ultra evidence.");
  }
  const supplied = value.trim();
  if (supplied.split(/[\\/]/u).some((segment) => segment === "." || segment === "..")) {
    throw new Error("The Windows system directory is invalid for Ultra evidence.");
  }
  const directory = windowsPath.normalize(supplied);
  if (!windowsPath.isAbsolute(directory)
    || directory.startsWith("\\\\")
    || !/^[A-Za-z]:\\/u.test(directory)) {
    throw new Error("The Windows system directory is invalid for Ultra evidence.");
  }
  return windowsPath.join(
    directory,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

async function defaultRunCommand(
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await execFileAsync(executable, [...args], {
    windowsHide: true,
    timeout: POWERSHELL_TIMEOUT_MS,
    maxBuffer: POWERSHELL_MAX_BUFFER_BYTES,
    encoding: "utf8",
    ...(signal ? { signal } : {}),
  });
  return result.stdout;
}

/**
 * Enables the bundled Windows telemetry provider only after the operator has
 * explicitly configured the physical Link transport. Version 1 intentionally
 * requires NVIDIA's signed driver telemetry utility; unsupported/ambiguous
 * hardware remains on Balanced XR instead of guessing from an adapter name.
 */
export function createWindowsUltraEvidenceProvider(
  options: WindowsUltraEvidenceProviderOptions = {},
): WindowsUltraEvidenceProvider | undefined {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const transport = checkedTransport(options.transport ?? process.env.SEMAFRAME_XR_ULTRA_TRANSPORT);
  if (platform !== "win32" || architecture !== "x64" || !transport) return undefined;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const executable = options.powershellExecutable ?? windowsPowerShellExecutable(
    options.windowsDirectory
      ?? process.env.SystemRoot
      ?? process.env.WINDIR
      // A custom runner never executes this path; keep platform-overridden
      // unit tests deterministic without weakening the production path.
      ?? (options.runCommand ? String.raw`C:\Windows` : undefined),
  );
  const now = options.now ?? Date.now;
  const fingerprintKey = checkedFingerprintKey(options.fingerprintKey);
  const powershellArgs = (script: string) => Object.freeze([
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
  ] as const);
  type RuntimeNativeEvidence = ReturnType<typeof parseRuntimeNativeEvidence>;
  let staticFlight: Promise<StaticNativeEvidence> | undefined;
  let runtimeFlight: Promise<RuntimeNativeEvidence> | undefined;
  const collectStaticNative = (signal?: AbortSignal): Promise<StaticNativeEvidence> => {
    if (!staticFlight) {
      const pending = runCommand(
        executable,
        powershellArgs(STATIC_PROBE_SCRIPT),
      ).then(parseStaticNativeEvidence);
      staticFlight = pending;
      void pending.then(
        () => { if (staticFlight === pending) staticFlight = undefined; },
        () => { if (staticFlight === pending) staticFlight = undefined; },
      );
    }
    return waitForShared(staticFlight, signal);
  };
  const collectRuntimeNative = (signal?: AbortSignal): Promise<RuntimeNativeEvidence> => {
    if (!runtimeFlight) {
      const pending = runCommand(
        executable,
        powershellArgs(RUNTIME_SAMPLE_SCRIPT),
      ).then(parseRuntimeNativeEvidence);
      runtimeFlight = pending;
      void pending.then(
        () => { if (runtimeFlight === pending) runtimeFlight = undefined; },
        () => { if (runtimeFlight === pending) runtimeFlight = undefined; },
      );
    }
    return waitForShared(runtimeFlight, signal);
  };

  const provider: WindowsUltraEvidenceProvider = {
    async collectStaticProbe(
      scopeValue: WindowsUltraSessionScope,
      browserValue: UltraBrowserProbeEvidence,
      signal?: AbortSignal,
    ) {
      const scope = checkedSessionScope(scopeValue);
      const browser = checkedBrowserEvidence(browserValue);
      const native = await collectStaticNative(signal);
      const adapterFingerprint = `sha256:${createHmac("sha256", fingerprintKey)
        .update("semaframe-xr-ultra-adapter-v1\u0000", "utf8")
        .update(scope.rendererSessionId, "utf8")
        .update("\u0000", "utf8")
        .update(native.adapterIdentity, "utf8")
        .update("\u0000", "utf8")
        .update(native.driverVersion, "utf8")
        .digest("hex")}`;
      return Object.freeze({
        version: 1,
        policyVersion: ULTRA_POLICY_VERSION,
        platform: "windows",
        architecture: "x64",
        operatingSystemVersion: native.operatingSystemVersion,
        logicalProcessorCount: native.logicalProcessorCount,
        systemMemoryBytes: native.systemMemoryBytes,
        graphics: Object.freeze({
          adapterFingerprint,
          driverVersion: native.driverVersion,
          hardwareAccelerated: native.hardwareAccelerated,
          supportedByRuntime: native.metaRuntimeActive
            && native.nvidiaTelemetryAvailable
            && native.nvidiaAdapterCount === 1,
        }),
        runtime: Object.freeze({
          kind: native.metaRuntimeActive ? "meta_horizon_link" : "none",
          version: native.metaRuntimeActive ? native.runtimeVersion : null,
          openXrActive: native.metaRuntimeActive,
        }),
        webXr: browser,
        collectedAt: new Date(now()).toISOString(),
      });
    },
    async sampleRuntime(scopeValue: WindowsUltraSessionScope, signal?: AbortSignal) {
      checkedSessionScope(scopeValue);
      const native = await collectRuntimeNative(signal);
      return Object.freeze({
        version: 1,
        transport,
        ...native,
        sampledAt: new Date(now()).toISOString(),
      });
    },
  };
  return Object.freeze(provider);
}
