# Extension SDK and native host

This document describes TypeScript source contracts exported from `src/extensions/index.ts` for repository and embedding-host use. The private SemaFrame application package does not expose a compiled public npm-library entrypoint, and the desktop app does not currently provide an extension installation/management UI. Consumers must build against source or create their own versioned package boundary rather than assuming `import ... from "semaframe"` works.

Extension API `1.0` defines four provider kinds:

- `connector`: probe and read bounded external data through a host broker;
- `importer`: inspect an artifact and return a typed Workspace mutation candidate;
- `exporter`: plan and emit bounded artifact candidates from a Workspace snapshot; and
- `bridge`: push or pull typed documents for Blender, CAD, Unity, Unreal, or a custom target.

Providers receive an `ExtensionOperationContextV1` containing exact extension identity, Workspace identity, granted permission IDs, operation limits, an abort signal, structured logging, and a host-owned capability broker. The broker can offer bounded network, artifact, or secret operations without exposing a raw credential value or local path to the provider contract.

## Manifest and package verification

The strict manifest pins:

- manifest schema and API version;
- extension and publisher identity;
- semantic extension version and supported host-version range;
- exact provider descriptors;
- requested permissions, including normalized network origins and secret identifiers;
- a `none` or `native_stdio` entrypoint inside the package root, with native entrypoint byte length and SHA-256;
- package archive byte length and lowercase SHA-256; and
- for native packages, the complete sorted extracted-root file list with canonical relative path, byte length, and SHA-256 for every file.

Unknown fields, duplicate provider or permission IDs, unsafe entrypoint paths, inconsistent provider permissions, and non-normalized network origins are rejected. The canonical manifest used for signing excludes the signature bytes themselves.

The native host requires the ephemeral result of `verifyExtensionPackageV1` for the exact manifest/package and refuses reconstructed evidence. It then verifies the selected extracted root against the complete manifest tree: missing or extra files/directories, symbolic links, special files, unsafe/case-colliding paths, changed sizes, and changed digests all fail closed. The installer remains responsible for extracting `packageRoot` only from those verified package bytes; the host independently verifies that extraction rather than trusting it. The host-version range is ordered and enforced at launch, including SemVer prerelease precedence.

An Ed25519 signature is optional at the SDK level so local development and test fixtures remain possible. A production installer can set `requireSignature` and supply a verifier backed by pinned publisher keys. The SDK does not download keys or decide publisher trust by itself.

Permission grants are separate from manifests. A grant is bound to the exact extension ID, version, manifest digest, Workspace, provider IDs, allowed permissions, network origins, secret IDs, issuance time, and expiry. Changing any bound package identity invalidates the grant.

## Native stdio boundary

`NativeStdioExtensionHost` owns exactly one child process and communicates through capability-tagged, length-framed JSON. It:

- resolves the source root, working directory, and optional host runner to real absolute paths;
- copies only verified manifest-listed bytes into a private, read-only, host-owned snapshot with no extra entries;
- maps the entrypoint and working directory into that snapshot, rechecks it after native authorization, and executes only from the snapshot;
- removes the private snapshot when the owned child exits;
- passes a minimized, explicit environment instead of inheriting the whole host environment;
- validates the initialization reply against the exact manifest provider set;
- allows only the provider methods declared by Extension API v1 and maps bridge probe/push/pull to a declared direction permission;
- reauthorizes the requested provider permission before every invocation;
- rejects oversized, malformed, duplicate, unsolicited, or capability-mismatched frames; and
- terminates the owned process after a request timeout, abort, protocol failure, or failed shutdown grace period.

This is lifecycle and protocol isolation, not an operating-system sandbox. Once a person installs and authorizes a native executable, that executable runs with the user's OS account rights. The package must therefore come from a trusted publisher even when its digest and signature are valid.

## Conformance helpers

The current conformance runner covers connector and exporter provider behavior. It checks provider identity, bounded/canonical result shapes, operation limits, and deterministic safe artifacts using a broker that grants neither network nor secrets. Passing conformance is necessary for interoperability but is not a security review and does not prove a remote service is correct.

Focused tests live under `src/tests/extensions/`. The native protocol fixture is `scripts/extension-fixture-host.mjs`; it is test infrastructure and is not part of the production CLI package.
