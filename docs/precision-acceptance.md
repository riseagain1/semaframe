# Precision acceptance and physical validation

This is SemaFrame's bounded validation protocol, not an industry certification,
survey standard or guarantee of a capture device's accuracy. A software test
passing does not demonstrate the accuracy of a physical reconstruction.

## What the current result means

An accepted precision study means the **declared independent observations**
passed the chosen policy in the declared working frame. It does not approve
unmeasured surfaces, concealed features, materials, loads, manufacturing fitness
or safety-critical use. `RUB` identifies the working axes, not a geodetic datum.

A separate CAD comparison evaluates every supplied vertex in each direction
against the other mesh's triangle surfaces, using exact bounded spatial queries.
It does not prove the maximum error between samples. Point-only inputs remain
nearest-vertex diagnostics. A passing source study does not automatically validate
a derived CAD part.

Source hashes protect file integrity. They do not establish who measured an
object, whether a reference is truthful or whether an instrument was calibrated.
Uncertainty values and coverage regions are supplied claims and are reported as
such. Neither a clean CAD solid nor a small registration residual establishes
real-world accuracy.

## Bounded first validation cohort

Use static, rigid, opaque tabletop objects or small equipment envelopes. Include
at least a planar/prismatic part, a cylindrical part, and a part containing
separated critical features such as hole locations or steps. Include a deliberately
poor capture and an object outside the intended capture assumptions, so that the
failure paths are exercised as well as the favorable paths.

Do not use transparent or deforming objects, moving wires, hidden internals,
building-scale survey or safety-critical infrastructure as the first accuracy
claim. Those need different acquisition and validation evidence.

## Freeze the acceptance contract before fitting

For each object, record:

- Intended use, dimensions/regions that matter, and a tolerance for that use.
- Reference source, measurement method, instrument identity, acquisition time,
  repeated readings and the basis of the supplied error bound. Instrument display
  resolution alone is not an uncertainty assessment.
- Source-unit and working-axis declarations; whether only local dimensions or
  registered positions are being checked.
- Acquisition conditions, photo coverage, raw capture/reconstruction files and
  their hashes. Preserve the original data rather than only the visual splat.
- Separate fit controls and held-out checks, chosen before fitting. Include
  spatially distributed checks and distinct critical features rather than many
  copies of one favorable observation.
- Required regions and explicitly unobserved regions. A region name is a supplied
  coverage declaration, not proof that its entire surface was observed.
- Model/backend versions, registration settings and the exact acceptance policy.

The software requires at least three independent point/dimension checks. This is
a software floor, not a universal sufficient sample count. The physical experiment
must justify the number and placement for its intended use.

## Keep controls and checks separate

Controls may establish scale, orientation and position. Checks must not be used to
fit those quantities, tune model parameters, select the winning reconstruction or
pick a favorable result. A fit residual is never reported as held-out accuracy.

The schema rejects repeated IDs, control vertices reused as checks, coordinate
aliases of controls and duplicate check dimensions. It cannot detect a human or
Agent copying a measurement under a new semantic identity. Preserve a frozen
measurement ledger and review independence outside the fitted model as well.

If a model is revised after its held-out failures are inspected, those checks are
now development evidence. Obtain new independent checks before making a fresh
acceptance claim. Do not relabel failed checks, trim them silently or change the
tolerance after seeing the errors.

## Execute and retain failures

1. Capture and reconstruct the object without using the held-out measurements.
2. Apply a proper rigid or uniform similarity transform using controls only.
   Collinear or ill-conditioned controls are rejected. No anisotropic stretching
   is used to force a match.
3. Evaluate held-out points and dimensions. Record each discrepancy, uncertainty,
   status and region. Missing uncertainty remains unknown, not zero.
4. If evaluating scan-to-CAD surface agreement, provide a separately justified
   surface uncertainty bound and its basis. Three successful dimensions do not
   bound every scan vertex. Include registration and tessellation allowances.
5. Keep both directions of comparison, worst deviations and failed observations.
   Reverse comparison helps expose extra CAD geometry or incomplete capture, but
   does not make an unobserved surface verified.
6. Repeat acquisition independently rather than reporting only the best run.
   Include changes of capture session and, where feasible, operator. Preserve the
   complete outcome distribution and acquisition conditions.

The current acceptance arithmetic treats supplied uncertainties as conservative
error bounds: an observation passes when its error plus the applicable bound is
within the tolerance. An interval crossing the threshold is inconclusive, not a
pass. The software does not infer a confidence percentage or automatically turn a
standard deviation into an expanded uncertainty.

## Lifecycle and export checks

Before delivery, verify the complete chain:

- Agent imports evidence and creates a study; human can inspect and edit it.
- Changing geometry, references, registration, policy or CAD definition changes
  the corresponding dependency digest and forces a fresh assessment.
- Undo/redo and portable save/reopen preserve evidence and recompute reports.
- Missing/corrupted evidence cannot be hidden behind a serialized passing label.
- CAD comparison uses the actual host-evaluated part, not a caller-written pass.
- STEP/OpenUSD export is independently reopened and measured for units,
  orientation, placement and relevant dimensions. Faithful export is a distinct
  check from physical accuracy.

## Release evidence

Publish the declared scope, acquisition/reference methods, acceptance policy,
successful and failed observations, repeat-run outcomes, implementation versions
and known limitations. Do not publish private or unlicensed capture data; use
appropriately permissioned test assets.

If trustworthy independent physical references or repeated acquisitions are not
available, release the feature as a **precision modeling and validation workflow**.
Do not describe that release as field-validated millimetre reconstruction. Synthetic
fixtures, public pictures, visual inspection and attractive demos cannot close the
physical-accuracy gate.

## Development verification — 2026-10-12

Verified on the development macOS host, using synthetic and adversarial fixtures:

- Full Vitest regression: 246 test files, 1,779 passing tests.
- Real-browser `npm run smoke:precision`: approved MCP source upload,
  retained-byte/geometry authentication, metric study and held-out checks,
  actual OCCT Worker CAD evaluation, conservative comparison, undo/redo/save,
  modified-coordinate rejection, preview/report occlusion checks, and human
  Inspector CAD creation followed by MCP comparison in the same working frame.
- Real OCCT STEP export/reimport of a fitted shaft: analytic metre bounds and
  volume checked before and after radius/length edits. This is numeric transfer
  verification against a synthetic fixture, not a physical tolerance result.
- Clean-vault portable replay, missing/corrupt evidence, custom-vault corruption,
  forged reports, import rollback, stale operations, and permission failures.
- ESLint, desktop and standalone XR production builds, and packed CLI install /
  service-start verification. XR build success is not headset hardware acceptance.

The physical-accuracy gate remains open: no independently measured physical
object, calibrated reference instrument, or repeated acquisition experiment was
available in this implementation run. No achieved real-world accuracy is claimed.
