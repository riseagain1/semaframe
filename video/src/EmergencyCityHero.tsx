import { Audio } from "@remotion/media";
import type { ReactNode } from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { mono, sans } from "./theme";

const ROOT = "emergency-city";
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

type CaptureFolder =
  | "crisis-frames"
  | "prompt-frames"
  | "understand-frames"
  | "collision-frames"
  | "plan-frames"
  | "response-frames"
  | "undo-redo-frames"
  | "reopen-frames"
  | "final-frames";

type Tone = "paper" | "danger" | "success" | "cyan";

const folderCounts: Record<CaptureFolder, number> = {
  "crisis-frames": 120,
  "prompt-frames": 60,
  "understand-frames": 90,
  "collision-frames": 120,
  "plan-frames": 90,
  "response-frames": 300,
  "undo-redo-frames": 90,
  "reopen-frames": 90,
  "final-frames": 150,
};

const captureFrame = (folder: CaptureFolder, frame: number) => staticFile(
  `${ROOT}/${folder}/frame-${String(frame).padStart(4, "0")}.jpg`,
);

const MotionCapture = ({
  folder,
  duration,
  fromFrame = 0,
  toFrame = folderCounts[folder] - 1,
  zoomFrom = 1,
  zoomTo = zoomFrom,
  origin = "50% 50%",
}: {
  folder: CaptureFolder;
  duration: number;
  fromFrame?: number;
  toFrame?: number;
  zoomFrom?: number;
  zoomTo?: number;
  origin?: string;
}) => {
  const frame = useCurrentFrame();
  const progressFrame = Math.max(1, duration - 1);
  const sourceFrame = Math.floor(interpolate(
    frame,
    [0, progressFrame],
    [fromFrame, toFrame],
    clamp,
  ));
  const zoom = interpolate(
    frame,
    [0, progressFrame],
    [zoomFrom, zoomTo],
    { ...clamp, easing: Easing.inOut(Easing.sin) },
  );

  return (
    <Img
      src={captureFrame(folder, sourceFrame)}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
        transform: `scale(${zoom})`,
        transformOrigin: origin,
      }}
    />
  );
};

const Scene = ({ children }: { children: ReactNode }) => (
  <AbsoluteFill style={{ overflow: "hidden", background: "#07101B" }}>{children}</AbsoluteFill>
);

const CinematicShade = ({ strength = 0.68 }: { strength?: number }) => (
  <AbsoluteFill
    style={{
      background: `linear-gradient(90deg, rgba(3,8,14,${strength}) 0%, rgba(3,8,14,${strength * 0.7}) 25%, rgba(3,8,14,${strength * 0.12}) 57%, rgba(3,8,14,0) 76%), linear-gradient(0deg, rgba(3,8,14,.34), transparent 34%)`,
      pointerEvents: "none",
    }}
  />
);

const StoryText = ({
  duration,
  children,
  tone = "paper",
  size = 64,
  top = 82,
  maxWidth = 820,
  centered = false,
}: {
  duration: number;
  children: ReactNode;
  tone?: Tone;
  size?: number;
  top?: number;
  maxWidth?: number;
  centered?: boolean;
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, durationInFrames: 16, config: { damping: 200 } });
  const exit = interpolate(
    frame,
    [Math.max(1, duration - 12), Math.max(2, duration - 1)],
    [1, 0],
    clamp,
  );
  const colors: Record<Tone, string> = {
    paper: "#F5F7F8",
    danger: "#FF7187",
    success: "#83EDB3",
    cyan: "#75D9FF",
  };

  return (
    <div
      style={{
        position: "absolute",
        ...(centered ? { left: 180, right: 180, textAlign: "center" } : { left: 96 }),
        top,
        maxWidth: centered ? undefined : maxWidth,
        color: colors[tone],
        fontFamily: sans,
        fontSize: size,
        fontWeight: 800,
        letterSpacing: -1.9,
        lineHeight: 1.12,
        textShadow: "0 5px 28px rgba(0,0,0,.92)",
        opacity: enter * exit,
        transform: `translateY(${(1 - enter) * 16}px)`,
      }}
    >
      {children}
    </div>
  );
};

const ProofReceipt = ({
  duration,
  children,
  tone = "cyan",
  side = "left",
}: {
  duration: number;
  children: ReactNode;
  tone?: Exclude<Tone, "paper">;
  side?: "left" | "right";
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, delay: 7, durationInFrames: 15, config: { damping: 200 } });
  const exit = interpolate(
    frame,
    [Math.max(1, duration - 10), Math.max(2, duration - 1)],
    [1, 0],
    clamp,
  );
  const colors = {
    cyan: { dot: "#68D5FF", border: "rgba(104,213,255,.44)" },
    danger: { dot: "#FF637C", border: "rgba(255,99,124,.48)" },
    success: { dot: "#48E396", border: "rgba(72,227,150,.46)" },
  }[tone];

  return (
    <div
      style={{
        position: "absolute",
        ...(side === "right" ? { right: 96 } : { left: 96 }),
        bottom: 74,
        display: "flex",
        alignItems: "center",
        gap: 12,
        maxWidth: 850,
        padding: "13px 18px",
        borderRadius: 999,
        background: "rgba(5,12,19,.86)",
        outline: `1px solid ${colors.border}`,
        boxShadow: "0 14px 42px rgba(0,0,0,.28)",
        color: "#EEF5F8",
        fontFamily: sans,
        fontSize: 21,
        fontWeight: 760,
        letterSpacing: 0.2,
        opacity: enter * exit,
        transform: `translateY(${(1 - enter) * 9}px)`,
      }}
    >
      <span
        style={{
          width: 10,
          height: 10,
          flex: "0 0 auto",
          borderRadius: "50%",
          background: colors.dot,
          boxShadow: `0 0 18px ${colors.dot}`,
        }}
      />
      {children}
    </div>
  );
};

const TruthWindow = ({ duration }: { duration: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, delay: 10, durationInFrames: 18, config: { damping: 200 } });
  const exit = interpolate(frame, [duration - 11, duration - 1], [1, 0], clamp);
  const facts = [
    ["救护车到达", "28 秒", "#FF7187"],
    ["当前净宽", "1.6 m", "#FF7187"],
    ["至少需要", "3.2 m", "#75D9FF"],
  ] as const;

  return (
    <div
      style={{
        position: "absolute",
        right: 96,
        bottom: 96,
        width: 420,
        padding: "24px 26px 22px",
        borderRadius: 20,
        background: "rgba(6,14,22,.9)",
        outline: "1px solid rgba(255,255,255,.17)",
        boxShadow: "0 22px 58px rgba(0,0,0,.32)",
        opacity: enter * exit,
        transform: `translateY(${(1 - enter) * 14}px)`,
      }}
    >
      <div style={{ color: "rgba(238,245,248,.62)", fontFamily: sans, fontSize: 17, fontWeight: 780, letterSpacing: 2.2 }}>
        当前事实
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", rowGap: 13, marginTop: 18 }}>
        {facts.map(([label, value, color]) => (
          <div key={label} style={{ display: "contents" }}>
            <div style={{ color: "rgba(238,245,248,.76)", fontFamily: sans, fontSize: 21, fontWeight: 690 }}>{label}</div>
            <div style={{ color, fontFamily: sans, fontSize: 26, fontWeight: 830 }}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

const ClickPulse = ({ duration, x = 960, y = 973 }: { duration: number; x?: number; y?: number }) => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [0, duration - 1], [0, 1], {
    ...clamp,
    easing: Easing.out(Easing.quad),
  });
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: 118,
        height: 118,
        marginLeft: -59,
        marginTop: -59,
        borderRadius: "50%",
        outline: "6px solid rgba(104,213,255,.96)",
        boxShadow: "0 0 46px rgba(104,213,255,.8)",
        opacity: 1 - progress,
        transform: `scale(${0.2 + progress * 1.9})`,
      }}
    />
  );
};

const CollisionFocus = ({ duration }: { duration: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, durationInFrames: 14, config: { damping: 18, stiffness: 190 } });
  const pulse = interpolate(frame % 22, [0, 11, 21], [0.74, 1, 0.74], clamp);
  const exit = interpolate(frame, [duration - 10, duration - 1], [1, 0], clamp);
  return (
    <div
      style={{
        position: "absolute",
        left: 1005,
        top: 688,
        width: 270,
        height: 184,
        borderRadius: "50%",
        outline: `${Math.round(5 + pulse * 3)}px solid rgba(255,99,124,.94)`,
        boxShadow: "0 0 44px rgba(255,49,90,.58), inset 0 0 30px rgba(255,49,90,.18)",
        opacity: enter * exit,
        transform: `scale(${0.85 + enter * 0.15})`,
      }}
    >
      <div style={{ position: "absolute", right: -15, top: -23, width: 66, height: 66, borderRadius: "50%", background: "#FF4965", color: "white", fontFamily: sans, fontSize: 47, fontWeight: 850, lineHeight: "61px", textAlign: "center", boxShadow: "0 9px 25px rgba(0,0,0,.4)" }}>
        ×
      </div>
    </div>
  );
};

const Crisis = ({ duration }: { duration: number }) => (
  <Scene>
    <MotionCapture folder="crisis-frames" duration={duration} />
    <CinematicShade strength={0.82} />
    <Sequence from={0} durationInFrames={58} premountFor={30}>
      <StoryText duration={58} size={76} top={96}>
        救护车还有 <span style={{ color: "#FF7187" }}>28 秒</span>
      </StoryText>
    </Sequence>
    <Sequence from={58} durationInFrames={62} premountFor={30}>
      <StoryText duration={62} size={72} top={96} tone="danger">
        唯一通道<br />堵死了
      </StoryText>
    </Sequence>
  </Scene>
);

const Prompt = ({ duration }: { duration: number }) => {
  const frame = useCurrentFrame();
  const promptLine1 = "打开急救通道。";
  const promptLine2 = "不能撞到任何东西。";
  const fullLength = promptLine1.length + promptLine2.length;
  const visible = Math.floor(interpolate(frame, [3, duration - 8], [0, fullLength], clamp));
  const first = promptLine1.slice(0, visible);
  const second = promptLine2.slice(0, Math.max(0, visible - promptLine1.length));

  return (
    <Scene>
      <MotionCapture folder="prompt-frames" duration={duration} />
      <AbsoluteFill style={{ background: "rgba(4,9,15,.7)" }} />
      <div style={{ position: "absolute", top: 248, left: 0, right: 0, textAlign: "center", color: "rgba(245,247,248,.67)", fontFamily: sans, fontSize: 23, fontWeight: 760, letterSpacing: 2.5 }}>
        人只给 AI 一个目标
      </div>
      <div style={{ position: "absolute", top: 322, left: 250, width: 1420, textAlign: "center", color: "#F5F7F8", fontFamily: sans, fontSize: 58, fontWeight: 790, lineHeight: 1.34, letterSpacing: -1.7, textShadow: "0 5px 30px rgba(0,0,0,.92)" }}>
        “{first}
        {visible >= promptLine1.length ? <><br />{second}</> : null}
        <span style={{ color: "#68D5FF" }}>｜</span>”
      </div>
    </Scene>
  );
};

const Understand = ({ duration }: { duration: number }) => (
  <Scene>
    <MotionCapture folder="understand-frames" duration={duration} />
    <CinematicShade strength={0.61} />
    <StoryText duration={duration} size={57} maxWidth={690}>
      它先读取调度快照<br />再理解每个位置
    </StoryText>
    <TruthWindow duration={duration} />
    <ProofReceipt duration={duration}>真实快照 · 读取未改变场景</ProofReceipt>
  </Scene>
);

const Collision = ({ duration }: { duration: number }) => (
  <Scene>
    <MotionCapture folder="collision-frames" duration={duration} />
    <CinematicShade strength={0.66} />
    <Sequence from={0} durationInFrames={50} premountFor={30}>
      <StoryText duration={50} size={58}>最近的位置<br />看起来能放</StoryText>
    </Sequence>
    <Sequence from={50} durationInFrames={70} premountFor={30}>
      <StoryText duration={70} size={62} tone="danger">不行——<br />会撞上街树</StoryText>
      <ProofReceipt duration={70} tone="danger">方案被拒绝 · 修订未改变</ProofReceipt>
      <CollisionFocus duration={70} />
    </Sequence>
  </Scene>
);

const Plan = ({ duration }: { duration: number }) => (
  <Scene>
    <MotionCapture folder="plan-frames" duration={duration} />
    <CinematicShade strength={0.59} />
    <Sequence from={0} durationInFrames={52} premountFor={30}>
      <StoryText duration={52} size={59} tone="success">它重新计算出<br />5 个安全终点</StoryText>
    </Sequence>
    <Sequence from={52} durationInFrames={38} premountFor={30}>
      <StoryText duration={38} size={58}>再把方案<br />交给人决定</StoryText>
    </Sequence>
  </Scene>
);

const Response = ({ duration }: { duration: number }) => (
  <Scene>
    <MotionCapture folder="response-frames" duration={duration} />
    <CinematicShade strength={0.43} />
    <Sequence from={0} durationInFrames={58} premountFor={30}>
      <StoryText duration={58} size={68}>现在，只按一次</StoryText>
    </Sequence>
    <Sequence from={45} durationInFrames={35} premountFor={20}>
      <ClickPulse duration={35} />
    </Sequence>
    <Sequence from={52} durationInFrames={108} premountFor={30}>
      <StoryText duration={108} size={60} tone="success">车辆让开<br />信号切换</StoryText>
    </Sequence>
    <Sequence from={160} durationInFrames={92} premountFor={30}>
      <StoryText duration={92} size={60} tone="success">救护车通过</StoryText>
    </Sequence>
    <Sequence from={252} durationInFrames={48} premountFor={30}>
      <StoryText duration={48} size={62} tone="success">生命通道打开</StoryText>
    </Sequence>
    <Sequence from={50} durationInFrames={238} premountFor={30}>
      <ProofReceipt duration={238} tone="success" side="right">真实点击 · 11 个动作 · 1 次提交</ProofReceipt>
    </Sequence>
  </Scene>
);

const UndoRedo = ({ duration }: { duration: number }) => (
  <Scene>
    <MotionCapture folder="undo-redo-frames" duration={duration} />
    <CinematicShade strength={0.6} />
    <Sequence from={0} durationInFrames={44} premountFor={30}>
      <StoryText duration={44} size={58}>整次响应<br />一起撤销</StoryText>
    </Sequence>
    <Sequence from={44} durationInFrames={46} premountFor={30}>
      <StoryText duration={46} size={58} tone="success">再一下<br />完整恢复</StoryText>
    </Sequence>
  </Scene>
);

const Reopen = ({ duration }: { duration: number }) => (
  <Scene>
    <MotionCapture folder="reopen-frames" duration={duration} />
    <CinematicShade strength={0.64} />
    <Sequence from={0} durationInFrames={42} premountFor={30}>
      <StoryText duration={42} size={57}>保存并重新打开</StoryText>
    </Sequence>
    <Sequence from={42} durationInFrames={48} premountFor={30}>
      <StoryText duration={48} size={58} tone="success">城市、按钮和数据<br />都还在</StoryText>
      <ProofReceipt duration={48} tone="success">项目已重开 · 状态完整</ProofReceipt>
    </Sequence>
  </Scene>
);

const Final = ({ duration }: { duration: number }) => (
  <Scene>
    <MotionCapture folder="final-frames" duration={duration} />
    <AbsoluteFill style={{ background: "rgba(4,9,15,.31)" }} />
    <Sequence from={0} durationInFrames={58} premountFor={30}>
      <StoryText duration={58} size={64}>这不是一段预制动画</StoryText>
    </Sequence>
    <Sequence from={58} durationInFrames={52} premountFor={30}>
      <StoryText duration={52} size={61} tone="cyan">这是一个可验证、<br />可操作的世界</StoryText>
    </Sequence>
    <Sequence from={110} durationInFrames={40} premountFor={30}>
      <StoryText duration={40} size={61} tone="cyan">让 AI 操作世界<br />而不只是生成画面</StoryText>
    </Sequence>
    <div style={{ position: "absolute", left: 96, bottom: 74, color: "rgba(245,247,248,.82)", fontFamily: sans, fontSize: 23, fontWeight: 780, letterSpacing: 2 }}>
      SEMAFRAME
    </div>
  </Scene>
);

const segments = [
  { duration: 120, component: Crisis },
  { duration: 60, component: Prompt },
  { duration: 90, component: Understand },
  { duration: 120, component: Collision },
  { duration: 90, component: Plan },
  { duration: 300, component: Response },
  { duration: 90, component: UndoRedo },
  { duration: 90, component: Reopen },
  { duration: 150, component: Final },
] as const;

export const EMERGENCY_CITY_HERO_DURATION = segments.reduce(
  (total, segment) => total + segment.duration,
  0,
);

const timeline = segments.reduce<Array<(typeof segments)[number] & { from: number }>>(
  (result, segment) => {
    const previous = result.at(-1);
    result.push({ ...segment, from: previous ? previous.from + previous.duration : 0 });
    return result;
  },
  [],
);

export const SemaFrameEmergencyCityHero = () => {
  const { fps, durationInFrames } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: "#07101B" }}>
      <Audio
        src={staticFile("audio/semaframe-emergency-city-hero.wav")}
        volume={(frame) => interpolate(
          frame,
          [0, Math.round(fps * 0.35), durationInFrames - Math.round(fps * 0.8), durationInFrames],
          [0, 1, 1, 0],
          clamp,
        )}
      />
      {timeline.map(({ from, duration, component: Segment }) => (
        <Sequence key={from} from={from} durationInFrames={duration} premountFor={30}>
          <Segment duration={duration} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

export const SemaFrameEmergencyCityPoster = () => (
  <AbsoluteFill style={{ overflow: "hidden", background: "#07101B" }}>
    <Img
      src={captureFrame("final-frames", 132)}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
    />
    <CinematicShade strength={0.86} />
    <div style={{ position: "absolute", left: 96, top: 84, color: "#68D5FF", fontFamily: sans, fontSize: 22, fontWeight: 830, letterSpacing: 3.2 }}>
      SEMAFRAME HERO DEMO
    </div>
    <div style={{ position: "absolute", left: 96, top: 170, maxWidth: 900, color: "#F5F7F8", fontFamily: sans, fontSize: 75, fontWeight: 830, lineHeight: 1.08, letterSpacing: -2.5, textShadow: "0 6px 30px rgba(0,0,0,.92)" }}>
      AI 为城市打开<br />一条生命通道
    </div>
    <div style={{ position: "absolute", left: 98, top: 375, color: "#83EDB3", fontFamily: mono, fontSize: 24, fontWeight: 730 }}>
      1 次点击 · 11 个动作 · 1 次提交
    </div>
    <div style={{ position: "absolute", left: 98, bottom: 74, color: "rgba(245,247,248,.8)", fontFamily: sans, fontSize: 22, fontWeight: 770, letterSpacing: 1.4 }}>
      让 AI 操作世界，而不只是生成画面
    </div>
  </AbsoluteFill>
);
