# Voice Relay native helpers

These small, platform-specific executables are the only SemaFrame processes
allowed to inspect or operate the Agent window selected by the desktop user.
They communicate with the Node host over length-framed JSON-RPC on inherited
stdin/stdout. They do not listen on a socket, use a shell, read the clipboard,
or emit window/transcript content to logs.

Build on macOS:

```sh
sh native/voice-relay/macos/build.sh
```

Build on Windows (PowerShell with the .NET 8 SDK):

```powershell
native\voice-relay\windows\build.ps1
```

The `build/` directories are intentionally ignored. Release packaging must
ship the appropriate helper beside SemaFrame and pass its pinned SHA-256 to
`createVoiceRelayNativeClient`. The factory rejects symlinks, writable or
unexpectedly owned Unix executables, digest mismatches, and unsupported
platforms. The development bypass is explicit and must not be enabled in a
release build.

macOS requires the user to grant Accessibility permission. Windows UI
Automation can only operate a target at an equal or lower integrity level;
SemaFrame must not request elevation to bypass that boundary.

Target discovery is fail-closed. A target is compatible only when the helper
can bind one semantically identified Agent composer to one exact, explicit
Send/Submit control in the same local interaction region. The helper pins the
application launch, window, composer, Send, interaction-root, and target-
generation identities and revalidates all of them before confirmation; it does
not search for a replacement button at Send time. Generic Run/Enter controls,
window-wide pairings and off-screen controls are rejected. Composer/Send
controls must expose either a native identifier or a stable semantic
accessibility label; in both cases the helper also retains the exact native
element identity. Known ChatGPT/Codex surfaces have a narrow adapter for the
documented `Do anything` composer label, while generic windows still require
message/prompt/composer/chat semantics. If two distinct composer/Send pairs are
similarly plausible, discovery marks the window incompatible instead of
silently choosing one.

Draft staging is a compensated operation. Every request carries the exact
stage ID, draft SHA-256, and configured target generation. If the IPC reply is
lost or the caller aborts, the host issues an idempotent `abort_stage` for that
exact tuple. The helper clears the composer only while its content still
matches the expected digest; a human edit is preserved and disables the relay.
If compensation cannot be proven, the host requests shutdown and closes the
owned helper's stdin so EOF cleanup gets the same digest-checked opportunity
and no later Send can occur. It allows a bounded natural-exit grace before the
force-kill fallback; failure to prove cleanup is surfaced to the host.
The no-send diagnostic nonce uses the same transient digest/generation cleanup
ownership, including across native write/readback errors and helper EOF.
Console termination remains parent-coordinated: the helper does not race the
Node owner on a process-group Ctrl-C/termination event, and inherited stdin EOF
still guarantees a final cleanup attempt if the owner disappears.

Reply observation is a separate optional capability. It is advertised only
when a stable, semantically identified response container is locally tied to
the configured composer region and exposes bounded message identities. The
helper diffs those identities after Send, excludes the exact echoed user
draft, and returns at most one unambiguous assistant response. Missing,
reordered, unrelated, or multiply changed branches make the observation
unavailable; the helper never falls back to reading the whole window.

Passive setup and diagnostics never show an operating-system consent prompt.
Only the separate, user-confirmed Accessibility setup action may request the
macOS prompt.
