import { Audio } from "@remotion/media";
import { Fragment, type ReactNode } from "react";
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
import { sans } from "./theme";

const ROOT = "living-room";
const CAPTURE_FRAME_COUNT = 48;
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

type LivingRoomFolder =
  | "room-frames"
  | "build-frames"
  | "collision-frames"
  | "correction-frames"
  | "cinema-control-frames"
  | "undo-redo-frames"
  | "final-orbit-frames";

type StoryTone = "normal" | "danger" | "success" | "cyan";
type LivingRoomLocale = "zh-CN" | "en-US";
type StoryLines = readonly string[];

type LivingRoomCopy = {
  hook: StoryLines;
  promptLabel: string;
  prompt: string;
  room: StoryLines;
  build: StoryLines;
  collisionQuestion: StoryLines;
  collisionBlocked: StoryLines;
  correctionStart: StoryLines;
  correctionSuccess: StoryLines;
  cinemaPrompt: StoryLines;
  cinemaResponse: StoryLines;
  undo: StoryLines;
  redo: StoryLines;
  finalOpening: StoryLines;
  finalIdentity: StoryLines;
  footer: string;
  boundaryNote: string | null;
};

const LIVING_ROOM_COPY = {
  "zh-CN": {
    hook: ["AI 不只画了这个客厅", "它还知道哪里不能放"],
    promptLabel: "我只给 AI 一句话",
    prompt: "把这间小客厅，变得能办公、能看电影，门口还不能堵。",
    room: ["它先理解房间", "和门的位置"],
    build: ["再把办公区和观影区", "一起搭出来"],
    collisionQuestion: ["沙发放这里？"],
    collisionBlocked: ["等等——", "它挡住门了"],
    correctionStart: ["AI 重新选位置"],
    correctionSuccess: ["沙发放好了", "门口也畅通"],
    cinemaPrompt: ["再按一下", "“观影模式”"],
    cinemaResponse: ["电视和灯光", "马上响应"],
    undo: ["不满意？", "一键撤回"],
    redo: ["还可以", "一键恢复"],
    finalOpening: ["这不是一张效果图"],
    finalIdentity: ["它是一个能检查、能控制、", "还能继续修改的空间"],
    footer: "SEMAFRAME · 让 AI 真正操作空间",
    boundaryNote: null,
  },
  "en-US": {
    hook: ["AI didn’t just furnish this room", "It knows what must stay clear"],
    promptLabel: "ONE REQUEST TO THE AGENT",
    prompt: "Turn this small living room into an office and a cinema—without blocking the door.",
    room: ["First, it maps the room", "and the doorway"],
    build: ["Then it builds spaces to work", "and watch movies"],
    collisionQuestion: ["Put the sofa here?"],
    collisionBlocked: ["Stop—", "it blocks the doorway"],
    correctionStart: ["The Agent picks a safer spot"],
    correctionSuccess: ["Sofa placed", "Doorway clear"],
    cinemaPrompt: ["Now press", "“Cinema Mode”"],
    cinemaResponse: ["TV and lights", "respond together"],
    undo: ["Changed your mind?", "Undo"],
    redo: ["Then bring it back", "with Redo"],
    finalOpening: ["This is not a rendered image"],
    finalIdentity: ["It’s an editable space you can check,", "control, and keep changing"],
    footer: "SEMAFRAME · AN AI-OPERABLE SPATIAL WORKSPACE",
    boundaryNote: "SYNTHETIC ROOM · COLLISION PREFLIGHT, NOT BUILDING CERTIFICATION",
  },
} as const satisfies Record<LivingRoomLocale, LivingRoomCopy>;

const Lines = ({ lines }: { lines: StoryLines }) => (
  <>
    {lines.map((line, index) => (
      <Fragment key={`${index}-${line}`}>
        {line}
        {index < lines.length - 1 ? <br /> : null}
      </Fragment>
    ))}
  </>
);

const capture = (path: string) => staticFile(`${ROOT}/${path}`);

const captureFrame = (folder: LivingRoomFolder, frame: number) =>
  capture(`${folder}/frame-${String(frame).padStart(4, "0")}.jpg`);

const MotionCapture = ({
  duration,
  folder,
  fromFrame = 0,
  locale,
  toFrame = CAPTURE_FRAME_COUNT - 1,
  zoom = 1,
  origin = "50% 50%",
}: {
  duration: number;
  folder: LivingRoomFolder;
  fromFrame?: number;
  locale: LivingRoomLocale;
  toFrame?: number;
  zoom?: number;
  origin?: string;
}) => {
  const frame = useCurrentFrame();
  const cameraProgress = interpolate(frame, [0, Math.max(1, duration - 1)], [0, 1], clamp);
  const sourceFrame = Math.floor(interpolate(
    frame,
    [0, Math.max(1, duration - 1)],
    [fromFrame, toFrame],
    clamp,
  ));

  return (
    <AbsoluteFill
      style={{
        transform: `translate3d(${-18 * cameraProgress}px, ${-9 * cameraProgress}px, 0) scale(${zoom * (1 + 0.075 * cameraProgress)})`,
        transformOrigin: origin,
      }}
    >
      <Img
        src={captureFrame(folder, sourceFrame)}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
        }}
      />
      {locale === "en-US" && folder !== "room-frames" ? (
        <div
          style={{
            position: "absolute",
            left: 812,
            top: 938,
            width: 296,
            height: 78,
            padding: 12,
            boxSizing: "border-box",
            borderRadius: 17,
            background: "#101820",
            boxShadow: "0 8px 20px rgba(0,0,0,.34)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "100%",
              height: "100%",
              borderRadius: 12,
              background: "linear-gradient(180deg, #57C3E9, #43AAD2)",
              color: "#06151E",
              fontFamily: sans,
              fontSize: 24,
              fontWeight: 800,
              letterSpacing: -0.4,
            }}
          >
            Cinema Mode
          </div>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

const Vignette = ({ strength = 0.7 }: { strength?: number }) => (
  <AbsoluteFill
    style={{
      background: `linear-gradient(90deg, rgba(5,9,13,${strength}) 0%, rgba(5,9,13,${strength * 0.3}) 42%, rgba(5,9,13,0) 72%), linear-gradient(0deg, rgba(5,9,13,.34), transparent 38%)`,
      pointerEvents: "none",
    }}
  />
);

const StoryText = ({
  children,
  duration,
  tone = "normal",
  centered = false,
  size = 62,
  top = 80,
  maxWidth = 960,
}: {
  children: ReactNode;
  duration: number;
  tone?: StoryTone;
  centered?: boolean;
  size?: number;
  top?: number;
  maxWidth?: number;
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, durationInFrames: 16, config: { damping: 200 } });
  const exit = interpolate(frame, [Math.max(1, duration - 12), Math.max(2, duration - 1)], [1, 0], clamp);
  const colors: Record<StoryTone, string> = {
    normal: "#F7F4EE",
    danger: "#FF6B7D",
    success: "#91E4B0",
    cyan: "#68D5FF",
  };

  return (
    <div
      style={{
        position: "absolute",
        top,
        ...(centered ? { left: 160, right: 160, textAlign: "center" } : { left: 72, maxWidth }),
        color: colors[tone],
        fontFamily: sans,
        fontSize: size,
        fontWeight: 760,
        letterSpacing: -1.6,
        lineHeight: 1.16,
        textShadow: "0 4px 22px rgba(0,0,0,.82)",
        opacity: enter * exit,
        transform: `translateY(${(1 - enter) * 16}px)`,
      }}
    >
      {children}
    </div>
  );
};

type LivingRoomSceneProps = {
  copy: LivingRoomCopy;
  duration: number;
  locale: LivingRoomLocale;
};

const Prompt = ({ copy, duration, locale }: LivingRoomSceneProps) => {
  const frame = useCurrentFrame();
  const prompt = copy.prompt;
  const english = locale === "en-US";
  const visible = Math.floor(interpolate(frame, [10, duration - 34], [0, prompt.length], clamp));
  return (
    <AbsoluteFill>
      <MotionCapture duration={duration} folder="room-frames" fromFrame={0} locale={locale} toFrame={0} />
      <AbsoluteFill style={{ background: "rgba(5,9,13,.66)" }} />
      <div
        style={{
          position: "absolute",
          left: 220,
          right: 220,
          top: english ? 304 : 330,
          color: "#F7F4EE",
          fontFamily: sans,
          fontSize: english ? 50 : 60,
          fontWeight: 720,
          letterSpacing: -1.8,
          lineHeight: 1.25,
          textAlign: "center",
          textShadow: "0 5px 28px rgba(0,0,0,.9)",
        }}
      >
        “{prompt.slice(0, visible)}<span style={{ color: "#68D5FF" }}>｜</span>”
      </div>
      <div
        style={{
          position: "absolute",
          top: 255,
          left: 0,
          right: 0,
          textAlign: "center",
          color: "rgba(247,244,238,.7)",
          fontFamily: sans,
          fontSize: 24,
          fontWeight: 700,
          letterSpacing: 2,
        }}
      >
        {copy.promptLabel}
      </div>
    </AbsoluteFill>
  );
};

const CollisionMark = ({ duration }: { duration: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, durationInFrames: 14, config: { damping: 18, stiffness: 190 } });
  const pulse = interpolate(frame % 20, [0, 10, 19], [0.72, 1, 0.72], clamp);
  return (
    <div
      style={{
        position: "absolute",
        left: 320,
        top: 470,
        width: 420,
        height: 310,
        borderRadius: "50%",
        outline: `${Math.round(5 + pulse * 3)}px solid rgba(255,107,125,.92)`,
        boxShadow: "0 0 42px rgba(255,53,94,.55), inset 0 0 34px rgba(255,53,94,.18)",
        opacity: enter * interpolate(frame, [duration - 12, duration - 1], [1, 0], clamp),
        transform: `scale(${0.84 + enter * 0.16})`,
      }}
    >
      <div
        style={{
          position: "absolute",
          right: -18,
          top: -22,
          width: 74,
          height: 74,
          borderRadius: "50%",
          background: "#FF4965",
          color: "white",
          fontFamily: sans,
          fontSize: 52,
          fontWeight: 800,
          lineHeight: "68px",
          textAlign: "center",
          boxShadow: "0 8px 26px rgba(0,0,0,.36)",
        }}
      >
        ×
      </div>
    </div>
  );
};

const SuccessMark = ({ duration }: { duration: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, durationInFrames: 14, config: { damping: 18, stiffness: 190 } });
  const exit = interpolate(frame, [Math.max(1, duration - 12), Math.max(2, duration - 1)], [1, 0], clamp);
  return (
    <div
      style={{
        position: "absolute",
        left: 392,
        top: 580,
        width: 94,
        height: 94,
        borderRadius: "50%",
        background: "#39C979",
        color: "white",
        fontFamily: sans,
        fontSize: 62,
        fontWeight: 850,
        lineHeight: "88px",
        textAlign: "center",
        boxShadow: "0 0 38px rgba(57,201,121,.68), 0 10px 28px rgba(0,0,0,.38)",
        opacity: enter * exit,
        transform: `scale(${0.72 + enter * 0.28})`,
      }}
    >
      ✓
    </div>
  );
};

const ClickPulse = ({ duration, x = 960, y = 985 }: { duration: number; x?: number; y?: number }) => {
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
        width: 110,
        height: 110,
        marginLeft: -55,
        marginTop: -55,
        borderRadius: "50%",
        outline: "5px solid rgba(104,213,255,.95)",
        boxShadow: "0 0 35px rgba(104,213,255,.7)",
        opacity: 1 - progress,
        transform: `scale(${0.25 + progress * 1.65})`,
      }}
    />
  );
};

const Scene = ({ children }: { children: ReactNode }) => (
  <AbsoluteFill style={{ overflow: "hidden", background: "#091018" }}>{children}</AbsoluteFill>
);

const HookScene = ({ copy, duration, locale }: LivingRoomSceneProps) => (
  <Scene>
    <MotionCapture duration={duration} folder="final-orbit-frames" fromFrame={18} locale={locale} toFrame={42} zoom={1.035} />
    <Vignette strength={0.82} />
    <StoryText duration={duration} size={locale === "en-US" ? 58 : 66} top={112} maxWidth={locale === "en-US" ? 1220 : 960}>
      <Lines lines={copy.hook} />
    </StoryText>
  </Scene>
);

const RoomScene = ({ copy, duration, locale }: LivingRoomSceneProps) => (
  <Scene>
    <MotionCapture duration={duration} folder="room-frames" locale={locale} />
    <Vignette />
    <StoryText duration={duration} size={locale === "en-US" ? 58 : 62} maxWidth={locale === "en-US" ? 1120 : 960}>
      <Lines lines={copy.room} />
    </StoryText>
  </Scene>
);

const BuildScene = ({ copy, duration, locale }: LivingRoomSceneProps) => (
  <Scene>
    <MotionCapture duration={duration} folder="build-frames" locale={locale} />
    <Vignette strength={0.62} />
    <StoryText duration={duration} size={locale === "en-US" ? 56 : 62} maxWidth={locale === "en-US" ? 1180 : 960}>
      <Lines lines={copy.build} />
    </StoryText>
  </Scene>
);

const CollisionScene = ({ copy, duration, locale }: LivingRoomSceneProps) => (
  <Scene>
    <MotionCapture duration={duration} folder="collision-frames" locale={locale} />
    <Vignette strength={0.54} />
    <Sequence from={0} durationInFrames={112} premountFor={30}>
      <StoryText duration={112} size={locale === "en-US" ? 58 : 62} maxWidth={locale === "en-US" ? 1120 : 960}>
        <Lines lines={copy.collisionQuestion} />
      </StoryText>
    </Sequence>
    <Sequence from={112} durationInFrames={duration - 112} premountFor={30}>
      <StoryText duration={duration - 112} tone="danger" size={locale === "en-US" ? 58 : 62} maxWidth={locale === "en-US" ? 1120 : 960}>
        <Lines lines={copy.collisionBlocked} />
      </StoryText>
    </Sequence>
    <Sequence from={118} durationInFrames={duration - 118} premountFor={30}>
      <CollisionMark duration={duration - 118} />
    </Sequence>
  </Scene>
);

const CorrectionScene = ({ copy, duration, locale }: LivingRoomSceneProps) => (
  <Scene>
    <MotionCapture duration={duration} folder="correction-frames" locale={locale} />
    <Vignette strength={0.58} />
    <Sequence from={0} durationInFrames={98} premountFor={30}>
      <StoryText duration={98} size={locale === "en-US" ? 56 : 62} maxWidth={locale === "en-US" ? 1180 : 960}>
        <Lines lines={copy.correctionStart} />
      </StoryText>
    </Sequence>
    <Sequence from={98} durationInFrames={duration - 98} premountFor={30}>
      <StoryText duration={duration - 98} tone="success" size={locale === "en-US" ? 58 : 62} maxWidth={locale === "en-US" ? 1120 : 960}>
        <Lines lines={copy.correctionSuccess} />
      </StoryText>
    </Sequence>
    <Sequence from={104} durationInFrames={duration - 104} premountFor={30}>
      <SuccessMark duration={duration - 104} />
    </Sequence>
  </Scene>
);

const CinemaScene = ({ copy, duration, locale }: LivingRoomSceneProps) => (
  <Scene>
    <MotionCapture duration={duration} folder="cinema-control-frames" locale={locale} zoom={1.025} origin="54% 70%" />
    <Vignette strength={0.46} />
    <Sequence from={0} durationInFrames={142} premountFor={30}>
      <StoryText duration={142} size={locale === "en-US" ? 58 : 62} maxWidth={locale === "en-US" ? 1120 : 960}>
        <Lines lines={copy.cinemaPrompt} />
      </StoryText>
    </Sequence>
    <Sequence from={128} durationInFrames={30} premountFor={20}>
      <ClickPulse duration={30} />
    </Sequence>
    <Sequence from={144} durationInFrames={duration - 144} premountFor={30}>
      <StoryText duration={duration - 144} tone="cyan" size={locale === "en-US" ? 58 : 62} maxWidth={locale === "en-US" ? 1120 : 960}>
        <Lines lines={copy.cinemaResponse} />
      </StoryText>
    </Sequence>
  </Scene>
);

const UndoScene = ({ copy, duration, locale }: LivingRoomSceneProps) => (
  <Scene>
    <MotionCapture duration={duration} folder="undo-redo-frames" locale={locale} />
    <Vignette strength={0.58} />
    <Sequence from={32} durationInFrames={50} premountFor={30}>
      <StoryText duration={50} size={locale === "en-US" ? 56 : 62} maxWidth={locale === "en-US" ? 1120 : 960}>
        <Lines lines={copy.undo} />
      </StoryText>
    </Sequence>
    <Sequence from={82} durationInFrames={duration - 82} premountFor={30}>
      <StoryText duration={duration - 82} tone="success" size={locale === "en-US" ? 56 : 62} maxWidth={locale === "en-US" ? 1120 : 960}>
        <Lines lines={copy.redo} />
      </StoryText>
    </Sequence>
  </Scene>
);

const FinalScene = ({ copy, duration, locale }: LivingRoomSceneProps) => (
  <Scene>
    <MotionCapture duration={duration} folder="final-orbit-frames" locale={locale} />
    <AbsoluteFill style={{ background: "rgba(5,9,13,.33)" }} />
    <Sequence from={0} durationInFrames={66} premountFor={30}>
      <StoryText duration={66} centered size={locale === "en-US" ? 58 : 66} top={104}>
        <Lines lines={copy.finalOpening} />
      </StoryText>
    </Sequence>
    <Sequence from={66} durationInFrames={duration - 66} premountFor={30}>
      <StoryText duration={duration - 66} centered size={locale === "en-US" ? 50 : 58} top={88}>
        <Lines lines={copy.finalIdentity} />
      </StoryText>
    </Sequence>
    <div
      style={{
        position: "absolute",
        left: 72,
        bottom: 42,
        textAlign: "left",
        color: "rgba(247,244,238,.8)",
        fontFamily: sans,
        fontSize: 26,
        fontWeight: 700,
        letterSpacing: 1.8,
      }}
    >
      {copy.footer}
    </div>
    {copy.boundaryNote ? (
      <div
        style={{
          position: "absolute",
          right: 72,
          bottom: 46,
          maxWidth: 680,
          color: "rgba(247,244,238,.62)",
          fontFamily: sans,
          fontSize: 17,
          fontWeight: 700,
          letterSpacing: 1.1,
          lineHeight: 1.3,
          textAlign: "right",
        }}
      >
        {copy.boundaryNote}
      </div>
    ) : null}
  </Scene>
);

export const SemaFrameLivingRoomPublicDemoEnglishPoster = () => (
  <Scene>
    <MotionCapture
      duration={1}
      folder="final-orbit-frames"
      fromFrame={32}
      locale="en-US"
      toFrame={32}
      zoom={1.025}
      origin="58% 58%"
    />
    <Vignette strength={0.86} />
    <AbsoluteFill
      style={{
        background: "linear-gradient(90deg, rgba(5,9,13,.22) 0%, transparent 68%), linear-gradient(0deg, rgba(5,9,13,.36), transparent 42%)",
      }}
    />
    <div
      style={{
        position: "absolute",
        left: 88,
        top: 82,
        color: "#68D5FF",
        fontFamily: sans,
        fontSize: 22,
        fontWeight: 800,
        letterSpacing: 3.1,
      }}
    >
      ONE REQUEST · ONE EDITABLE WORLD
    </div>
    <div
      style={{
        position: "absolute",
        left: 82,
        top: 130,
        maxWidth: 1040,
        color: "#F7F4EE",
        fontFamily: sans,
        fontSize: 78,
        fontWeight: 780,
        letterSpacing: -2.8,
        lineHeight: 1.06,
        textShadow: "0 5px 28px rgba(0,0,0,.9)",
      }}
    >
      AI furnished the room.<br />The doorway stayed clear.
    </div>
    <div
      style={{
        position: "absolute",
        left: 88,
        top: 340,
        padding: "13px 19px",
        borderRadius: 14,
        background: "rgba(10,18,25,.76)",
        color: "#91E4B0",
        fontFamily: sans,
        fontSize: 24,
        fontWeight: 750,
        letterSpacing: 0.1,
        boxShadow: "0 10px 30px rgba(0,0,0,.22)",
      }}
    >
      Doorway collision caught · Cinema Mode wired
    </div>
    <div
      style={{
        position: "absolute",
        left: 88,
        bottom: 62,
        color: "#F7F4EE",
        fontFamily: sans,
      }}
    >
      <div style={{ fontSize: 28, fontWeight: 850, letterSpacing: 2.2 }}>SEMAFRAME</div>
      <div style={{ marginTop: 5, color: "rgba(247,244,238,.72)", fontSize: 20, fontWeight: 650 }}>
        An AI-operable 2D + 3D workspace
      </div>
    </div>
    <div
      style={{
        position: "absolute",
        right: 76,
        bottom: 70,
        maxWidth: 690,
        color: "rgba(247,244,238,.62)",
        fontFamily: sans,
        fontSize: 17,
        fontWeight: 700,
        letterSpacing: 1.05,
        lineHeight: 1.35,
        textAlign: "right",
      }}
    >
      SYNTHETIC ROOM · COLLISION PREFLIGHT, NOT BUILDING CERTIFICATION
    </div>
  </Scene>
);

const segments = [
  { duration: 72, component: HookScene },
  { duration: 78, component: Prompt },
  { duration: 105, component: RoomScene },
  { duration: 165, component: BuildScene },
  { duration: 180, component: CollisionScene },
  { duration: 150, component: CorrectionScene },
  { duration: 210, component: CinemaScene },
  { duration: 120, component: UndoScene },
  { duration: 120, component: FinalScene },
] as const;

export const LIVING_ROOM_PUBLIC_DURATION = segments.reduce((total, segment) => total + segment.duration, 0);

const timeline = segments.reduce<Array<(typeof segments)[number] & { from: number }>>((result, segment) => {
  const previous = result.at(-1);
  result.push({ ...segment, from: previous ? previous.from + previous.duration : 0 });
  return result;
}, []);

const LivingRoomPublicDemo = ({ locale }: { locale: LivingRoomLocale }) => {
  const { fps, durationInFrames } = useVideoConfig();
  const copy = LIVING_ROOM_COPY[locale];
  return (
    <AbsoluteFill style={{ background: "#091018" }}>
      <Audio
        src={staticFile("audio/semaframe-living-room-demo.wav")}
        volume={(frame) => interpolate(
          frame,
          [0, fps, durationInFrames - 2 * fps, durationInFrames],
          [0, 0.92, 0.92, 0],
          clamp,
        )}
      />
      {timeline.map(({ from, duration, component: Segment }) => (
        <Sequence key={from} from={from} durationInFrames={duration} premountFor={30}>
          <Segment copy={copy} duration={duration} locale={locale} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

export const LIVING_ROOM_PUBLIC_ENGLISH_DURATION = LIVING_ROOM_PUBLIC_DURATION;

export const SemaFrameLivingRoomPublicDemo = () => <LivingRoomPublicDemo locale="zh-CN" />;

export const SemaFrameLivingRoomPublicDemoEnglish = () => <LivingRoomPublicDemo locale="en-US" />;
