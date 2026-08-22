import { Audio } from "@remotion/media";
import type { CSSProperties, ReactNode } from "react";
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
  Title,
  Wordmark,
} from "./components";
import { mono, sans, theme } from "./theme";

const REALITY_OPS_ROOT = "realityops";

// scripts/realityops-demo-capture.mjs writes exactly 48 JPEGs per phase.
// Keeping the count explicit makes every Remotion frame deterministic and
// prevents the edit from depending on directory enumeration at render time.
const CAPTURED_FRAME_COUNT = 48;

const capture = (name: string) => `${REALITY_OPS_ROOT}/${name}`;

type Tone = "ink" | "orange" | "teal" | "paper";

type ProofChip = {
  label: string;
  tone?: Tone;
};

const FadeUp = ({
  children,
  delay = 0,
  style,
}: {
  children: ReactNode;
  delay?: number;
  style?: CSSProperties;
}) => {
  const frame = useCurrentFrame();
  const progress = spring({
    frame,
    fps: 30,
    delay,
    durationInFrames: 34,
    config: { damping: 200 },
  });
  return (
    <div
      style={{
        opacity: progress,
        transform: `translateY(${(1 - progress) * 24}px)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

const ProofChips = ({ chips, inverse = false }: { chips: ProofChip[]; inverse?: boolean }) => (
  <div
    style={{
      display: "flex",
      justifyContent: "flex-end",
      alignItems: "center",
      gap: 12,
      flexWrap: "wrap",
      maxWidth: 760,
    }}
  >
    {chips.map((chip) => (
      <div style={{ whiteSpace: "nowrap" }} key={chip.label}>
        <Badge tone={chip.tone ?? (inverse ? "paper" : "ink")}>{chip.label}</Badge>
      </div>
    ))}
  </div>
);

const CaptureViewport = ({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) => {
  const frame = useCurrentFrame();
  const entrance = spring({
    frame,
    fps: 30,
    durationInFrames: 36,
    config: { damping: 200 },
  });
  return (
    <div
      style={{
        position: "absolute",
        left: 240,
        top: 218,
        width: 1440,
        height: 810,
        overflow: "hidden",
        borderRadius: 24,
        border: "1px solid rgba(255,255,255,.2)",
        background: theme.night,
        boxShadow: "0 34px 90px rgba(0,0,0,.34)",
        opacity: entrance,
        transform: `translateY(${(1 - entrance) * 18}px)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

const CaptureImage = ({ src, style }: { src: string; style?: CSSProperties }) => (
  <Img
    src={staticFile(capture(src))}
    style={{ width: "100%", height: "100%", objectFit: "contain", ...style }}
  />
);

const CapturedSequence = ({
  folder,
  duration,
  holdIn = 20,
  holdOut = 20,
  style,
}: {
  folder: "build-frames" | "correction-frames" | "control-frames" | "undo-redo-frames";
  duration: number;
  holdIn?: number;
  holdOut?: number;
  style?: CSSProperties;
}) => {
  const frame = useCurrentFrame();
  const lastMotionFrame = Math.max(holdIn + 1, duration - holdOut);
  const source = Math.max(
    0,
    Math.min(
      CAPTURED_FRAME_COUNT - 1,
      Math.floor(
        interpolate(frame, [holdIn, lastMotionFrame], [0, CAPTURED_FRAME_COUNT - 1], clamp),
      ),
    ),
  );
  return (
    <Img
      src={staticFile(
        capture(`${folder}/frame-${String(source).padStart(4, "0")}.jpg`),
      )}
      style={{ width: "100%", height: "100%", objectFit: "contain", ...style }}
    />
  );
};

const CaptureScene = ({
  duration,
  step,
  title,
  chips,
  children,
  dark = true,
  scope,
}: {
  duration: number;
  step: string;
  title: ReactNode;
  chips: ProofChip[];
  children: ReactNode;
  dark?: boolean;
  scope?: string;
}) => (
  <SceneFade duration={duration}>
    <PaperBackground dark={dark} />
    <AbsoluteFill style={{ padding: "66px 92px" }}>
      <div style={{ position: "absolute", left: 92, top: 66, maxWidth: 1050 }}>
        <Kicker color={dark ? theme.cyan : theme.orange}>{step}</Kicker>
        <Title dark={dark} style={{ fontSize: 56, lineHeight: 1, marginTop: 10 }}>
          {title}
        </Title>
      </div>
      <div style={{ position: "absolute", right: 92, top: 92 }}>
        <ProofChips chips={chips} inverse={dark} />
      </div>
      {children}
      {scope ? (
        <div
          style={{
            position: "absolute",
            right: 100,
            bottom: 24,
            color: dark ? "#AEBBC8" : theme.muted,
            fontFamily: sans,
            fontSize: 15,
            fontWeight: 650,
            letterSpacing: 0.4,
          }}
        >
          {scope}
        </div>
      ) : null}
    </AbsoluteFill>
  </SceneFade>
);

const ColdOpen = ({ duration }: { duration: number }) => (
  <SceneFade duration={duration}>
    <PaperBackground dark />
    <AbsoluteFill>
      <div style={{ position: "absolute", left: 96, top: 82 }}>
        <Wordmark inverse compact />
      </div>
      <FadeUp delay={8} style={{ position: "absolute", left: 96, top: 262, width: 430 }}>
        <Kicker color={theme.cyan}>REALITYOPS · EXECUTED DEMO</Kicker>
        <Title dark style={{ fontSize: 68, marginTop: 24 }}>
          No photos.
          <br />
          One executable brief.
        </Title>
        <Body dark style={{ fontSize: 23, marginTop: 30 }}>
          An Agent builds, rejects, corrects and operates one shared world—then exports its published model.
        </Body>
        <div style={{ marginTop: 40, display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Badge tone="orange">PROCEDURAL DEMO</Badge>
          <Badge tone="teal">REAL UI CAPTURE</Badge>
        </div>
      </FadeUp>
      <CaptureViewport style={{ left: 610, top: 154, width: 1230, height: 692 }}>
        <CaptureImage src="10-final.png" />
      </CaptureViewport>
      <div
        style={{
          position: "absolute",
          left: 612,
          top: 876,
          color: "#AEBBC8",
          fontFamily: sans,
          fontSize: 17,
          letterSpacing: 0.7,
        }}
      >
        Synthetic brownfield baseline · no scan or source-photo claim
      </div>
    </AbsoluteFill>
  </SceneFade>
);

const Brief = ({ duration }: { duration: number }) => {
  const frame = useCurrentFrame();
  const line = interpolate(frame, [28, 98], [0, 1], clamp);
  const tasks = [
    "Add a reusable backup pump skid.",
    "Keep the service aisle clear.",
    "Bind telemetry and a 2D control.",
    "Survive save / reopen. Export the pump model as OpenUSD + STEP.",
  ];
  return (
    <SceneFade duration={duration}>
      <PaperBackground />
      <AbsoluteFill style={{ padding: "90px 120px" }}>
        <FadeUp>
          <Kicker>A PHYSICAL PULL REQUEST</Kicker>
          <Title style={{ fontSize: 88, width: 1100, marginTop: 20 }}>
            Review the change before it reaches reality.
          </Title>
        </FadeUp>
        <div
          style={{
            position: "absolute",
            left: 120,
            top: 430,
            width: 1680,
            height: 2,
            background: theme.ink,
            transformOrigin: "left",
            transform: `scaleX(${line})`,
          }}
        />
        <div style={{ position: "absolute", left: 122, top: 500, width: 1500 }}>
          {tasks.map((task, index) => {
            const progress = spring({
              frame,
              fps: 30,
              delay: 42 + index * 15,
              durationInFrames: 30,
              config: { damping: 200 },
            });
            return (
              <div
                key={task}
                style={{
                  opacity: progress,
                  transform: `translateX(${(1 - progress) * 22}px)`,
                  display: "grid",
                  gridTemplateColumns: "56px 1fr",
                  alignItems: "baseline",
                  marginBottom: 24,
                  color: theme.ink,
                  fontFamily: sans,
                  fontSize: 29,
                  fontWeight: 680,
                }}
              >
                <span style={{ color: theme.orange, fontFamily: mono, fontSize: 18 }}>
                  {String(index + 1).padStart(2, "0")}
                </span>
                {task}
              </div>
            );
          })}
        </div>
        <div
          style={{
            position: "absolute",
            right: 120,
            bottom: 86,
            color: theme.muted,
            fontFamily: sans,
            fontSize: 18,
          }}
        >
          Demo scope: spatial decision support, not engineering certification
        </div>
      </AbsoluteFill>
    </SceneFade>
  );
};

const Approval = ({ duration }: { duration: number }) => {
  const frame = useCurrentFrame();
  const approved = interpolate(frame, [58, 82], [0, 1], clamp);
  const ready = interpolate(frame, [116, 140], [0, 1], clamp);
  return (
    <CaptureScene
      duration={duration}
      step="00 · Enter through the gate"
      title="Connected explicitly. Approved explicitly."
      chips={[
        { label: ready < 0.5 ? "BOUNDED CAPABILITIES" : "WORKSPACE READY", tone: ready < 0.5 ? "orange" : "teal" },
      ]}
      scope="Connection URL is not authorization"
    >
      <CaptureViewport>
        <CaptureImage src="00-connection.png" style={{ opacity: 1 - approved }} />
        <CaptureImage
          src="01-approved.png"
          style={{ position: "absolute", inset: 0, opacity: approved * (1 - ready) }}
        />
        <CaptureImage
          src="02-empty.png"
          style={{ position: "absolute", inset: 0, opacity: ready }}
        />
      </CaptureViewport>
    </CaptureScene>
  );
};

const Baseline = ({ duration }: { duration: number }) => (
  <CaptureScene
    duration={duration}
    step="01 · Establish the baseline"
    title="A synthetic room becomes editable state."
    chips={[
      { label: "PROCEDURAL BASELINE", tone: "orange" },
      { label: "HUMAN EDITABLE", tone: "teal" },
    ]}
    scope="Synthetic demo environment · no photogrammetry or scan input"
  >
    <CaptureViewport>
      <CaptureImage src="03-synthetic-baseline.png" />
    </CaptureViewport>
  </CaptureScene>
);

const Build = ({ duration }: { duration: number }) => (
  <CaptureScene
    duration={duration}
    step="02 · Build the reusable machine"
    title="Primitives become a parametric pump skid."
    chips={[
      { label: "MULTIPART MODEL", tone: "orange" },
      { label: "AGENT AUTHORED", tone: "teal" },
    ]}
    scope="Editable assembly geometry · not a certified fabrication drawing"
  >
    <CaptureViewport>
      <CapturedSequence folder="build-frames" duration={duration} holdIn={18} holdOut={24} />
    </CaptureViewport>
  </CaptureScene>
);

const Collision = ({ duration }: { duration: number }) => (
  <CaptureScene
    duration={duration}
    step="03 · Reject the unsafe candidate"
    title="The first plan never lands."
    chips={[
      { label: "COLLISION", tone: "orange" },
      { label: "READ-ONLY PREFLIGHT", tone: "paper" },
    ]}
    scope="Bounded geometric clearance check · not safety certification"
  >
    <CaptureViewport>
      <CaptureImage src="04-collision-preflight.png" />
    </CaptureViewport>
  </CaptureScene>
);

const Correction = ({ duration }: { duration: number }) => (
  <CaptureScene
    duration={duration}
    step="04 · Correct and publish"
    title="The layout changes. The evidence remains."
    chips={[
      { label: "REUSABLE MODEL", tone: "orange" },
      { label: "SOURCE + INSTANCE", tone: "teal" },
    ]}
    scope="Collision-aware placement with revisioned mutations"
  >
    <CaptureViewport>
      <CapturedSequence folder="correction-frames" duration={duration} holdIn={16} holdOut={26} />
    </CaptureViewport>
  </CaptureScene>
);

const Control = ({ duration }: { duration: number }) => (
  <CaptureScene
    duration={duration}
    step="05 · Operate the twin"
    title="A 2D command becomes 3D behavior."
    chips={[
      { label: "TELEMETRY SNAPSHOT", tone: "orange" },
      { label: "TYPED ACTION", tone: "teal" },
    ]}
    scope="Deterministic replay feed used for this reproducible capture"
  >
    <CaptureViewport>
      <CapturedSequence folder="control-frames" duration={duration} holdIn={16} holdOut={24} />
    </CaptureViewport>
  </CaptureScene>
);

const Proof = ({ duration }: { duration: number }) => {
  const frame = useCurrentFrame();
  const proof = [
    ["WORLD", "identity + world bounds"],
    ["CLEARANCE", "collision volumes"],
    ["SUPPORT", "bounded physics preflight"],
    ["RECORD", "revisioned transactions"],
  ];
  return (
    <SceneFade duration={duration}>
      <PaperBackground />
      <AbsoluteFill style={{ padding: "82px 96px" }}>
        <div style={{ width: 610 }}>
          <Kicker>06 · Explain the space</Kicker>
          <Title style={{ fontSize: 72, marginTop: 22 }}>
            Not pixels.
            <br />
            Inspectable structure.
          </Title>
          <Body style={{ fontSize: 24, marginTop: 28, width: 560 }}>
            The Agent reads explicit geometry, relationships, constraints and revisions from the same Workspace.
          </Body>
          <div style={{ marginTop: 34, display: "grid", gap: 12 }}>
            {proof.map(([label, value], index) => {
              const progress = spring({
                frame,
                fps: 30,
                delay: 26 + index * 12,
                durationInFrames: 28,
                config: { damping: 200 },
              });
              return (
                <div
                  key={label}
                  style={{
                    opacity: progress,
                    transform: `translateX(${(1 - progress) * 18}px)`,
                    display: "grid",
                    gridTemplateColumns: "132px 1fr",
                    padding: "13px 16px",
                    borderRadius: 10,
                    background: "rgba(255,255,255,.48)",
                    borderLeft: `4px solid ${index === 1 ? theme.orange : theme.teal}`,
                    color: theme.ink,
                    fontFamily: sans,
                    fontSize: 18,
                  }}
                >
                  <span style={{ fontFamily: mono, fontSize: 15, color: theme.muted }}>{label}</span>
                  <span style={{ fontWeight: 700 }}>{value}</span>
                </div>
              );
            })}
          </div>
        </div>
        <CaptureViewport style={{ left: 778, top: 178, width: 1040, height: 585 }}>
          <CaptureImage src="10-final.png" />
        </CaptureViewport>
        <div
          style={{
            position: "absolute",
            left: 778,
            top: 795,
            width: 1040,
            borderRadius: 16,
            padding: "18px 22px",
            background: theme.panel,
            color: "#BFCBD7",
            fontFamily: mono,
            fontSize: 17,
            lineHeight: 1.55,
            border: "1px solid rgba(104,213,255,.2)",
          }}
        >
          Captured MCP evidence · realityops/evidence.json
          <br />
          Authoritative source · revisioned Workspace state
        </div>
      </AbsoluteFill>
    </SceneFade>
  );
};

const UndoRedo = ({ duration }: { duration: number }) => (
  <CaptureScene
    duration={duration}
    step="07 · Keep humans in the loop"
    title="Undo and redo are visible operations."
    chips={[
      { label: "REVERSIBLE", tone: "orange" },
      { label: "HUMAN EDITABLE", tone: "teal" },
    ]}
    scope="The Agent and human operate on the same revisioned record"
  >
    <CaptureViewport>
      <CapturedSequence folder="undo-redo-frames" duration={duration} holdIn={10} holdOut={14} />
    </CaptureViewport>
  </CaptureScene>
);

const Persistence = ({ duration }: { duration: number }) => {
  const frame = useCurrentFrame();
  const reopened = interpolate(frame, [82, 112], [0, 1], clamp);
  return (
    <CaptureScene
      duration={duration}
      step="08 · Save, close, reopen"
      title="The world returns intact."
      chips={[
        { label: reopened < 0.5 ? "REVISION HISTORY" : "REOPENED", tone: reopened < 0.5 ? "orange" : "teal" },
        { label: "SAME EDITABLE STATE", tone: "paper" },
      ]}
      scope="Persistence verified through a real save and reopen flow"
    >
      <CaptureViewport>
        <CaptureImage src="07-history.png" style={{ opacity: 1 - reopened }} />
        <CaptureImage
          src="08-reopened.png"
          style={{ position: "absolute", inset: 0, opacity: reopened }}
        />
      </CaptureViewport>
    </CaptureScene>
  );
};

const Export = ({ duration }: { duration: number }) => (
  <CaptureScene
    duration={duration}
    step="09 · Leave the workspace"
    title="One model. Two production handoffs."
    chips={[
      { label: "OPENUSD", tone: "orange" },
      { label: "STEP", tone: "teal" },
      { label: "VALIDATED", tone: "paper" },
    ]}
    scope="Published pump model: OpenUSD USDA + STEP, validated by the capture workflow"
  >
    <CaptureViewport>
      <CaptureImage src="09-model-exports.png" />
    </CaptureViewport>
  </CaptureScene>
);

const Outro = ({ duration }: { duration: number }) => (
  <SceneFade duration={duration}>
    <PaperBackground dark />
    <AbsoluteFill>
      <div style={{ position: "absolute", left: 96, top: 92 }}>
        <Wordmark inverse compact />
      </div>
      <FadeUp delay={6} style={{ position: "absolute", left: 96, top: 300, width: 455 }}>
        <Kicker color={theme.cyan}>A PHYSICAL PULL REQUEST</Kicker>
        <Title dark style={{ fontSize: 70, marginTop: 22 }}>
          Review changes before they reach reality.
        </Title>
        <Body dark style={{ fontSize: 23, marginTop: 30 }}>
          Editable. Replayable. Exportable.
        </Body>
        <div style={{ color: "#AEBBC8", fontFamily: sans, fontSize: 19, marginTop: 54 }}>
          Open source · github.com/riseagain1/semaframe
        </div>
      </FadeUp>
      <CaptureViewport style={{ left: 610, top: 154, width: 1230, height: 692 }}>
        <CaptureImage src="10-final.png" />
      </CaptureViewport>
      <div
        style={{
          position: "absolute",
          left: 610,
          top: 876,
          display: "flex",
          gap: 12,
        }}
      >
        <Badge tone="orange">MODEL</Badge>
        <Badge tone="teal">OPERATE</Badge>
        <Badge tone="paper">PROVE</Badge>
      </div>
    </AbsoluteFill>
  </SceneFade>
);

const scene = (from: number, durationInFrames: number, component: ReactNode) => (
  <Sequence from={from} durationInFrames={durationInFrames} premountFor={30}>
    {component}
  </Sequence>
);

export const SemaFrameRealityOps = () => {
  const { fps, durationInFrames } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: theme.night }}>
      <Audio
        src={staticFile("audio/semaframe-original-bed.wav")}
        volume={(frame) =>
          interpolate(
            frame,
            [0, 2 * fps, durationInFrames - 3 * fps, durationInFrames],
            [0, 0.88, 0.88, 0],
            clamp,
          )
        }
      />
      {scene(0, 135, <ColdOpen duration={135} />)}
      {scene(120, 180, <Brief duration={180} />)}
      {scene(285, 180, <Approval duration={180} />)}
      {scene(450, 210, <Baseline duration={210} />)}
      {scene(645, 255, <Build duration={255} />)}
      {scene(885, 195, <Collision duration={195} />)}
      {scene(1065, 240, <Correction duration={240} />)}
      {scene(1290, 285, <Control duration={285} />)}
      {scene(1560, 180, <Proof duration={180} />)}
      {scene(1725, 165, <UndoRedo duration={165} />)}
      {scene(1875, 165, <Persistence duration={165} />)}
      {scene(2025, 180, <Export duration={180} />)}
      {scene(2190, 150, <Outro duration={150} />)}
    </AbsoluteFill>
  );
};

export const SemaFrameRealityOpsPoster = () => (
  <AbsoluteFill style={{ background: theme.night }}>
    <PaperBackground dark />
    <AbsoluteFill>
      <div style={{ position: "absolute", left: 94, top: 86 }}>
        <Wordmark inverse compact />
      </div>
      <div style={{ position: "absolute", left: 94, top: 286, width: 500 }}>
        <Kicker color={theme.cyan}>REALITYOPS · EXECUTED DEMO</Kicker>
        <Title dark style={{ fontSize: 74, marginTop: 24 }}>
          A Physical Pull Request.
        </Title>
        <Body dark style={{ fontSize: 24, marginTop: 30 }}>
          Review changes before they reach reality.
        </Body>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 42 }}>
          <Badge tone="orange">MODEL</Badge>
          <Badge tone="teal">OPERATE</Badge>
          <Badge tone="paper">PROVE</Badge>
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 640,
          top: 146,
          width: 1190,
          height: 669,
          overflow: "hidden",
          borderRadius: 24,
          border: "1px solid rgba(255,255,255,.2)",
          boxShadow: "0 34px 90px rgba(0,0,0,.4)",
        }}
      >
        <CaptureImage src="10-final.png" />
      </div>
      <div
        style={{
          position: "absolute",
          left: 640,
          top: 850,
          color: "#AEBBC8",
          fontFamily: sans,
          fontSize: 17,
        }}
      >
        Procedural baseline · real SemaFrame UI · validated export workflow
      </div>
    </AbsoluteFill>
  </AbsoluteFill>
);
