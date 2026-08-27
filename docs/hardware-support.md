# SemaFrame hardware and runtime support

This matrix separates implemented code paths from hardware claims. A green
automated suite proves contracts, persistence, security boundaries, and build
compatibility; it does not certify headset comfort, tracking, GPU stability,
photogrammetry quality, or engineering accuracy on a device that was not
physically present.

## Evidence levels

| Level | Meaning |
| --- | --- |
| **Automated** | The path is built and its deterministic contracts run in CI. |
| **Host smoke** | A real browser or native helper has completed a bounded smoke flow on that operating system. |
| **Device smoke** | The named physical device has completed the release checklist on the exact browser/runtime combination. |
| **Certified** | SemaFrame publishes a supported hardware/driver range and maintains a repeatable qualification program. |

SemaFrame currently has automated and selected smoke evidence. It does **not**
claim hardware certification.

## Desktop authoring and local services

| Host | Workspace and Agent gateway | Optional capabilities | Current evidence |
| --- | --- | --- | --- |
| macOS, Apple silicon | Supported with Node.js 22.12+ and a current WebGL browser | Native Voice Relay helper; local photo reconstruction only when RealityKit reports `PhotogrammetrySession.isSupported` and Xcode command-line tools are present | Automated suite, production builds, and real Chrome smoke on the development host. Reconstruction remains capability-probed per machine. |
| macOS, Intel | Core browser Workspace is expected to run; no PCVR claim | Voice Relay may build; Apple Object Capture is treated as unavailable unless the runtime probe succeeds | No maintained physical-device matrix. Do not promise reconstruction or immersive XR. |
| Windows 11 x64 | Supported source build and local gateway path | Native UI Automation Voice Relay helper; standards-based PCVR; guarded Ultra path | Windows CI builds the XR bundle and native helper and runs launcher contracts. Physical PCVR/GPU validation is still required. |
| Ubuntu Linux x64 | Core Workspace, gateway, and non-immersive XR renderer | No native Voice Relay helper | Ubuntu CI runs typecheck, lint, builds, full coverage, and real Chrome Workspace/Agent smoke. |

Chrome/Chromium is the release-smoke browser. Other modern browsers may run the
ordinary Workspace, but a feature must not be called supported solely because
it passes static feature detection. WebXR support is determined by the browser,
secure context, operating system, and active OpenXR runtime together.

## XR paths

| Path | Intended profile | Current evidence | Release claim |
| --- | --- | --- | --- |
| Desktop XR simulator | macOS, Windows, or Linux browser without `immersive-vr` | Automated authority, pairing, replication, input, reconnect, panel, and asset tests | Supported as a clearly labelled non-immersive simulator. |
| Meta Quest browser, remote-headset mode | Balanced XR over a trusted LAN HTTPS origin | Six-digit/single-use pairing, lifecycle, renderer isolation, context, and recovery are automated; Quest 3 integration has been exercised during development | Implemented, not certified. Re-run the physical checklist for every release/browser update. |
| Same-device WebXR | Any browser/runtime that reports `immersive-vr` | Automated user-gesture, lifecycle, context, and teardown contracts | Implemented; the actual browser/OpenXR combination needs a device smoke. |
| Windows Meta Horizon Link PCVR | Balanced XR through the active OpenXR runtime | Windows build/launcher CI plus runtime-neutral WebXR tests | Implemented path, not a latency, comfort, or driver certification. |
| Windows PCVR Ultra | One NVIDIA adapter, Meta Horizon Link, hardware acceleration, and a passing in-headset reference benchmark | Fail-closed native probe and benchmark policy are automated | Never enabled by a label or config flag alone. Each machine must pass the current physical benchmark and revalidation window. |
| Apple Vision Pro or other headsets | Standards-based WebXR where available | No maintained device smoke | Experimental/unknown; do not advertise as supported. |

### Quest / remote-headset release checklist

Run this on the exact headset browser version that will be demonstrated:

1. `semaframe doctor --xr` reports no required failure.
2. The headset reaches the configured trusted HTTPS XR URL over the same LAN.
3. Both the six-digit code and the fragment-secret link pair once; replay and an expired code fail.
4. The viewer enters and exits immersive XR only after the headset user gesture.
5. A live Workspace edit appears without a black frame, authority fork, or replayed build reveal.
6. Selection, controller rays, teleport, a world-space panel action, live head/controller context, and a Spatial Pin reach the host at the matching revision.
7. Disconnect/reconnect and project replacement clear stale context and do not resurrect the previous scene.
8. Voice Relay is visibly off by default. A voice-capable Agent using the computer microphone requires no headset audio setup.

Record the host OS, browser/runtime version, headset firmware, transport, scene
size, and result. A single successful run is device-smoke evidence, not a broad
compatibility guarantee.

## Modeling, CAD, Reality, and physics boundaries

| Capability | Hardware dependency | What validation establishes |
| --- | --- | --- |
| Parametric primitives, assemblies, collision, and bounded physics | Browser CPU/WebGL; no special device | Deterministic semantic state, placement preflight, and stated bounded physics checks—not FEA or certification. |
| Manifold OBJ/STL and OpenUSD USDA | WebAssembly-capable browser | Reproducible interchange artifacts within documented limits. |
| AP242 STEP / CAD handoff | OpenCascade WebAssembly Worker and sufficient memory | Host-authored solid evidence plus OCCT re-import verification—not every downstream CAD kernel/version. |
| Gaussian PLY/SPZ/SOG import | WebGL2 and scene-specific GPU memory | Visual playback under explicit budgets. Splats remain visual-only until paired with calibrated semantic proxies. |
| Photo-set reconstruction | Supported macOS RealityKit Object Capture runtime, Xcode command-line tools, disk and memory headroom | A bounded local textured-mesh-to-Gaussian workflow. It does not establish survey, metrology, or CAD tolerance. |

Before calling a deployment production-ready, pin the OS/browser/runtime,
complete the applicable physical checklist, test the largest representative
project, and preserve its evidence alongside the release.
