# SemaFrame launch video

This folder contains the reproducible launch-video source. The screenshots and interaction frames are captured from a real local Agent handshake and real Workspace MCP transactions; the edit only adds pacing, framing, explanatory typography, and an original generated score.

## Outputs

- `SemaFrameHero`: 1920×1080, 78 seconds
- `SemaFrameShort`: 1080×1920, 18 seconds
- `SemaFramePoster`: 1920×1080 still
- English and Simplified Chinese subtitle files under `video/captions`

Published binaries live in the [`v0.2.0` GitHub Release](https://github.com/riseagain1/semaframe/releases/tag/v0.2.0). The repository keeps the reproducible Remotion source, captions, captured evidence, and the lightweight README poster; generated MP4 and WAV files stay out of Git history.

## Rebuild

```bash
npm run demo:capture
npm run demo:typecheck
npm run demo:render
npm run demo:render:short
npm run demo:render:poster
```

`demo:capture` starts isolated local Vite, Gateway, Chrome, and MCP processes. It uses a deterministic inline snapshot rather than depending on an external feed. Connection and transaction capabilities are not written to video assets; the displayed connection URL is replaced with a non-authorizing placeholder before capture.

The score in `video/public/audio/semaframe-original-bed.wav` is generated locally by `scripts/generate-demo-audio.mjs`, is project-owned, and is intentionally ignored by Git.
