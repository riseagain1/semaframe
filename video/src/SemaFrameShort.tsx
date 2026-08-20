import { Audio } from "@remotion/media";
import type { ReactNode } from "react";
import { AbsoluteFill, Img, interpolate, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Badge, clamp, Kicker, PaperBackground, SceneFade, Title, Wordmark } from "./components";
import { sans, theme } from "./theme";

const VerticalScene = ({ duration, children, dark = false }: { duration: number; children: ReactNode; dark?: boolean }) => (
  <SceneFade duration={duration}>
    <PaperBackground dark={dark} />
    {children}
  </SceneFade>
);

export const SemaFrameShort = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const motionFrame = Math.max(0, Math.min(47, Math.floor(interpolate(frame, [185, 315], [0, 47], clamp))));
  const physicsAfter = interpolate(frame, [365, 420], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ background: theme.paper }}>
      <Audio src={staticFile("audio/semaframe-original-bed.wav")} volume={(f) => interpolate(f, [0, fps, durationInFrames - fps, durationInFrames], [0, 0.9, 0.9, 0], clamp)} />
      <Sequence from={0} durationInFrames={150} premountFor={30}>
        <VerticalScene duration={150}>
          <AbsoluteFill style={{ padding: "145px 78px", justifyContent: "center" }}>
            <Wordmark compact />
            <Title style={{ fontSize: 86, marginTop: 72 }}>Agents need a world they can inspect.</Title>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 54 }}>
              <Badge tone="orange">LIVE DATA</Badge><Badge tone="teal">SSG 3.0</Badge><Badge>PHYSICS</Badge>
            </div>
          </AbsoluteFill>
        </VerticalScene>
      </Sequence>
      <Sequence from={135} durationInFrames={210} premountFor={30}>
        <VerticalScene duration={210} dark>
          <div style={{ position: "absolute", left: 48, top: 100, right: 48 }}>
            <Kicker color={theme.cyan}>ONE SHARED WORKSPACE</Kicker>
            <Title dark style={{ fontSize: 70, marginTop: 16 }}>Live data.<br />Typed action.<br />Real 3D state.</Title>
          </div>
          <div style={{ position: "absolute", left: 44, top: 600, width: 992, height: 558, overflow: "hidden", borderRadius: 26, border: "1px solid rgba(255,255,255,.2)", boxShadow: "0 28px 80px rgba(0,0,0,.38)" }}>
            <Img src={staticFile(`captures/interaction-frames/frame-${String(motionFrame).padStart(4, "0")}.jpg`)} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
          </div>
          <div style={{ position: "absolute", left: 56, bottom: 160, color: "#C9D4DF", fontFamily: sans, fontSize: 28, lineHeight: 1.45 }}>
            2D button → event route → 3D animation
          </div>
        </VerticalScene>
      </Sequence>
      <Sequence from={330} durationInFrames={150} premountFor={30}>
        <VerticalScene duration={150} dark>
          <div style={{ position: "absolute", left: 48, top: 110, right: 48 }}>
            <Kicker color={theme.cyan}>BOUNDED PHYSICS PREFLIGHT</Kicker>
            <Title dark style={{ fontSize: 72, marginTop: 16 }}>Detect. Simulate. Correct.</Title>
          </div>
          <div style={{ position: "absolute", left: 44, top: 560, width: 992, height: 558, overflow: "hidden", borderRadius: 26 }}>
            <Img src={staticFile("captures/05-workspace-before-fix.png")} style={{ width: "100%", height: "100%", objectFit: "contain", opacity: 1 - physicsAfter }} />
            <Img src={staticFile("captures/06-workspace-after-fix.png")} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", opacity: physicsAfter }} />
          </div>
          <div style={{ position: "absolute", left: 54, bottom: 185, display: "flex", gap: 12 }}>
            <Badge tone={physicsAfter < 0.5 ? "orange" : "teal"}>{physicsAfter < 0.5 ? "UNSUPPORTED" : "FEASIBLE"}</Badge>
            <Badge tone="paper">READ-ONLY PREVIEW</Badge>
          </div>
        </VerticalScene>
      </Sequence>
      <Sequence from={465} durationInFrames={75} premountFor={30}>
        <VerticalScene duration={75}>
          <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", textAlign: "center", padding: 74 }}>
            <Wordmark compact />
            <Title style={{ fontSize: 64, marginTop: 58 }}>Build spaces agents can understand.</Title>
            <div style={{ color: theme.muted, fontFamily: sans, fontSize: 25, marginTop: 30 }}>github.com/riseagain1/semaframe</div>
          </AbsoluteFill>
        </VerticalScene>
      </Sequence>
    </AbsoluteFill>
  );
};
