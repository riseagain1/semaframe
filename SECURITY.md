# Security Policy

SemaFrame accepts responsible vulnerability reports for the current `0.3.x` line and the latest commit on `main`.

## Reporting a vulnerability

Do not open a public issue for an unpatched vulnerability or include live credentials, connection URLs, project capabilities, or private feed data in a report.

Use GitHub's private vulnerability reporting flow:

<https://github.com/riseagain1/semaframe/security/advisories/new>

Include:

- the affected version or commit;
- a minimal reproduction;
- the expected and observed security boundary;
- likely impact;
- any suggested remediation;
- whether the report contains secrets that should be rotated.

The maintainer aims to acknowledge a complete report within three business days and provide a status update within seven business days. Timelines may vary with severity and complexity. There is currently no paid bug-bounty program.

## Security model

The loopback Agent Gateway, browser approval lease, MCP sessions, transaction capabilities, feed broker, project parser, resource bindings, website/video facades, and declarative recipe validation are in scope.

SemaFrame's trust model is application-level. A malicious local process that can impersonate the browser, read another process's memory, or control the operating system is outside the promised boundary. See the README's security and current-boundaries sections before reporting an intended limitation as a vulnerability.

## Supported versions

| Version | Supported |
| --- | --- |
| `0.3.x` | Yes |
| `<= 0.2` | No |
