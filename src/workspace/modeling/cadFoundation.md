# Browser CAD foundation

SemaFrame's CAD foundation is a real boundary-representation (B-rep) kernel,
not a triangle-mesh approximation presented as CAD. It uses OpenCascade
Technology compiled to WebAssembly by `replicad-opencascadejs`, with Replicad
as the narrow TypeScript adapter. The public contract is intentionally much
smaller than either upstream API.

## Supported contract

`cadKernel.ts` exposes SI-metre box, cylinder, and sphere primitives; uniform
scale, axis-angle rotation, and translation; union, cut, and intersection;
OCCT topology validation; volume, area, centre of mass, density-derived mass,
and bounds; bounded indexed tessellation; and AP242 STEP export in metres.

`cad/` builds a replay-safe authoring layer above that kernel. A
`CadPartDefinitionV1` contains bounded dimension-aware parameter expressions,
line/circle/arc sketches and constraints, ordered features, and active body
identity. `CadKernel.evaluatePart` and the Worker RPC execute sketch, extrude,
revolve, boolean, hole, and explicit all-edge fillet/chamfer features as real
OCCT solids. Shell, sweep, loft, and linear/circular patterns are schema-reserved
but raise the internal evaluator code `unsupported_cad_feature` in V1; the
public `CadKernel.evaluatePart` boundary reports this as
`cad_part_evaluation_failed`. Evaluation returns compact
digest-matched evidence plus transferable render meshes; OCCT objects never
cross the runtime boundary or enter project persistence.

`cadHandoff.ts` uses an internal same-runtime borrowed-shape seam to build a
non-unioned XCAF product assembly. Its deterministic package includes AP242
STEP, USDA, the full editable Model Definition, and a verification report. The
export is accepted only after OCCT re-import proves solid count, aggregate
world bounds, and volume. STEP preserves exact direct-editable B-rep and
occurrences, while the SemaFrame sidecar—not STEP—preserves the native semantic
feature history and assembly mate intent.

The application receives opaque shape handles. It never receives an OCCT
pointer, Emscripten filesystem, or Replicad object. Every created solid is
validated with `BRepCheck_Analyzer`, every measured/tessellated result is
checked for finite values and hard output limits, and every handle has an
explicit `release` lifecycle.

```ts
import { createCadWorkerKernel } from "./cadWorkerClient";

const cad = await createCadWorkerKernel();
const block = await cad.createBox({ sizeM: { x: 0.2, y: 0.1, z: 0.05 } });
const hole = await cad.createCylinder({ radiusM: 0.01, heightM: 0.1 });
const result = await cad.boolean("cut", block, hole);

const properties = await cad.measure(result, 2_700); // aluminium kg/m3
const mesh = await cad.tessellate(result, { linearDeflectionM: 0.0002 });
const step = await cad.exportStep(result, "Mounting block");

await cad.dispose();
```

`loadCadKernel()` is also available for Node tests, controlled server code, or
code already running inside a Worker. Its time checks are cooperative, so an
untrusted server workload still needs an outer disposable Worker/process hard
stop. Merely importing the module does not initialize the WASM runtime.

The Agent adapter therefore uses the browser Worker by default and fails
closed when a host has no disposable Worker. Its direct-kernel factory seam is
for controlled tests or an outer process that already supplies a hard stop; it
is never selected implicitly for untrusted Agent work.

Project JSON is an untrusted transport, not proof that persisted measurements
came from OCCT. The browser project-open and recovery paths re-evaluate every
unique CAD definition in a disposable Worker, compare the complete compact
evidence, and refuse to open on mismatch, timeout, capacity overflow, or a
missing hard-stop runtime. The synchronous serializer refuses to replay an
unverified deserialized CAD project.

## Execution and cancellation

The distributed OCCT build is single-threaded. A synchronous native B-rep call
cannot be interrupted from JavaScript once entered. The direct kernel therefore
checks an abort signal and elapsed budget before and after each call and
serializes calls on a kernel instance, but those checks are cooperative.

`createCadWorkerKernel()` is the production browser seam. It compiles and runs
OCCT in a dedicated Worker. If an operation exceeds its budget or its signal is
aborted, the client terminates that Worker. This is a hard stop, and therefore
invalidates every handle owned by it; create a fresh worker kernel to continue.
This trade-off is explicit instead of implying that a synchronous WASM call can
be safely preempted.

The WASM asset is fingerprinted and served with the application. There is no
CDN, package lookup, or third-party network dependency at runtime. A browser
still fetches the application's own WASM asset in the normal way.

## Bounds and failure boundary

Important v1 caps include 1,000 m primitive/CAD dimensions, 256 parameters,
256 features, 64 active CAD bodies, 128 sketch variables and constraints,
5,000 m evaluated
shape extents, 256 live handles, boolean complexity 128, 500,000 aggregate mesh
vertices, 1,000,000 aggregate triangles, 32 MiB aggregate transferable mesh
buffers, 64 MiB STEP text, and a maximum operation budget of 120 s.
See `CAD_KERNEL_LIMITS` for the authoritative values. Failures use stable
`CadKernelError.code` values, including `invalid_input`, `limit_exceeded`,
`shape_invalid`, `boolean_failed`, `operation_timeout`, and `aborted`.

STEP import is deliberately not in v1. A byte limit alone cannot bound topology,
allocation, or parse time for an untrusted STEP file before OCCT parses it. It
should only be added through a disposable Worker with separate memory/process
limits and post-import topology caps. Exported STEP is integration-tested by
parsing it back through the real OCCT STEP reader and checking solid count,
aggregate world bounds, and volume. Product names and occurrence records are
also checked in the emitted Part 21 text; this version does not claim a full
semantic XCAF re-import audit of every name, color, or hierarchy relationship.

## Bundle and licensing implications

- `replicad@1.0.0` is MIT licensed.
- `replicad-opencascadejs@1.0.0` declares `LGPL-2.1-only` and contains the OCCT
  WebAssembly build. SemaFrame's MIT license does not relicense that binary.
- The selected single-threaded WASM asset is about 22 MiB uncompressed. It is
  lazy-loaded with the CAD worker; the package's separate multi-threaded build
  is not referenced or emitted by this integration. Production hosting should
  enable Brotli/gzip and long-lived immutable caching for the fingerprinted
  asset.
- A distributor must preserve the relevant copyright/license notices and
  satisfy the LGPL requirements that apply to the shipped WASM library,
  including users' applicable rights to modify/relink/debug the library. This
  note is engineering guidance, not legal advice; release owners should review
  the exact distribution with counsel.

The dependency versions are exact pins so kernel behavior and validation
evidence cannot silently drift under a new upstream release.
