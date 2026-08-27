# Connector, artifact, catalog, and diagnostic services

These host services turn extension and community outputs into bounded data. None of them can mutate a `WorkspaceStore` directly. They are opt-in integration primitives: the current app/gateway does not instantiate or route `ConnectorRegistryV1`, `ArtifactJobService`, `ArtifactJobHttpHandler`, the catalog planner, or the diagnostics collector automatically. An embedding host must construct them, supply authorization/transport, and mount any HTTP surface explicitly.

## Connector registry

`ConnectorRegistryV1` is created for one exact Workspace ID and captures a deterministic, digest-addressed provider set. It includes the built-in `inline.snapshot` and `http.feed` capabilities by default and can add preverified extension registrations.

There is intentionally no `register` or `unregister` method. Installing an extension affects the registry of a later Workspace session instead of hot-swapping executable code into an open project. A connector type/version without a provider resolves to `missing_provider` / `read_only`; a stored immutable snapshot remains readable.

For execution, the registry:

- binds the request to its Workspace and exact connector type/version;
- canonicalizes and bounds public configuration to 512 KiB;
- rejects credential-like configuration values;
- requires an extension grant for extension-origin providers;
- calls only a host-supplied invocation callback with an abort signal; and
- validates and normalizes at most 10,000 returned items and 4 MiB of canonical item JSON by default into a content-hashed `ResourceSnapshot` with bounded provenance.

The registry itself is not a network client. DNS, redirect, TLS, credential, and destination policy belong to the host broker. The built-in HTTP feed continues to use SemaFrame's existing bounded public-HTTPS broker.

## Artifact jobs

`ArtifactJobService` executes registered exporter and bridge providers asynchronously. A provider receives frozen canonical JSON, the Workspace ID, an abort signal, hard output/runtime limits, and a progress callback. There is no raw filesystem-path, process, network, or secret API in the job contract.

Default limits are:

| Limit | Default |
| --- | ---: |
| Queued jobs | 32 |
| Concurrent jobs | 2 |
| Runtime | 30 seconds |
| Total output | 32 MiB |
| Artifacts per job | 16 |
| Terminal result retention | 10 minutes |
| Canonical request JSON | 4 MiB |

Jobs are scoped to an owner and Workspace. Reusing one request ID with identical provider and payload is idempotent; changing the payload fails. Extension-origin providers require an exact host authorization callback. Cancellation aborts queued or running work, and a timeout fails the job even if provider code ignores its cooperative signal.

Successful output filenames, media types, byte totals, metadata, and duplicate names are validated before publication. Canonical metadata bytes count against the same total-output budget as artifact bytes. Bytes are copied into a content-addressed store, rehashed on read, reference-counted across jobs, and deleted when the last retained job expires or is discarded. Public error/progress text is bounded and redacts recognizable credentials, JWT-shaped values, and local paths.

The in-process scheduler is not durable across host restarts, and its timeout is a promise boundary rather than an OS process kill. Run untrusted native providers through `NativeStdioExtensionHost`, whose timeout owns and terminates the child process.

## Signed template catalog

The static template catalog uses a pinned Ed25519 operator key, monotonic sequence, signed validity interval, catalog-relative artifact paths, and lowercase SHA-256 for every descriptor. Verification rejects unknown fields, unsafe paths, duplicate `id@version`, signature/key mismatch, expiry, a validity window above 31 days, and rollback.

A verified catalog may be reused without revalidation for one hour. Only an in-process proof produced by signature verification can create a trusted cache record; a deserialized catalog must be verified again. Offline fallback is allowed only while the signed catalog remains unexpired. Descriptor bytes are hashed before UTF-8 decoding or JSON parsing, and descriptor identity must match the signed entry.

Project and model templates are ordinary bounded Workspace Protocol operation lists. Planning requires the current app version and enforces each descriptor's `minimumAppVersion`. It returns a new-project or current-revision transaction proposal with `authorization.status = "not_granted"`; the host must show it, obtain permission, and submit through the normal transaction path. The included first-party examples are a Decision Board project and a one-metre Reference Block model.

See [Template catalog and community contributions](../extensions/template-catalog.md).

## Anonymous performance diagnostics

Diagnostics are off by default. When enabled, the preview contains only coarse runtime categories and an allowlist of startup, Workspace-open, command-apply p95, frame p95, and dropped-frame metrics. Unknown fields and out-of-range values are rejected. No project content, stable ID, URL, digest, path, token, asset name, stack trace, timestamp, IP address, or User-Agent is part of the client payload.

Building or previewing the payload does not send it. The included collector has no vendor endpoint; a deployment must provide transport, rate admission, and retention. The example in-memory limiter caps its current-window source buckets, and the in-memory store evicts oldest records at a fixed capacity. The collector uses seven-day retention by default and rejects a configured retention above 30 days.

See [Anonymous performance diagnostics](../extensions/anonymous-performance-diagnostics.md).
