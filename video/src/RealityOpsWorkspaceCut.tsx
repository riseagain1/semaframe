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
import { mono, sans } from "./theme";

const ROOT = "realityops";
const CAPTURED_FRAME_COUNT = 48;
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

type MotionFolder =
  | "immersive-room-frames"
  | "immersive-build-frames"
  | "immersive-collision-frames"
  | "immersive-correction-frames"
  | "immersive-control-frames"
  | "immersive-undo-redo-frames"
  | "immersive-final-frames";

type CueTone = "warning" | "success" | "cyan";

type ProcessSceneProps = Readonly<{
  duration: number;
  label: string;
  children: ReactNode;
  proof?: string;
  proofAt?: number;
  proofTone?: CueTone;
  proofSide?: "left" | "right";
  footnote?: string;
}>;

const capture = (path: string) => staticFile(`${ROOT}/${path}`);

const captureFrame = (folder: MotionFolder, frame: number) =>
  capture(`${folder}/frame-${String(frame).padStart(4, "0")}.jpg`);

const StillCapture = ({ name }: { name: string }) => (
  <Img
    src={capture(name)}
    style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
  />
);

const MotionCapture = ({ folder, duration }: { folder: MotionFolder; duration: number }) => {
  const frame = useCurrentFrame();
  const sourceFrame = Math.floor(
    interpolate(frame, [0, Math.max(1, duration - 1)], [0, CAPTURED_FRAME_COUNT - 1], clamp),
  );

  return (
    <Img
      src={captureFrame(folder, sourceFrame)}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
    />
  );
};

const OperationLabel = ({ duration, text }: { duration: number; text: string }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, durationInFrames: 15, config: { damping: 200 } });
  const exitStart = Math.min(54, Math.max(18, duration - 12));
  const exit = interpolate(frame, [exitStart, Math.min(duration - 1, exitStart + 10)], [1, 0], clamp);

  return (
    <div
      style={{
        position: "absolute",
        left: 24,
        top: 142,
        display: "inline-flex",
        alignItems: "center",
        gap: 9,
        maxWidth: 560,
        padding: "8px 12px",
        borderRadius: 8,
        background: "rgba(7,13,18,.72)",
        outline: "1px solid rgba(255,255,255,.14)",
        boxShadow: "0 8px 24px rgba(0,0,0,.2)",
        color: "#F4F8FB",
        fontFamily: sans,
        fontSize: 16,
        fontWeight: 720,
        letterSpacing: 0.1,
        opacity: enter * exit,
        transform: `translateY(${(1 - enter) * 7}px)`,
      }}
    >
      <span style={{ width: 3, height: 17, borderRadius: 2, background: "#68D5FF" }} />
      {text}
    </div>
  );
};

const ProofCue = ({
  duration,
  text,
  showAt,
  tone = "cyan",
  side = "right",
}: {
  duration: number;
  text: string;
  showAt: number;
  tone?: CueTone;
  side?: "left" | "right";
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, delay: showAt, durationInFrames: 16, config: { damping: 200 } });
  const exit = interpolate(frame, [Math.max(showAt + 18, duration - 12), duration - 2], [1, 0], clamp);
  const colors: Record<CueTone, { dot: string; outline: string }> = {
    warning: { dot: "#FF926A", outline: "rgba(255,146,106,.4)" },
    success: { dot: "#91E4B0", outline: "rgba(145,228,176,.36)" },
    cyan: { dot: "#68D5FF", outline: "rgba(104,213,255,.38)" },
  };
  const color = colors[tone];

  return (
    <div
      style={{
        position: "absolute",
        ...(side === "left" ? { left: 24 } : { right: 24 }),
        bottom: 78,
        display: "flex",
        alignItems: "center",
        gap: 8,
        maxWidth: 590,
        padding: "8px 11px",
        borderRadius: 999,
        background: "rgba(7,13,18,.76)",
        outline: `1px solid ${color.outline}`,
        color: "#F4F8FB",
        fontFamily: mono,
        fontSize: 14,
        fontWeight: 750,
        opacity: enter * exit,
        transform: `translateY(${(1 - enter) * 6}px)`,
      }}
    >
      <span style={{ width: 7, height: 7, flex: "0 0 auto", borderRadius: "50%", background: color.dot }} />
      {text}
    </div>
  );
};

const ProcessScene = ({
  duration,
  label,
  children,
  proof,
  proofAt = 0,
  proofTone,
  proofSide,
  footnote,
}: ProcessSceneProps) => (
  <AbsoluteFill style={{ overflow: "hidden", background: "#091018" }}>
    {children}
    <OperationLabel duration={duration} text={label} />
    {proof ? (
      <ProofCue duration={duration} text={proof} showAt={proofAt} tone={proofTone} side={proofSide} />
    ) : null}
    {footnote ? (
      <div
        style={{
          position: "absolute",
          left: "50%",
          bottom: 17,
          transform: "translateX(-50%)",
          color: "rgba(233,240,245,.72)",
          fontFamily: sans,
          fontSize: 11,
          fontWeight: 650,
          letterSpacing: 0.2,
          textShadow: "0 2px 7px rgba(0,0,0,.9)",
          whiteSpace: "nowrap",
        }}
      >
        {footnote}
      </div>
    ) : null}
  </AbsoluteFill>
);

const Intro = ({ duration }: { duration: number }) => (
  <ProcessScene duration={duration} label="SemaFrame RealityOps · 真实工作区流程记录">
    <StillCapture name="immersive-room-frames/frame-0000.jpg" />
  </ProcessScene>
);

const Room = ({ duration }: { duration: number }) => (
  <ProcessScene duration={duration} label="Baseline · 合成泵房场景（非照片或扫描）">
    <MotionCapture folder="immersive-room-frames" duration={duration} />
  </ProcessScene>
);

const Build = ({ duration }: { duration: number }) => (
  <ProcessScene duration={duration} label="Agent · 构建泵房与可复用泵组">
    <MotionCapture folder="immersive-build-frames" duration={duration} />
  </ProcessScene>
);

const Collision = ({ duration }: { duration: number }) => (
  <ProcessScene
    duration={duration}
    label="Preflight · 检查备用泵位置"
    proof="REJECTED · protected aisle collision · no commit"
    proofAt={150}
    proofTone="warning"
    footnote="Bounded geometric preflight · not engineering certification"
  >
    <MotionCapture folder="immersive-collision-frames" duration={duration} />
  </ProcessScene>
);

const Correction = ({ duration }: { duration: number }) => (
  <ProcessScene
    duration={duration}
    label="Agent · 移动实例并重新验证"
    proof="0 conflicts · Physics 2.0 feasible"
    proofAt={170}
    proofTone="success"
    footnote="Bounded geometric and quasi-static preflight · not certification"
  >
    <MotionCapture folder="immersive-correction-frames" duration={duration} />
  </ProcessScene>
);

const Control = ({ duration }: { duration: number }) => (
  <ProcessScene duration={duration} label="Operate · 遥测快照与 2D → 3D 动作">
    <MotionCapture folder="immersive-control-frames" duration={duration} />
  </ProcessScene>
);

const UndoRedo = ({ duration }: { duration: number }) => (
  <ProcessScene duration={duration} label="Human · Undo 移除实例，Redo 恢复">
    <MotionCapture folder="immersive-undo-redo-frames" duration={duration} />
  </ProcessScene>
);

const History = ({ duration }: { duration: number }) => (
  <ProcessScene duration={duration} label="Save · 工作区与历史一并保存">
    <StillCapture name="07-history.png" />
  </ProcessScene>
);

const Reopen = ({ duration }: { duration: number }) => (
  <ProcessScene duration={duration} label="Reopen · 保存状态完整恢复">
    <StillCapture name="08-reopened.png" />
  </ProcessScene>
);

const Export = ({ duration }: { duration: number }) => (
  <ProcessScene
    duration={duration}
    label="Export · OpenUSD + STEP"
    proof="VALIDATED · USDA 12.3 KB · AP242 STEP 101.7 KB"
    proofAt={3}
    proofTone="success"
    proofSide="left"
  >
    <StillCapture name="09-model-exports.png" />
  </ProcessScene>
);

const Final = ({ duration }: { duration: number }) => (
  <ProcessScene duration={duration} label="Review · 让物理变更先成为可审查的 Pull Request">
    <MotionCapture folder="immersive-final-frames" duration={duration} />
  </ProcessScene>
);

const segments = [
  { duration: 42, component: Intro },
  { duration: 180, component: Room },
  { duration: 330, component: Build },
  { duration: 210, component: Collision },
  { duration: 240, component: Correction },
  { duration: 300, component: Control },
  { duration: 150, component: UndoRedo },
  { duration: 36, component: History },
  { duration: 36, component: Reopen },
  { duration: 36, component: Export },
  { duration: 90, component: Final },
] as const;

export const REALITY_OPS_WORKSPACE_DURATION = segments.reduce((total, segment) => total + segment.duration, 0);

const timeline = segments.reduce<Array<(typeof segments)[number] & { from: number }>>((result, segment) => {
  const previous = result.at(-1);
  result.push({ ...segment, from: previous ? previous.from + previous.duration : 0 });
  return result;
}, []);

export const SemaFrameRealityOpsWorkspace = () => {
  const { fps, durationInFrames } = useVideoConfig();

  return (
    <AbsoluteFill style={{ background: "#091018" }}>
      <Audio
        src={staticFile("audio/semaframe-original-bed.wav")}
        volume={(frame) =>
          interpolate(
            frame,
            [0, 2 * fps, durationInFrames - 3 * fps, durationInFrames],
            [0, 0.78, 0.78, 0],
            clamp,
          )
        }
      />
      {timeline.map(({ from, duration, component: Scene }) => (
        <Sequence key={from} from={from} durationInFrames={duration} premountFor={30}>
          <Scene duration={duration} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
