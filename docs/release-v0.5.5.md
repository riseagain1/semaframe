# SemaFrame v0.5.5 — Pairing recovery without repeated URL resets

This patch fixes a connection-discovery race found while reconnecting an existing
Workspace. It preserves the normal human approval and permission boundaries.

## What changes

- **Stale discovery cannot clear a new connection.** Discovery reads capture the
  upstream client and snapshot before awaiting the network, then check both again
  at the mutation boundary. An old response cannot close a replacement client or
  discard its private approval continuation.
- **Actionable handshake retries.** Changing explicit client identity or scopes
  returns a clear mismatch diagnostic without forwarding the cached proof. Retry
  with the original context, or omit those fields to continue the same session.
- **Verified explicit continuation.** If a caller resumes with its own proof,
  the adapter caches it only after upstream success and only under the canonical
  response identity and requested scopes. Tokens remain session-local and in memory.
- **Clearer connection UI.** Stable launchers discover current offers automatically;
  repeatedly pasting new URLs is unnecessary. If a restarted client has lost its
  private continuation, the pending-request card exposes an explicit start-over
  path, followed by a new fingerprint and human approval.

No project schema, Workspace protocol or permission-scope migration is required.
This does not auto-approve clients, preserve credentials in projects, extend
approval deadlines, or replay writes. Fresh approval is still required when the
previous authority has expired or been invalidated.

## Verification and boundaries

Regression coverage includes a real stdio delayed-discovery reproduction,
post-await replacement, explicit-proof provenance and UI recovery states.
A real native MCP read-only run completed approval, automatic continuation and
three concurrent reads. The original scene stayed at revision 10 with 19 components
and one event connection; the complete returned summary matched the pre-fix
baseline and the saved backup checksum did not change.

The [verification report](https://github.com/riseagain1/semaframe/blob/v0.5.5/docs/verification/agent-pairing-recovery-2026-10-16.md)
separates automated gates from live evidence. This patch's live test did not reload
the original browser, rebuild its scene, perform a new DeepSeek modeling run, or
claim new physical-device acceptance. The existing
[v0.5.4 handoff acceptance](https://github.com/riseagain1/semaframe/blob/v0.5.4/docs/verification/agent-session-resilience-2026-10-16.md)
remains separate historical evidence.

## Install and run

Requires Node.js 22.12 or newer:

```sh
npm exec --yes --package=semaframe@latest -- semaframe doctor
npm exec --yes --package=semaframe@latest -- semaframe start
```

Pin this patch for reproducibility:

```sh
npm exec --yes --package=semaframe@0.5.5 -- semaframe doctor
npm exec --yes --package=semaframe@0.5.5 -- semaframe start
npm exec --yes --package=semaframe@0.5.5 -- semaframe agent launch --client dsh
```

Restart an existing MCP connector through its client's normal workflow to load
updated code. If the installation path changed, update its managed registration
or DSH overlay as well. Configure model credentials in the Agent, not SemaFrame.
DSH's own Node requirement may be higher than SemaFrame's minimum.

SemaFrame is a source CLI package, not a signed desktop installer. Stable denotes
the release channel, not a guarantee of zero bugs or universal Agent compatibility.

See the [README](https://github.com/riseagain1/semaframe/blob/v0.5.5/README.md),
[changelog](https://github.com/riseagain1/semaframe/blob/v0.5.5/CHANGELOG.md), and
[v0.5.4…v0.5.5 comparison](https://github.com/riseagain1/semaframe/compare/v0.5.4...v0.5.5).
