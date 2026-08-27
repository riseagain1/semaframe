# Anonymous performance diagnostics

Anonymous performance diagnostics are off by default. Enabling them only allows a caller to build a payload; transmission remains a separate, explicit host action. `previewAnonymousPerformanceDiagnostic` returns the exact serialized payload and byte count before a caller sends anything.

## Data minimization

The version 1 schema contains only coarse runtime categories and these bounded numeric metrics:

- startup time;
- Workspace open time;
- command-apply p95;
- frame-time p95;
- dropped-frame ratio.

The exact-object parser rejects every other field. There is no user, device, install, session, or project identifier; no Workspace content or component count; no URL, digest, path, token, asset name, stack trace, timestamp, IP address, or User-Agent.

## Self-hosted collector boundary

The collector core in `server/diagnostics/` has no vendor endpoint. A deployment supplies a rate limiter and retention store. Transport metadata is handled by `admitAndDiscardDiagnosticTransportMetadata`: the IP address is passed only to the ephemeral rate limiter, the User-Agent is ignored, and neither reaches the collector record. The included in-memory limiter retains only process-randomized, window-scoped buckets, caps the bucket count, and drops all buckets after the rate window.

Retention is explicit and capped at 30 days. The included default is seven days. The in-memory store also has a fixed record capacity and evicts the oldest record on overflow. Stored records contain only the server receipt time and the already validated allowlisted payload.
