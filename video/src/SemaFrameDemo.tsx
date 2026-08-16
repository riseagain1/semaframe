import { Audio } from "@remotion/media";
import type { ReactNode } from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  Badge,
  Body,
  clamp,
  Kicker,
  PaperBackground,
  SceneFade,
  ScreenshotFrame,
  Title,
  Wordmark,
} from "./components";
import { mono, sans, serif, theme } from "./theme";

const Intro = ({ duration }: { duration: number }) => {
  const frame = useCurrentFrame();
  const mark = spring({ frame, fps: 30, durationInFrames: 42, config: { damping: 200 } });
  const line = interpolate(frame, [28, 92], [0, 1], clamp);
  return (
    <SceneFade duration={duration}>
      <PaperBackground />
      <AbsoluteFill style={{ padding: "110px 130px", justifyContent: "center" }}>
        <div style={{ opacity: mark, transform: `translateY(${(1 - mark) * 28}px)` }}>
          <Wordmark />
        </div>
        <div style={{ width: 850, height: 2, margin: "60px 0 42px", background: theme.ink, transformOrigin: "left", transform: `scaleX(${line})` }} />
        <Title style={{ maxWidth: 1160, fontSize: 94 }}>A semantic spatial workspace<br />for AI agents.</Title>
        <div style={{ display: "flex", gap: 14, marginTop: 54 }}>
          <Badge>2D + 3D</Badge>
          <Badge tone="orange">LIVE DATA</Badge>
          <Badge tone="teal">AGENT MCP</Badge>
          <Badge tone="paper">COLLISION + PHYSICS</Badge>
        </div>
      </AbsoluteFill>
    </SceneFade>
  );
};

const Thesis = ({ duration }: { duration: number }) => {
  const frame = useCurrentFrame();
  const progress = spring({ frame, fps: 30, durationInFrames: 48, config: { damping: 200 } });
  const nodes = [
    { x: 1280, y: 280, color: theme.orange },
    { x: 1520, y: 510, color: theme.teal },
    { x: 1180, y: 720, color: theme.cyan },
  ];
  return (
    <SceneFade duration={duration}>
      <PaperBackground dark />
      <AbsoluteFill style={{ padding: "120px 140px", justifyContent: "center" }}>
        <Kicker color={theme.cyan}>Agents need more than pixels</Kicker>
        <Title dark style={{ width: 1050, fontSize: 104, marginTop: 24 }}>
          They need a world<br />they can inspect.
        </Title>
        <Body dark style={{ width: 820, marginTop: 42 }}>
          Geometry, identity, data, behavior and constraints—bound to the same revisioned state.
        </Body>
        <svg width="1920" height="1080" viewBox="0 0 1920 1080" style={{ position: "absolute", inset: 0, pointerEvents: "none", opacity: progress }}>
          <path d="M1280 280 L1520 510 L1180 720 Z" fill="none" stroke="rgba(104,213,255,.28)" strokeWidth="3" strokeDasharray="14 12" />
        </svg>
        {nodes.map((node, index) => (
          <div key={node.x} style={{ position: "absolute", left: node.x, top: node.y, width: 34, height: 34, borderRadius: "50%", background: node.color, boxShadow: `0 0 0 ${18 + index * 4}px ${node.color}20`, transform: `scale(${progress})` }} />
        ))}
      </AbsoluteFill>
    </SceneFade>
  );
};

const Connection = ({ duration }: { duration: number }) => (
  <SceneFade duration={duration}>
    <PaperBackground />
    <AbsoluteFill style={{ padding: "86px 108px" }}>
      <div style={{ width: 560, paddingTop: 118 }}>
        <Kicker>01 · Connect</Kicker>
        <Title style={{ fontSize: 76, marginTop: 24 }}>The browser stays in charge.</Title>
        <Body style={{ marginTop: 32 }}>A short-lived URL starts the handshake. It does not contain authority.</Body>
        <div style={{ display: "flex", gap: 12, marginTop: 40, flexWrap: "wrap" }}>
          <Badge tone="teal">LOCAL GATEWAY</Badge>
          <Badge tone="paper">NO HIDDEN WORKSPACE</Badge>
        </div>
        <div style={{ marginTop: 28, color: theme.ink, fontFamily: sans, fontSize: 18, fontWeight: 750 }}>
          Connection URL ≠ authorization
        </div>
      </div>
      <ScreenshotFrame src="captures/02-connection-url.png" style={{ left: 658, top: 100, width: 1152, height: 648 }} imageStyle={{ objectPosition: "center" }} />
    </AbsoluteFill>
  </SceneFade>
);

const Approval = ({ duration }: { duration: number }) => (
  <SceneFade duration={duration}>
    <PaperBackground />
    <AbsoluteFill style={{ padding: "78px 110px" }}>
      <div style={{ position: "absolute", left: 112, top: 95, zIndex: 2 }}>
        <Kicker>02 · Approve capabilities</Kicker>
        <Title style={{ fontSize: 72, width: 650, marginTop: 18 }}>Identity and scopes are visible.</Title>
      </div>
      <div style={{ position: "absolute", right: 112, top: 142, display: "flex", gap: 12 }}>
        <Badge tone="teal">NAMED CLIENT + FINGERPRINT</Badge>
        <Badge tone="orange">EXPLICIT, BOUNDED SCOPES</Badge>
      </div>
      <ScreenshotFrame src="captures/03-agent-approval.png" style={{ left: 280, top: 290, width: 1360, height: 765 }} />
    </AbsoluteFill>
  </SceneFade>
);

const Build = ({ duration }: { duration: number }) => {
  const frame = useCurrentFrame();
  const reveal = interpolate(frame, [42, 88], [0, 1], clamp);
  return (
    <SceneFade duration={duration}>
      <PaperBackground dark />
      <AbsoluteFill>
        <div style={{ position: "absolute", left: 92, top: 150, width: 535 }}>
          <Kicker color={theme.cyan}>03 · Build atomically</Kicker>
          <Title dark style={{ fontSize: 72, marginTop: 24 }}>One transaction.<br />One shared state.</Title>
          <Body dark style={{ width: 520, marginTop: 34 }}>The Agent creates a 3D room, physical objects, a bound chart and a 2D control.</Body>
          <div style={{ display: "grid", gap: 13, marginTop: 40, width: 500 }}>
            {["stage-3d + spatial entities", "snapshot → chart bindings", "button.pressed → animation"].map((text, index) => (
              <div key={text} style={{ color: "#E7EDF4", fontFamily: mono, fontSize: 18, padding: "13px 16px", borderRadius: 10, background: "rgba(17,24,33,.82)", borderLeft: `4px solid ${index === 1 ? theme.orange : theme.teal}` }}>{text}</div>
            ))}
          </div>
        </div>
        <div style={{ position: "absolute", left: 692, top: 176, width: 1136, height: 639, overflow: "hidden", borderRadius: 24, border: "1px solid rgba(255,255,255,.18)", background: theme.night, boxShadow: "0 34px 90px rgba(0,0,0,.4)" }}>
          <Img src={staticFile("captures/04-empty-workspace.png")} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", opacity: 1 - reveal }} />
          <Img src={staticFile("captures/05-workspace-before-fix.png")} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", opacity: reveal }} />
        </div>
      </AbsoluteFill>
    </SceneFade>
  );
};

const Interaction = ({ duration }: { duration: number }) => {
  const frame = useCurrentFrame();
  const source = Math.max(0, Math.min(47, Math.floor(interpolate(frame, [40, 210], [0, 47], clamp))));
  return (
    <SceneFade duration={duration}>
      <PaperBackground dark />
      <AbsoluteFill style={{ padding: "76px 96px" }}>
        <div style={{ position: "absolute", left: 98, top: 68, zIndex: 3 }}>
          <Kicker color={theme.cyan}>04 · Connect data and action</Kicker>
          <Title dark style={{ fontSize: 62, marginTop: 12 }}>2D controls drive 3D behavior.</Title>
        </div>
        <div style={{ position: "absolute", right: 96, top: 110, display: "flex", gap: 12 }}>
          <Badge tone="orange">LIVE SNAPSHOT</Badge>
          <Badge tone="teal">TYPED EVENT ROUTING</Badge>
        </div>
        <div style={{ position: "absolute", left: 208, top: 210, width: 1504, height: 846, overflow: "hidden", borderRadius: 24, border: "1px solid rgba(255,255,255,.18)", boxShadow: "0 34px 90px rgba(0,0,0,.4)" }}>
          <Img src={staticFile(`captures/interaction-frames/frame-${String(source).padStart(4, "0")}.jpg`)} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
        </div>
      </AbsoluteFill>
    </SceneFade>
  );
};

const USDScene = ({ duration }: { duration: number }) => {
  const frame = useCurrentFrame();
  const lines = [
    ["format", '"universal-space-data"'],
    ["version", '"2.0"'],
    ["prim_path", '"/World/CMP_000005"'],
    ["world_bounds", "{ min, max, center, size }"],
    ["collision", '{ enabled: true, shape: "box" }'],
  ];
  return (
    <SceneFade duration={duration}>
      <PaperBackground />
      <AbsoluteFill style={{ padding: "92px 110px" }}>
        <div style={{ width: 720 }}>
          <Kicker>05 · Understand space</Kicker>
          <Title style={{ fontSize: 82, marginTop: 20 }}>Universal Space Data 2.0</Title>
          <Body style={{ marginTop: 32 }}>Revision-bound identity, transforms, world bounds, colliders and spatial relations—not a screenshot guess.</Body>
          <div style={{ display: "flex", gap: 12, marginTop: 40 }}>
            <Badge tone="ink">REVISION 2</Badge>
            <Badge tone="teal">4 SPATIAL NODES</Badge>
          </div>
        </div>
        <div style={{ position: "absolute", left: 920, top: 132, width: 870, height: 765, borderRadius: 24, padding: "38px 42px", background: theme.panel, boxShadow: "0 30px 80px rgba(12,18,24,.24)", border: "1px solid rgba(104,213,255,.2)" }}>
          <div style={{ color: "#8493A5", fontFamily: sans, fontSize: 16, letterSpacing: 2, marginBottom: 30 }}>ACTUAL MCP RESPONSE · inspect_workspace_space</div>
          <div style={{ color: "#DCE7F0", fontFamily: mono, fontSize: 22, lineHeight: 1.8 }}>
            <span style={{ color: theme.cyan }}>{`{`}</span>
            {lines.map(([key, value], index) => {
              const progress = spring({ frame, fps: 30, delay: 18 + index * 12, durationInFrames: 28, config: { damping: 200 } });
              return (
                <div key={key} style={{ opacity: progress, transform: `translateX(${(1 - progress) * 18}px)`, paddingLeft: 28 }}>
                  <span style={{ color: "#92D3BE" }}>{key}</span>: <span style={{ color: index < 3 ? "#F4B18F" : "#D8E0E9" }}>{value}</span>{index < lines.length - 1 ? "," : ""}
                </div>
              );
            })}
            <span style={{ color: theme.cyan }}>{`}`}</span>
          </div>
          <div style={{ position: "absolute", left: 42, right: 42, bottom: 38, paddingTop: 24, borderTop: "1px solid rgba(255,255,255,.12)", color: "#AEBBC8", fontFamily: sans, fontSize: 20 }}>
            Derived JSON · authoritative Workspace remains the source of truth
          </div>
        </div>
      </AbsoluteFill>
    </SceneFade>
  );
};

const Physics = ({ duration }: { duration: number }) => {
  const frame = useCurrentFrame();
  const after = interpolate(frame, [112, 158], [0, 1], clamp);
  return (
    <SceneFade duration={duration}>
      <PaperBackground dark />
      <AbsoluteFill style={{ padding: "76px 92px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
          <div>
            <Kicker color={theme.cyan}>06 · Preflight physics</Kicker>
            <Title dark style={{ fontSize: 68, marginTop: 14 }}>Detect. Simulate. Correct.</Title>
          </div>
          <div style={{ width: 620, textAlign: "right" }}>
            <Body dark style={{ fontSize: 21 }}>Bounded quasi-static preflight—not structural certification.</Body>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 18 }}>
              <Badge tone={after < 0.5 ? "orange" : "teal"}>{after < 0.5 ? "UNSUPPORTED BODY" : "FEASIBLE"}</Badge>
              <Badge tone="paper">{after < 0.5 ? "GROUNDED: FALSE" : "GROUNDED: TRUE"}</Badge>
            </div>
          </div>
        </div>
        <div style={{ position: "absolute", left: 208, top: 214, width: 1504, height: 846, overflow: "hidden", borderRadius: 24, border: "1px solid rgba(255,255,255,.18)" }}>
          <Img src={staticFile("captures/05-workspace-before-fix.png")} style={{ width: "100%", height: "100%", objectFit: "contain", opacity: 1 - after }} />
          <Img src={staticFile("captures/06-workspace-after-fix.png")} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", opacity: after }} />
        </div>
      </AbsoluteFill>
    </SceneFade>
  );
};

const Inspector = ({ duration }: { duration: number }) => (
  <SceneFade duration={duration}>
    <PaperBackground />
    <AbsoluteFill style={{ padding: "72px 92px" }}>
      <div style={{ position: "absolute", left: 92, top: 70, width: 850 }}>
        <Kicker>Explicit attributes</Kicker>
        <Title style={{ fontSize: 56, marginTop: 12 }}>Collision and physics are optional.</Title>
      </div>
      <div style={{ position: "absolute", right: 92, top: 88, width: 720, textAlign: "right" }}>
        <Body style={{ fontSize: 21 }}>Turn them on for feasibility checks—or off when spatial semantics are enough.</Body>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 18 }}>
          <Badge tone="teal">SOLID</Badge><Badge tone="orange">TRIGGER</Badge><Badge tone="paper">DISABLED</Badge>
        </div>
      </div>
      <ScreenshotFrame src="captures/07-collision-physics-inspector.png" style={{ left: 240, top: 242, width: 1440, height: 810 }} />
    </AbsoluteFill>
  </SceneFade>
);

const History = ({ duration }: { duration: number }) => (
  <SceneFade duration={duration}>
    <PaperBackground />
    <AbsoluteFill style={{ padding: "70px 90px" }}>
      <div style={{ position: "absolute", left: 92, top: 66, width: 1000 }}>
        <Kicker>07 · Keep the record</Kicker>
        <Title style={{ fontSize: 58, marginTop: 12 }}>Deterministic history. Undo. Replay.</Title>
      </div>
      <div style={{ position: "absolute", right: 92, top: 112, display: "flex", gap: 12 }}>
        <Badge tone="teal">ONE REVISIONED RECORD</Badge><Badge tone="paper">REVERSIBLE</Badge>
      </div>
      <ScreenshotFrame src="captures/09-deterministic-history.png" style={{ left: 240, top: 232, width: 1440, height: 810 }} />
    </AbsoluteFill>
  </SceneFade>
);

const Outro = ({ duration }: { duration: number }) => {
  const frame = useCurrentFrame();
  const progress = spring({ frame, fps: 30, durationInFrames: 42, config: { damping: 200 } });
  return (
    <SceneFade duration={duration}>
      <PaperBackground />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", textAlign: "center" }}>
        <div style={{ opacity: progress, transform: `translateY(${(1 - progress) * 24}px)` }}>
          <Wordmark />
          <Title style={{ fontSize: 76, marginTop: 70 }}>Build spaces agents can understand.</Title>
          <Body style={{ marginTop: 28 }}>Open source · github.com/riseagain1/semaframe</Body>
        </div>
      </AbsoluteFill>
    </SceneFade>
  );
};

const scene = (from: number, durationInFrames: number, component: ReactNode) => (
  <Sequence from={from} durationInFrames={durationInFrames} premountFor={30}>
    {component}
  </Sequence>
);

export const SemaFrameDemo = () => {
  const { fps, durationInFrames } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: theme.paper }}>
      <Audio
        src={staticFile("audio/semaframe-original-bed.wav")}
        volume={(frame) => interpolate(frame, [0, 2 * fps, durationInFrames - 3 * fps, durationInFrames], [0, 0.85, 0.85, 0], clamp)}
      />
      {scene(0, 165, <Intro duration={165} />)}
      {scene(150, 165, <Thesis duration={165} />)}
      {scene(300, 225, <Connection duration={225} />)}
      {scene(510, 225, <Approval duration={225} />)}
      {scene(720, 270, <Build duration={270} />)}
      {scene(975, 270, <Interaction duration={270} />)}
      {scene(1230, 270, <USDScene duration={270} />)}
      {scene(1485, 330, <Physics duration={330} />)}
      {scene(1800, 225, <Inspector duration={225} />)}
      {scene(2010, 195, <History duration={195} />)}
      {scene(2190, 150, <Outro duration={150} />)}
    </AbsoluteFill>
  );
};

export const SemaFramePoster = () => (
  <AbsoluteFill style={{ background: theme.paper }}>
    <PaperBackground />
    <AbsoluteFill style={{ padding: "92px 110px" }}>
      <Wordmark />
      <Title style={{ width: 800, fontSize: 88, marginTop: 78 }}>A semantic spatial workspace for AI agents.</Title>
      <div style={{ position: "absolute", right: 84, top: 152, width: 864, height: 486, overflow: "hidden", borderRadius: 24, boxShadow: "0 28px 80px rgba(10,18,24,.28)", border: `1px solid ${theme.line}` }}>
        <Img src={staticFile("captures/06-workspace-after-fix.png")} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
      </div>
      <div style={{ position: "absolute", left: 110, bottom: 100, display: "flex", gap: 14 }}>
        <Badge>2D + 3D</Badge><Badge tone="orange">LIVE DATA</Badge><Badge tone="teal">AGENT MCP</Badge><Badge tone="paper">PHYSICS</Badge>
      </div>
    </AbsoluteFill>
  </AbsoluteFill>
);
