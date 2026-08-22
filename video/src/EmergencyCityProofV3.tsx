import {Audio} from "@remotion/media";
import type {CSSProperties, ReactNode} from "react";
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
import {
  EmergencyCityAtomicFanOut,
  EmergencyCityDataLink,
  EmergencyCityProductDefinitionSemanticAnchors,
  EmergencyCityRevisionPersistenceCues,
  EmergencyCitySpatialLabels,
} from "./EmergencyCitySemanticLens";
import {mono, sans} from "./theme";

const ROOT = "emergency-city";
// Crop math uses a normalized 16:9 view box, so the native 1920x1080 evidence
// stays aligned across the landscape and dedicated portrait compositions.
const SOURCE_ASPECT_WIDTH = 16;
const SOURCE_ASPECT_HEIGHT = 9;
const clamp = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;
const TITLE_ENTER_FRAMES = 10;
const TITLE_EXIT_FRAMES = 5;
const PROOF_ENTER_FRAMES = 8;
const PROOF_EXIT_FRAMES = 4;

export const EMERGENCY_CITY_PROOF_V3_LANDSCAPE_DURATION = 960;
export const EMERGENCY_CITY_PROOF_V3_VERTICAL_DURATION = 840;
export const EMERGENCY_CITY_PROOF_V4_LANDSCAPE_DURATION = 960;
export const EMERGENCY_CITY_PROOF_V4_VERTICAL_DURATION = 840;

type Variant = "landscape" | "vertical";
type Language = "zh" | "en";
type Tone = "paper" | "danger" | "success" | "cyan";
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
type BeatId =
  | "crisis"
  | "product_definition"
  | "goal"
  | "data_read"
  | "space_read"
  | "spatial_read"
  | "collision_rejection"
  | "safe_plan"
  | "human_confirm"
  | "response"
  | "resolution"
  | "editability"
  | "identity";

type Crop = {x: number; y: number; width: number; height: number};
type SourceRange = {
  folder: CaptureFolder;
  fromFrame: number;
  toFrame: number;
};
type Beat = {
  id: BeatId;
  duration: number;
  source: SourceRange;
};

type V4BeatCopy = {
  title: string;
  proof: string;
  secondTitle?: string;
};

type V4Copy = Record<BeatId, V4BeatCopy>;

const v4Copy = {
  zh: {
    crisis: {title: "28秒后，救护车到达", proof: "唯一通道已堵死"},
    product_definition: {title: "这是SEMAFRAME", proof: "AI可读、可操作的3D工作区"},
    goal: {title: "我对它说", proof: "“打开通道，别撞到东西”"},
    data_read: {title: "AI先读取调度数据", proof: "ETA 28秒 · 净宽1.6m · 只读快照"},
    space_read: {title: "再读懂每个物体", proof: "位置 · 尺寸 · 碰撞体 · 可执行动作"},
    spatial_read: {title: "AI先读数据，再读空间", proof: "调度快照 · 读取未改场景"},
    collision_rejection: {title: "这个位置会撞上街树", proof: "空间预检拒绝 · 原场景未改"},
    safe_plan: {title: "AI找到5个安全终点", proof: "终点预检 · 5/5通过"},
    human_confirm: {title: "AI出方案，人确认一次", proof: "11项修改 · 等待提交"},
    response: {
      title: "一次点击，11个动作",
      secondTitle: "车辆让路，信号和路线同步",
      proof: "1次点击 · 1次原子提交",
    },
    resolution: {title: "救护车抵达医院", proof: "最终状态 · 0碰撞冲突"},
    editability: {title: "改动不是播好的动画", proof: "可撤销 · 可恢复 · 保存重开仍存在"},
    identity: {
      title: "不是生成一段动画\n而是修改一个3D世界",
      proof: "SEMAFRAME · AI可操作的2D+3D工作空间",
    },
  },
  en: {
    crisis: {title: "Ambulance arrives in 28s", proof: "Its route is blocked"},
    product_definition: {title: "This is SemaFrame", proof: "An AI-readable, operable 3D workspace"},
    goal: {title: "I give it one goal", proof: "“Open the route. Hit nothing.”"},
    data_read: {title: "The AI reads dispatch data", proof: "ETA 28s · 1.6m clear · read-only snapshot"},
    space_read: {title: "Then it reads every object", proof: "Position · size · collider · declared actions"},
    spatial_read: {title: "The AI reads data, then space", proof: "Dispatch snapshot · scene unchanged"},
    collision_rejection: {title: "This position hits a street tree", proof: "Endpoint preflight rejected · scene unchanged"},
    safe_plan: {title: "The AI finds 5 safe endpoints", proof: "Endpoint preflight · 5/5 passed"},
    human_confirm: {title: "AI proposes. A human confirms.", proof: "11 changes · pending one commit"},
    response: {
      title: "One click triggers 11 actions",
      secondTitle: "Vehicles yield. Signals and route sync.",
      proof: "1 click · 1 atomic commit",
    },
    resolution: {title: "Ambulance reaches the hospital", proof: "Final state · 0 collision conflicts"},
    editability: {title: "This is not a pre-rendered change", proof: "Undo · redo · saved state survives reopen"},
    identity: {
      title: "Not a rendered clip.\nAn editable 3D world.",
      proof: "SEMAFRAME · AI-operable 2D + 3D workspace",
    },
  },
} as const satisfies Record<Language, V4Copy>;

export const EMERGENCY_CITY_PROOF_V4_ENGLISH_COPY = v4Copy.en;

const landscapeBeats: Beat[] = [
  {id: "crisis", duration: 90, source: {folder: "crisis-frames", fromFrame: 0, toFrame: 119}},
  {id: "goal", duration: 75, source: {folder: "prompt-frames", fromFrame: 0, toFrame: 59}},
  {id: "spatial_read", duration: 90, source: {folder: "understand-frames", fromFrame: 0, toFrame: 89}},
  {id: "collision_rejection", duration: 105, source: {folder: "collision-frames", fromFrame: 0, toFrame: 119}},
  {id: "safe_plan", duration: 90, source: {folder: "plan-frames", fromFrame: 0, toFrame: 89}},
  {id: "human_confirm", duration: 60, source: {folder: "response-frames", fromFrame: 0, toFrame: 44}},
  {id: "response", duration: 165, source: {folder: "response-frames", fromFrame: 45, toFrame: 219}},
  {id: "resolution", duration: 75, source: {folder: "final-frames", fromFrame: 0, toFrame: 74}},
  {id: "editability", duration: 120, source: {folder: "undo-redo-frames", fromFrame: 0, toFrame: 89}},
  {id: "identity", duration: 90, source: {folder: "final-frames", fromFrame: 30, toFrame: 149}},
];

const verticalBeats: Beat[] = [
  {id: "crisis", duration: 75, source: {folder: "crisis-frames", fromFrame: 0, toFrame: 119}},
  {id: "goal", duration: 60, source: {folder: "prompt-frames", fromFrame: 0, toFrame: 59}},
  {id: "spatial_read", duration: 75, source: {folder: "understand-frames", fromFrame: 0, toFrame: 89}},
  {id: "collision_rejection", duration: 90, source: {folder: "collision-frames", fromFrame: 0, toFrame: 119}},
  {id: "safe_plan", duration: 75, source: {folder: "plan-frames", fromFrame: 0, toFrame: 89}},
  {id: "human_confirm", duration: 60, source: {folder: "response-frames", fromFrame: 0, toFrame: 44}},
  {id: "response", duration: 140, source: {folder: "response-frames", fromFrame: 45, toFrame: 219}},
  {id: "resolution", duration: 70, source: {folder: "final-frames", fromFrame: 0, toFrame: 74}},
  {id: "editability", duration: 105, source: {folder: "undo-redo-frames", fromFrame: 0, toFrame: 89}},
  {id: "identity", duration: 90, source: {folder: "final-frames", fromFrame: 30, toFrame: 149}},
];

// V4 keeps the already verified source capture and delivery durations, but
// moves the product definition into the opening five seconds. Data and space
// are deliberately separate beats so a muted viewer can see what SemaFrame
// reads before the collision and action proof begins.
const v4LandscapeBeats: Beat[] = [
  {id: "crisis", duration: 75, source: {folder: "crisis-frames", fromFrame: 0, toFrame: 119}},
  {id: "product_definition", duration: 75, source: {folder: "understand-frames", fromFrame: 0, toFrame: 44}},
  {id: "goal", duration: 60, source: {folder: "prompt-frames", fromFrame: 0, toFrame: 59}},
  {id: "data_read", duration: 75, source: {folder: "understand-frames", fromFrame: 0, toFrame: 44}},
  {id: "space_read", duration: 75, source: {folder: "understand-frames", fromFrame: 45, toFrame: 89}},
  {id: "collision_rejection", duration: 90, source: {folder: "collision-frames", fromFrame: 0, toFrame: 119}},
  {id: "safe_plan", duration: 75, source: {folder: "plan-frames", fromFrame: 0, toFrame: 89}},
  {id: "human_confirm", duration: 60, source: {folder: "response-frames", fromFrame: 0, toFrame: 44}},
  {id: "response", duration: 150, source: {folder: "response-frames", fromFrame: 45, toFrame: 219}},
  {id: "resolution", duration: 60, source: {folder: "final-frames", fromFrame: 0, toFrame: 74}},
  {id: "editability", duration: 90, source: {folder: "undo-redo-frames", fromFrame: 0, toFrame: 89}},
  {id: "identity", duration: 75, source: {folder: "final-frames", fromFrame: 30, toFrame: 149}},
];

const v4VerticalBeats: Beat[] = [
  {id: "crisis", duration: 60, source: {folder: "crisis-frames", fromFrame: 0, toFrame: 119}},
  {id: "product_definition", duration: 60, source: {folder: "understand-frames", fromFrame: 0, toFrame: 44}},
  {id: "goal", duration: 60, source: {folder: "prompt-frames", fromFrame: 0, toFrame: 59}},
  {id: "data_read", duration: 60, source: {folder: "understand-frames", fromFrame: 0, toFrame: 44}},
  {id: "space_read", duration: 60, source: {folder: "understand-frames", fromFrame: 45, toFrame: 89}},
  {id: "collision_rejection", duration: 75, source: {folder: "collision-frames", fromFrame: 0, toFrame: 119}},
  {id: "safe_plan", duration: 60, source: {folder: "plan-frames", fromFrame: 0, toFrame: 89}},
  {id: "human_confirm", duration: 60, source: {folder: "response-frames", fromFrame: 0, toFrame: 44}},
  {id: "response", duration: 120, source: {folder: "response-frames", fromFrame: 45, toFrame: 219}},
  {id: "resolution", duration: 60, source: {folder: "final-frames", fromFrame: 0, toFrame: 74}},
  {id: "editability", duration: 90, source: {folder: "undo-redo-frames", fromFrame: 0, toFrame: 89}},
  {id: "identity", duration: 75, source: {folder: "final-frames", fromFrame: 30, toFrame: 149}},
];

const colors: Record<Tone, string> = {
  paper: "#F7F8F6",
  danger: "#FF5E76",
  success: "#63F0A5",
  cyan: "#64D7FF",
};

const captureFrame = (folder: CaptureFolder, frame: number) =>
  staticFile(`${ROOT}/${folder}/frame-${String(frame).padStart(4, "0")}.jpg`);

const sourceFrameFor = (
  frame: number,
  duration: number,
  fromFrame: number,
  toFrame: number,
) => {
  const mapped = Math.floor(
    interpolate(frame, [0, Math.max(1, duration - 1)], [fromFrame, toFrame], clamp),
  );
  return Math.min(Math.max(mapped, Math.min(fromFrame, toFrame)), Math.max(fromFrame, toFrame));
};

// The captured city is shared by both language editions. These two small
// viewport surfaces contain baked-in Chinese copy, so the English composition
// redraws them in the capture's native 1920x1080 coordinate space. Keeping the
// localization inside the source-image wrapper means it stays aligned through
// landscape scaling and every portrait detail crop.
const CaptureEnglishLocalization = () => (
  <svg
    data-capture-localization="english-viewport-copy"
    viewBox="0 0 1920 1080"
    preserveAspectRatio="none"
    style={{position: "absolute", inset: 0, width: "100%", height: "100%"}}
  >
    <g data-capture-localization-surface="dispatch-chart-title">
      <rect x="1444" y="97" width="456" height="58" fill="#101722" />
      <text
        x="1458"
        y="128"
        dominantBaseline="middle"
        fill="#F3F6FA"
        fontFamily={mono}
        fontSize="16"
        fontWeight="800"
        letterSpacing="0.2"
      >
        DISPATCH · ETA 28s
      </text>
      <text
        x="1884"
        y="128"
        textAnchor="end"
        dominantBaseline="middle"
        fill="#65CEF1"
        fontFamily={mono}
        fontSize="16"
        fontWeight="800"
        letterSpacing="0.2"
      >
        CLEAR 1.6m
      </text>
    </g>
    <g data-capture-localization-surface="emergency-route-button">
      <rect x="833" y="966" width="254" height="55" rx="11" fill="#65CEF1" />
      <text
        x="960"
        y="994"
        textAnchor="middle"
        dominantBaseline="middle"
        fill="#08141D"
        fontFamily={sans}
        fontSize="15"
        fontWeight="850"
        letterSpacing="-0.15"
      >
        OPEN EMERGENCY ROUTE
      </text>
    </g>
  </svg>
);

const SequenceImage = ({
  source,
  duration,
  style,
  language = "zh",
}: {
  source: SourceRange;
  duration: number;
  style?: CSSProperties;
  language?: Language;
}) => {
  const frame = useCurrentFrame();
  const sourceFrame = sourceFrameFor(frame, duration, source.fromFrame, source.toFrame);
  return (
    <AbsoluteFill>
      <Img
        src={captureFrame(source.folder, sourceFrame)}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          ...style,
        }}
      />
      {language === "en" ? <CaptureEnglishLocalization /> : null}
    </AbsoluteFill>
  );
};

const CroppedSequenceImage = ({
  source,
  duration,
  crop,
  width,
  height,
  language = "zh",
}: {
  source: SourceRange;
  duration: number;
  crop: Crop;
  width: number;
  height: number;
  language?: Language;
}) => {
  const frame = useCurrentFrame();
  const sourceFrame = sourceFrameFor(frame, duration, source.fromFrame, source.toFrame);
  const cropX = crop.x * SOURCE_ASPECT_WIDTH;
  const cropY = crop.y * SOURCE_ASPECT_HEIGHT;
  const cropWidth = crop.width * SOURCE_ASPECT_WIDTH;
  const cropHeight = crop.height * SOURCE_ASPECT_HEIGHT;
  const scale = Math.max(width / cropWidth, height / cropHeight);
  const renderedWidth = SOURCE_ASPECT_WIDTH * scale;
  const renderedHeight = SOURCE_ASPECT_HEIGHT * scale;
  const left = -cropX * scale + (width - cropWidth * scale) / 2;
  const top = -cropY * scale + (height - cropHeight * scale) / 2;

  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        width: renderedWidth,
        height: renderedHeight,
        maxWidth: "none",
      }}
    >
      <Img
        src={captureFrame(source.folder, sourceFrame)}
        style={{position: "absolute", inset: 0, width: "100%", height: "100%"}}
      />
      {language === "en" ? <CaptureEnglishLocalization /> : null}
    </div>
  );
};

const verticalDetailCrops: Record<BeatId, Crop> = {
  crisis: {x: 0.1875, y: 0.333333, width: 0.6125, height: 0.533333},
  product_definition: {x: 0.175, y: 0.277778, width: 0.65, height: 0.555556},
  goal: {x: 0.275, y: 0.344444, width: 0.4875, height: 0.466667},
  data_read: {x: 0.69375, y: 0.077778, width: 0.284375, height: 0.305556},
  space_read: {x: 0.175, y: 0.277778, width: 0.65, height: 0.555556},
  spatial_read: {x: 0.69375, y: 0.077778, width: 0.284375, height: 0.305556},
  collision_rejection: {x: 0.3, y: 0.3, width: 0.4, height: 0.4},
  safe_plan: {x: 0.175, y: 0.277778, width: 0.65, height: 0.555556},
  human_confirm: {x: 0.36875, y: 0.794444, width: 0.2625, height: 0.211111},
  // End above native y=950 so the lower evidence window shows the corridor,
  // not a clipped sliver of the viewport button that begins at y=956.
  response: {x: 0.16875, y: 0.333333, width: 0.675, height: 0.54},
  resolution: {x: 0.16875, y: 0.333333, width: 0.675, height: 0.54},
  editability: {x: 0.15625, y: 0.3, width: 0.6875, height: 0.577778},
  // Keep the final detail crop between the chart and viewport controls so the
  // identity card never exposes a clipped fragment of either UI surface.
  identity: {x: 0.16875, y: 0.333333, width: 0.675, height: 0.54},
};

const FilmShade = ({variant, strength = 0.74}: {variant: Variant; strength?: number}) => (
  <AbsoluteFill
    style={{
      pointerEvents: "none",
      background:
        variant === "landscape"
          ? `linear-gradient(90deg, rgba(3,8,14,${strength}) 0%, rgba(3,8,14,${strength * 0.62}) 27%, rgba(3,8,14,.08) 58%, rgba(3,8,14,0) 78%), linear-gradient(0deg, rgba(3,8,14,.58), rgba(3,8,14,0) 31%)`
          : "linear-gradient(180deg, rgba(3,8,14,.46), rgba(3,8,14,.05) 38%, rgba(3,8,14,.52))",
    }}
  />
);

const VerticalEvidenceBoard = ({
  beat,
  source,
  duration,
  language = "zh",
}: {
  beat: BeatId;
  source: SourceRange;
  duration: number;
  language?: Language;
}) => {
  const frame = useCurrentFrame();
  const sourceFrame = sourceFrameFor(frame, duration, source.fromFrame, source.toFrame);

  return (
    <AbsoluteFill style={{background: "#07111D", overflow: "hidden"}}>
      <Img
        src={captureFrame(source.folder, sourceFrame)}
        style={{
          position: "absolute",
          inset: -90,
          width: 1260,
          height: 2100,
          objectFit: "cover",
          filter: "blur(30px) brightness(.31) saturate(1.15)",
          transform: "scale(1.08)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 60,
          top: 390,
          width: 960,
          height: 540,
          overflow: "hidden",
          borderRadius: 34,
          outline: "1px solid rgba(255,255,255,.18)",
          boxShadow: "0 28px 90px rgba(0,0,0,.48)",
        }}
      >
        <SequenceImage source={source} duration={duration} language={language} />
      </div>
      <div
        style={{
          position: "absolute",
          left: 60,
          top: 970,
          width: 960,
          height: 500,
          overflow: "hidden",
          borderRadius: 34,
          outline: "1px solid rgba(255,255,255,.18)",
          boxShadow: "0 28px 90px rgba(0,0,0,.48)",
        }}
      >
        <CroppedSequenceImage
          source={source}
          duration={duration}
          crop={verticalDetailCrops[beat]}
          width={960}
          height={500}
          language={language}
        />
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "linear-gradient(180deg, rgba(0,0,0,0), rgba(0,0,0,.14))",
          }}
        />
      </div>
      <FilmShade variant="vertical" strength={0.6} />
    </AbsoluteFill>
  );
};

const WorldLayer = ({
  variant,
  beat,
  source,
  duration,
  shade = 0.72,
  language = "zh",
}: {
  variant: Variant;
  beat: BeatId;
  source: SourceRange;
  duration: number;
  shade?: number;
  language?: Language;
}) => {
  if (variant === "vertical") {
    return <VerticalEvidenceBoard beat={beat} source={source} duration={duration} language={language} />;
  }

  return (
    <AbsoluteFill style={{overflow: "hidden", background: "#07111D"}}>
      <SequenceImage
        source={source}
        duration={duration}
        language={language}
        style={{filter: "contrast(1.055) saturate(1.09) brightness(.98)"}}
      />
      <FilmShade variant="landscape" strength={shade} />
    </AbsoluteFill>
  );
};

const titleBounds = (variant: Variant): CSSProperties =>
  variant === "landscape"
    ? {left: 96, top: 84, width: 880, height: 180}
    : {left: 60, top: 145, width: 960, height: 190};

const proofBounds = (variant: Variant, side: "left" | "right" = "left"): CSSProperties => {
  if (variant === "vertical") {
    return {left: 60, top: 1580, width: 960, height: 90};
  }
  return side === "right"
    ? {left: 1068, top: 918, width: 756, height: 76}
    : {left: 96, top: 918, width: 880, height: 76};
};

const MotionTitle = ({
  variant,
  duration,
  tone = "paper",
  children,
  centered = false,
  language = "zh",
}: {
  variant: Variant;
  duration: number;
  tone?: Tone;
  children: ReactNode;
  centered?: boolean;
  language?: Language;
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({frame, fps, durationInFrames: TITLE_ENTER_FRAMES, config: {damping: 200}});
  const exit = interpolate(frame, [Math.max(1, duration - TITLE_EXIT_FRAMES), Math.max(2, duration - 1)], [1, 0], clamp);

  return (
    <div
      style={{
        position: "absolute",
        ...titleBounds(variant),
        display: "flex",
        alignItems: centered ? "center" : "flex-start",
        justifyContent: centered ? "center" : "flex-start",
        color: colors[tone],
        fontFamily: sans,
        fontSize: language === "en"
          ? variant === "landscape" ? 62 : 64
          : variant === "landscape" ? 68 : 72,
        fontWeight: 850,
        letterSpacing: language === "en"
          ? variant === "landscape" ? -2.2 : -1.7
          : variant === "landscape" ? -1.8 : -1.2,
        lineHeight: 1.08,
        textAlign: centered ? "center" : "left",
        textWrap: "balance",
        whiteSpace: "pre-line",
        textShadow: "0 6px 32px rgba(0,0,0,.92)",
        opacity: enter * exit,
        transform: `translateY(${(1 - enter) * 18}px)`,
      }}
    >
      {children}
    </div>
  );
};

const ProofChip = ({
  variant,
  duration,
  tone = "cyan",
  children,
  side = "left",
  language = "zh",
}: {
  variant: Variant;
  duration: number;
  tone?: Exclude<Tone, "paper">;
  children: ReactNode;
  side?: "left" | "right";
  language?: Language;
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({frame, fps, durationInFrames: PROOF_ENTER_FRAMES, config: {damping: 200}});
  const exit = interpolate(frame, [Math.max(1, duration - PROOF_EXIT_FRAMES), Math.max(2, duration - 1)], [1, 0], clamp);
  const toneColor = colors[tone];

  return (
    <div
      style={{
        position: "absolute",
        ...proofBounds(variant, side),
        display: "flex",
        alignItems: "center",
        justifyContent: side === "right" ? "flex-end" : "flex-start",
        opacity: enter * exit,
        transform: `translateY(${(1 - enter) * 10}px)`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: variant === "landscape" ? 13 : 16,
          maxWidth: "100%",
          minHeight: variant === "landscape" ? 54 : 70,
          padding: variant === "landscape" ? "10px 18px" : "11px 23px",
          boxSizing: "border-box",
          borderRadius: 999,
          background: "rgba(4,12,20,.88)",
          outline: `1px solid color-mix(in srgb, ${toneColor} 48%, transparent)`,
          boxShadow: "0 16px 44px rgba(0,0,0,.36)",
          color: "#F1F6F8",
          fontFamily: mono,
          fontSize: language === "en"
            ? variant === "landscape" ? 20 : 31
            : variant === "landscape" ? 21 : 36,
          fontWeight: 730,
          letterSpacing: variant === "landscape" ? 0.1 : -0.2,
          whiteSpace: "nowrap",
        }}
      >
        <span
          style={{
            width: variant === "landscape" ? 11 : 14,
            height: variant === "landscape" ? 11 : 14,
            borderRadius: "50%",
            flex: "0 0 auto",
            background: toneColor,
            boxShadow: `0 0 20px ${toneColor}`,
          }}
        />
        {children}
      </div>
    </div>
  );
};

const ScanSweep = ({variant, duration}: {variant: Variant; duration: number}) => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [0, Math.max(1, duration - 1)], [0, 1], {
    ...clamp,
    easing: Easing.inOut(Easing.sin),
  });
  if (variant === "vertical") {
    return (
      <div
        style={{
          position: "absolute",
          left: 90,
          top: 970 + progress * 430,
          width: 900,
          height: 3,
          background: "linear-gradient(90deg, transparent, #64D7FF 20%, #64D7FF 80%, transparent)",
          boxShadow: "0 0 20px rgba(100,215,255,.86)",
          opacity: Math.sin(progress * Math.PI),
        }}
      />
    );
  }
  return (
    <div
      style={{
        position: "absolute",
        left: 390 + progress * 820,
        top: 280,
        width: 3,
        height: 560,
        background: "linear-gradient(180deg, transparent, #64D7FF 18%, #64D7FF 82%, transparent)",
        boxShadow: "0 0 20px rgba(100,215,255,.82)",
        opacity: Math.sin(progress * Math.PI),
        transform: "rotate(17deg)",
      }}
    />
  );
};

const CollisionMark = ({variant, duration}: {variant: Variant; duration: number}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({frame, fps, delay: 15, durationInFrames: 16, config: {damping: 18, stiffness: 180}});
  const pulse = interpolate(frame % 24, [0, 12, 23], [0.72, 1, 0.72], clamp);
  const exit = interpolate(frame, [duration - 10, duration - 1], [1, 0], clamp);
  const box = variant === "landscape"
    ? {left: 760, top: 350, width: 470, height: 360}
    : {left: 250, top: 1000, width: 500, height: 450};

  return (
    <div
      style={{
        position: "absolute",
        ...box,
        borderRadius: 999,
        outline: `${Math.round(5 + pulse * 3)}px solid rgba(255,77,103,.96)`,
        boxShadow: "0 0 40px rgba(255,49,82,.62), inset 0 0 42px rgba(255,49,82,.18)",
        opacity: enter * exit,
        transform: `scale(${0.86 + enter * 0.14})`,
      }}
    >
      <div
        style={{
          position: "absolute",
          right: variant === "landscape" ? -18 : -22,
          top: variant === "landscape" ? -24 : -31,
          width: variant === "landscape" ? 70 : 86,
          height: variant === "landscape" ? 70 : 86,
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#FF4D67",
          color: "white",
          fontFamily: sans,
          fontSize: variant === "landscape" ? 48 : 62,
          fontWeight: 900,
          boxShadow: "0 12px 24px rgba(0,0,0,.48)",
        }}
      >
        ×
      </div>
    </div>
  );
};

const CheckPath = ({size}: {size: number}) => (
  <svg width={size} height={size} viewBox="0 0 32 32">
    <path
      d="M8 16.5l5.1 5.1L24.5 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const FiveSafeChecks = ({variant, duration}: {variant: Variant; duration: number}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const positions = variant === "landscape"
    ? [
        {left: 96, top: 300},
        {left: 162, top: 300},
        {left: 228, top: 300},
        {left: 294, top: 300},
        {left: 360, top: 300},
      ]
    : [
        {left: 82, top: 360},
        {left: 164, top: 360},
        {left: 246, top: 360},
        {left: 328, top: 360},
        {left: 410, top: 360},
      ];
  const exit = interpolate(frame, [duration - 9, duration - 1], [1, 0], clamp);

  return (
    <>
      {positions.map((position, index) => {
        const enter = spring({
          frame,
          fps,
          delay: 8 + index * 9,
          durationInFrames: 13,
          config: {damping: 17, stiffness: 190},
        });
        const size = variant === "landscape" ? 50 : 66;
        return (
          <div
            key={`${position.left}-${position.top}`}
            style={{
              position: "absolute",
              left: position.left,
              top: position.top,
              width: size,
              height: size,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#04120C",
              background: "#63F0A5",
              outline: "3px solid rgba(255,255,255,.84)",
              boxShadow: "0 0 18px rgba(99,240,165,.8)",
              opacity: enter * exit,
              transform: `scale(${enter})`,
            }}
          >
            <CheckPath size={size * 0.58} />
          </div>
        );
      })}
    </>
  );
};

const PointerClick = ({variant, duration}: {variant: Variant; duration: number}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  // The source capture performs the real click at response-frame 0045, exactly
  // where this confirmation beat hands off to the response beat. Keep the
  // synthetic cursor pulse within eight frames of that truthful boundary.
  const clickFrame = Math.max(0, duration - 8);
  // The captured control is viewport-bottom anchored at y=991 in the native
  // 1920x1080 source. The vertical value is that same point projected through
  // the normalized human-confirm detail crop.
  const center = variant === "landscape" ? {x: 960, y: 991} : {x: 540, y: 1262};
  const approach = interpolate(frame, [0, clickFrame], [0, 1], {
    ...clamp,
    easing: Easing.out(Easing.quad),
  });
  const ring = interpolate(frame, [clickFrame, Math.max(clickFrame + 1, duration - 1)], [0, 1], clamp);
  const cursorScale = spring({
    frame: frame - clickFrame,
    fps,
    durationInFrames: 12,
    config: {damping: 13, stiffness: 220},
  });
  const exit = interpolate(frame, [duration - 9, duration - 1], [1, 0], clamp);
  const startTip = variant === "landscape"
    ? {x: center.x + 82, y: center.y - 170}
    : {x: center.x + 210, y: center.y - 210};
  const tipX = interpolate(approach, [0, 1], [startTip.x, center.x]);
  const tipY = interpolate(approach, [0, 1], [startTip.y, center.y]);
  // The cursor path's tip is (8, 5). In landscape it is rotated around that
  // exact point, so the body grows upward while the tip still lands on the
  // native button and never crosses the 54px bottom safe area.
  const x = tipX - 8;
  const y = tipY - 5;

  return (
    <>
      {frame >= clickFrame ? (
        <div
          style={{
            position: "absolute",
            left: center.x,
            top: center.y,
            width: variant === "landscape" ? 54 : 170,
            height: variant === "landscape" ? 54 : 170,
            marginLeft: variant === "landscape" ? -27 : -85,
            marginTop: variant === "landscape" ? -27 : -85,
            borderRadius: "50%",
            outline: `${variant === "landscape" ? 4 : 8}px solid rgba(100,215,255,.95)`,
            boxShadow: "0 0 50px rgba(100,215,255,.88)",
            opacity: (1 - ring) * exit,
            transform: `scale(${variant === "landscape" ? 0.25 + ring * 0.75 : 0.22 + ring * 1.85})`,
          }}
        />
      ) : null}
      <svg
        width={variant === "landscape" ? 66 : 86}
        height={variant === "landscape" ? 82 : 108}
        viewBox="0 0 66 82"
        style={{
          position: "absolute",
          left: x,
          top: y,
          filter: "drop-shadow(0 7px 13px rgba(0,0,0,.72))",
          opacity: exit,
          transform: `${variant === "landscape" ? "rotate(180deg) " : ""}scale(${1 - cursorScale * 0.12})`,
          transformOrigin: "8px 5px",
        }}
      >
        <path
          d="M8 5L55 50L35 52L47 76L35 81L23 56L8 70Z"
          fill="#F7FBFF"
          stroke="#06101A"
          strokeWidth="4"
          strokeLinejoin="round"
        />
      </svg>
    </>
  );
};

const CrisisScene = ({variant, beat}: {variant: Variant; beat: Beat}) => (
  <AbsoluteFill>
    <WorldLayer variant={variant} beat={beat.id} source={beat.source} duration={beat.duration} shade={0.8} />
    <MotionTitle variant={variant} duration={beat.duration} tone="danger">
      28秒后，救护车到达
    </MotionTitle>
    <ProofChip variant={variant} duration={beat.duration} tone="danger">
      唯一通道已堵死
    </ProofChip>
  </AbsoluteFill>
);

const GoalScene = ({variant, beat}: {variant: Variant; beat: Beat}) => {
  const frame = useCurrentFrame();
  const typed = Math.floor(interpolate(frame, [2, 9], [0, 6], clamp));
  const goal = "打开急救通道".slice(0, typed);
  return (
    <AbsoluteFill>
      <WorldLayer variant={variant} beat={beat.id} source={beat.source} duration={beat.duration} shade={0.9} />
      <AbsoluteFill style={{background: "rgba(2,7,13,.42)"}} />
      <MotionTitle variant={variant} duration={beat.duration} tone="paper">
        {goal}<span style={{color: "#64D7FF"}}>｜</span>
      </MotionTitle>
      <ProofChip variant={variant} duration={beat.duration} tone="cyan">
        不能撞到任何东西
      </ProofChip>
    </AbsoluteFill>
  );
};

const SpatialReadScene = ({variant, beat}: {variant: Variant; beat: Beat}) => (
  <AbsoluteFill>
    <WorldLayer variant={variant} beat={beat.id} source={beat.source} duration={beat.duration} shade={0.66} />
    <ScanSweep variant={variant} duration={beat.duration} />
    <MotionTitle variant={variant} duration={beat.duration} tone="cyan">
      AI先读数据，再读空间
    </MotionTitle>
    <ProofChip variant={variant} duration={beat.duration} tone="cyan">
      调度快照 · 读取未改场景
    </ProofChip>
  </AbsoluteFill>
);

const CollisionScene = ({variant, beat}: {variant: Variant; beat: Beat}) => (
  <AbsoluteFill>
    <WorldLayer variant={variant} beat={beat.id} source={beat.source} duration={beat.duration} shade={0.7} />
    <CollisionMark variant={variant} duration={beat.duration} />
    <MotionTitle variant={variant} duration={beat.duration} tone="danger">
      这个位置会撞上街树
    </MotionTitle>
    <ProofChip variant={variant} duration={beat.duration} tone="danger">
      空间预检拒绝 · 修订未改变
    </ProofChip>
  </AbsoluteFill>
);

const SafePlanScene = ({variant, beat}: {variant: Variant; beat: Beat}) => (
  <AbsoluteFill>
    <WorldLayer variant={variant} beat={beat.id} source={beat.source} duration={beat.duration} shade={0.65} />
    <FiveSafeChecks variant={variant} duration={beat.duration} />
    <MotionTitle variant={variant} duration={beat.duration} tone="success">
      重新找到5个安全终点
    </MotionTitle>
    <ProofChip variant={variant} duration={beat.duration} tone="success">
      宿主预检 · 5/5通过
    </ProofChip>
  </AbsoluteFill>
);

const HumanConfirmScene = ({variant, beat}: {variant: Variant; beat: Beat}) => (
  <AbsoluteFill>
    <WorldLayer variant={variant} beat={beat.id} source={beat.source} duration={beat.duration} shade={0.58} />
    <MotionTitle variant={variant} duration={beat.duration} tone="paper">
      人只确认一次
    </MotionTitle>
    <ProofChip variant={variant} duration={beat.duration} tone="cyan" side={variant === "landscape" ? "right" : "left"}>
      真实按钮 · 等待一次确认
    </ProofChip>
    <PointerClick variant={variant} duration={beat.duration} />
  </AbsoluteFill>
);

const ResponseScene = ({variant, beat}: {variant: Variant; beat: Beat}) => {
  const titleDurations = variant === "landscape" ? [90, 75] : [70, 70];
  const secondFrom = titleDurations[0];
  return (
    <AbsoluteFill>
      <WorldLayer variant={variant} beat={beat.id} source={beat.source} duration={beat.duration} shade={0.48} />
      <Sequence from={0} durationInFrames={titleDurations[0]} premountFor={30}>
        <MotionTitle variant={variant} duration={titleDurations[0]} tone="cyan">
          一次点击，城市联动
        </MotionTitle>
      </Sequence>
      <Sequence from={secondFrom} durationInFrames={titleDurations[1]} premountFor={30}>
        <MotionTitle variant={variant} duration={titleDurations[1]} tone="success">
          车辆让路，信号切换
        </MotionTitle>
      </Sequence>
      <ProofChip variant={variant} duration={beat.duration} tone="success" side={variant === "landscape" ? "right" : "left"}>
        11个动作 · 1次原子提交
      </ProofChip>
    </AbsoluteFill>
  );
};

const ResolutionScene = ({variant, beat}: {variant: Variant; beat: Beat}) => (
  <AbsoluteFill>
    <WorldLayer variant={variant} beat={beat.id} source={beat.source} duration={beat.duration} shade={0.48} />
    <MotionTitle variant={variant} duration={beat.duration} tone="success">
      救护车抵达医院
    </MotionTitle>
    <ProofChip variant={variant} duration={beat.duration} tone="success" side={variant === "landscape" ? "right" : "left"}>
      0碰撞 · 通道已开
    </ProofChip>
  </AbsoluteFill>
);

const EditabilityWorld = ({
  variant,
  duration,
  phase,
  language = "zh",
}: {
  variant: Variant;
  duration: number;
  phase: "undo" | "redo" | "reopen";
  language?: Language;
}) => {
  const source: SourceRange = phase === "undo"
    ? {folder: "undo-redo-frames", fromFrame: 0, toFrame: 39}
    : phase === "redo"
      ? {folder: "undo-redo-frames", fromFrame: 40, toFrame: 89}
      : {folder: "reopen-frames", fromFrame: 0, toFrame: 89};
  return <WorldLayer variant={variant} beat="editability" source={source} duration={duration} shade={0.63} language={language} />;
};

const EditabilityScene = ({variant, beat}: {variant: Variant; beat: Beat}) => {
  const parts = variant === "landscape" ? [40, 40, 40] : [35, 35, 35];
  return (
    <AbsoluteFill>
      <Sequence from={0} durationInFrames={parts[0]} premountFor={30}>
        <EditabilityWorld variant={variant} duration={parts[0]} phase="undo" />
      </Sequence>
      <Sequence from={parts[0]} durationInFrames={parts[1]} premountFor={30}>
        <EditabilityWorld variant={variant} duration={parts[1]} phase="redo" />
      </Sequence>
      <Sequence from={parts[0] + parts[1]} durationInFrames={parts[2]} premountFor={30}>
        <EditabilityWorld variant={variant} duration={parts[2]} phase="reopen" />
      </Sequence>
      <MotionTitle variant={variant} duration={beat.duration} tone="paper">
        还能撤销、恢复和重开
      </MotionTitle>
      <ProofChip variant={variant} duration={beat.duration} tone="success">
        UNDO · REDO · SAVE/OPEN均通过
      </ProofChip>
    </AbsoluteFill>
  );
};

const IdentityScene = ({variant, beat}: {variant: Variant; beat: Beat}) => {
  return (
    <AbsoluteFill>
      <WorldLayer variant={variant} beat={beat.id} source={beat.source} duration={beat.duration} shade={0.82} />
      <AbsoluteFill style={{background: "rgba(2,8,13,.2)"}} />
      <MotionTitle variant={variant} duration={beat.duration} tone="cyan">
        让AI真正操作世界
      </MotionTitle>
      <ProofChip variant={variant} duration={beat.duration} tone="success">
        SEMAFRAME · OPEN SOURCE ON GITHUB
      </ProofChip>
    </AbsoluteFill>
  );
};

type V4SceneProps = {variant: Variant; beat: Beat; language: Language};

const V4CrisisScene = ({variant, beat, language}: V4SceneProps) => (
  <AbsoluteFill>
    <WorldLayer variant={variant} beat={beat.id} source={beat.source} duration={beat.duration} shade={0.8} language={language} />
    <MotionTitle variant={variant} duration={beat.duration} tone="danger" language={language}>
      {v4Copy[language].crisis.title}
    </MotionTitle>
    <ProofChip variant={variant} duration={beat.duration} tone="danger" language={language}>
      {v4Copy[language].crisis.proof}
    </ProofChip>
  </AbsoluteFill>
);

const ProductDefinitionScene = ({variant, beat, language}: V4SceneProps) => (
  <AbsoluteFill>
    <WorldLayer variant={variant} beat={beat.id} source={beat.source} duration={beat.duration} shade={0.72} language={language} />
    <EmergencyCityProductDefinitionSemanticAnchors
      variant={variant}
      duration={beat.duration}
      language={language}
    />
    <MotionTitle variant={variant} duration={beat.duration} tone="cyan" language={language}>
      {v4Copy[language].product_definition.title}
    </MotionTitle>
    <ProofChip variant={variant} duration={beat.duration} tone="cyan" language={language}>
      {v4Copy[language].product_definition.proof}
    </ProofChip>
  </AbsoluteFill>
);

const V4GoalScene = ({variant, beat, language}: V4SceneProps) => (
  <AbsoluteFill>
    <WorldLayer variant={variant} beat={beat.id} source={beat.source} duration={beat.duration} shade={0.9} language={language} />
    <AbsoluteFill style={{background: "rgba(2,7,13,.36)"}} />
    <MotionTitle variant={variant} duration={beat.duration} tone="paper" language={language}>
      {v4Copy[language].goal.title}
    </MotionTitle>
    <ProofChip variant={variant} duration={beat.duration} tone="cyan" language={language}>
      {v4Copy[language].goal.proof}
    </ProofChip>
  </AbsoluteFill>
);

const DataReadScene = ({variant, beat, language}: V4SceneProps) => (
  <AbsoluteFill>
    <WorldLayer variant={variant} beat={beat.id} source={beat.source} duration={beat.duration} shade={0.62} language={language} />
    <EmergencyCityDataLink variant={variant} duration={beat.duration} language={language} />
    <MotionTitle variant={variant} duration={beat.duration} tone="cyan" language={language}>
      {v4Copy[language].data_read.title}
    </MotionTitle>
    <ProofChip variant={variant} duration={beat.duration} tone="cyan" language={language}>
      {v4Copy[language].data_read.proof}
    </ProofChip>
  </AbsoluteFill>
);

const SpaceReadScene = ({variant, beat, language}: V4SceneProps) => (
  <AbsoluteFill>
    <WorldLayer variant={variant} beat={beat.id} source={beat.source} duration={beat.duration} shade={0.64} language={language} />
    <EmergencyCitySpatialLabels variant={variant} duration={beat.duration} language={language} />
    <MotionTitle variant={variant} duration={beat.duration} tone="cyan" language={language}>
      {v4Copy[language].space_read.title}
    </MotionTitle>
    <ProofChip variant={variant} duration={beat.duration} tone="cyan" language={language}>
      {v4Copy[language].space_read.proof}
    </ProofChip>
  </AbsoluteFill>
);

const V4CollisionScene = ({variant, beat, language}: V4SceneProps) => (
  <AbsoluteFill>
    <WorldLayer variant={variant} beat={beat.id} source={beat.source} duration={beat.duration} shade={0.7} language={language} />
    <CollisionMark variant={variant} duration={beat.duration} />
    <MotionTitle variant={variant} duration={beat.duration} tone="danger" language={language}>
      {v4Copy[language].collision_rejection.title}
    </MotionTitle>
    <ProofChip variant={variant} duration={beat.duration} tone="danger" language={language}>
      {v4Copy[language].collision_rejection.proof}
    </ProofChip>
  </AbsoluteFill>
);

const V4SafePlanScene = ({variant, beat, language}: V4SceneProps) => (
  <AbsoluteFill>
    <WorldLayer variant={variant} beat={beat.id} source={beat.source} duration={beat.duration} shade={0.64} language={language} />
    <FiveSafeChecks variant={variant} duration={beat.duration} />
    <MotionTitle variant={variant} duration={beat.duration} tone="success" language={language}>
      {v4Copy[language].safe_plan.title}
    </MotionTitle>
    <ProofChip variant={variant} duration={beat.duration} tone="success" language={language}>
      {v4Copy[language].safe_plan.proof}
    </ProofChip>
  </AbsoluteFill>
);

const V4HumanConfirmScene = ({variant, beat, language}: V4SceneProps) => (
  <AbsoluteFill>
    <WorldLayer variant={variant} beat={beat.id} source={beat.source} duration={beat.duration} shade={0.58} language={language} />
    <MotionTitle variant={variant} duration={beat.duration} tone="paper" language={language}>
      {v4Copy[language].human_confirm.title}
    </MotionTitle>
    <ProofChip variant={variant} duration={beat.duration} tone="cyan" side={variant === "landscape" ? "right" : "left"} language={language}>
      {v4Copy[language].human_confirm.proof}
    </ProofChip>
    <PointerClick variant={variant} duration={beat.duration} />
  </AbsoluteFill>
);

const V4ResponseScene = ({variant, beat, language}: V4SceneProps) => {
  const half = beat.duration / 2;
  return (
    <AbsoluteFill>
      <WorldLayer variant={variant} beat={beat.id} source={beat.source} duration={beat.duration} shade={0.46} language={language} />
      <EmergencyCityAtomicFanOut
        variant={variant}
        duration={beat.duration}
        commitFrame={0}
        language={language}
      />
      <Sequence from={0} durationInFrames={half} premountFor={30}>
        <MotionTitle variant={variant} duration={half} tone="cyan" language={language}>
          {v4Copy[language].response.title}
        </MotionTitle>
      </Sequence>
      <Sequence from={half} durationInFrames={half} premountFor={30}>
        <MotionTitle variant={variant} duration={half} tone="success" language={language}>
          {v4Copy[language].response.secondTitle}
        </MotionTitle>
      </Sequence>
      <ProofChip variant={variant} duration={beat.duration} tone="success" side={variant === "landscape" ? "right" : "left"} language={language}>
        {v4Copy[language].response.proof}
      </ProofChip>
    </AbsoluteFill>
  );
};

const V4ResolutionScene = ({variant, beat, language}: V4SceneProps) => (
  <AbsoluteFill>
    <WorldLayer variant={variant} beat={beat.id} source={beat.source} duration={beat.duration} shade={0.48} language={language} />
    <MotionTitle variant={variant} duration={beat.duration} tone="success" language={language}>
      {v4Copy[language].resolution.title}
    </MotionTitle>
    <ProofChip variant={variant} duration={beat.duration} tone="success" side={variant === "landscape" ? "right" : "left"} language={language}>
      {v4Copy[language].resolution.proof}
    </ProofChip>
  </AbsoluteFill>
);

const V4EditabilityScene = ({variant, beat, language}: V4SceneProps) => {
  const part = beat.duration / 3;
  return (
    <AbsoluteFill>
      <Sequence from={0} durationInFrames={part} premountFor={30}>
        <EditabilityWorld variant={variant} duration={part} phase="undo" language={language} />
      </Sequence>
      <Sequence from={part} durationInFrames={part} premountFor={30}>
        <EditabilityWorld variant={variant} duration={part} phase="redo" language={language} />
      </Sequence>
      <Sequence from={part * 2} durationInFrames={part} premountFor={30}>
        <EditabilityWorld variant={variant} duration={part} phase="reopen" language={language} />
      </Sequence>
      <EmergencyCityRevisionPersistenceCues variant={variant} duration={beat.duration} />
      <MotionTitle variant={variant} duration={beat.duration} tone="paper" language={language}>
        {v4Copy[language].editability.title}
      </MotionTitle>
      <ProofChip variant={variant} duration={beat.duration} tone="success" language={language}>
        {v4Copy[language].editability.proof}
      </ProofChip>
    </AbsoluteFill>
  );
};

const V4IdentityScene = ({variant, beat, language}: V4SceneProps) => (
  <AbsoluteFill>
    <WorldLayer variant={variant} beat={beat.id} source={beat.source} duration={beat.duration} shade={0.84} language={language} />
    <AbsoluteFill style={{background: "rgba(2,8,13,.22)"}} />
    <MotionTitle variant={variant} duration={beat.duration} tone="cyan" language={language}>
      {v4Copy[language].identity.title}
    </MotionTitle>
    <ProofChip variant={variant} duration={beat.duration} tone="success" language={language}>
      {v4Copy[language].identity.proof}
    </ProofChip>
  </AbsoluteFill>
);

const V4BeatScene = ({variant, beat, language}: V4SceneProps) => {
  switch (beat.id) {
    case "crisis":
      return <V4CrisisScene variant={variant} beat={beat} language={language} />;
    case "product_definition":
      return <ProductDefinitionScene variant={variant} beat={beat} language={language} />;
    case "goal":
      return <V4GoalScene variant={variant} beat={beat} language={language} />;
    case "data_read":
      return <DataReadScene variant={variant} beat={beat} language={language} />;
    case "space_read":
      return <SpaceReadScene variant={variant} beat={beat} language={language} />;
    case "collision_rejection":
      return <V4CollisionScene variant={variant} beat={beat} language={language} />;
    case "safe_plan":
      return <V4SafePlanScene variant={variant} beat={beat} language={language} />;
    case "human_confirm":
      return <V4HumanConfirmScene variant={variant} beat={beat} language={language} />;
    case "response":
      return <V4ResponseScene variant={variant} beat={beat} language={language} />;
    case "resolution":
      return <V4ResolutionScene variant={variant} beat={beat} language={language} />;
    case "editability":
      return <V4EditabilityScene variant={variant} beat={beat} language={language} />;
    case "identity":
      return <V4IdentityScene variant={variant} beat={beat} language={language} />;
    case "spatial_read":
      return <SpatialReadScene variant={variant} beat={beat} />;
  }
};

const BeatScene = ({variant, beat}: {variant: Variant; beat: Beat}) => {
  switch (beat.id) {
    case "crisis":
      return <CrisisScene variant={variant} beat={beat} />;
    case "goal":
      return <GoalScene variant={variant} beat={beat} />;
    case "spatial_read":
      return <SpatialReadScene variant={variant} beat={beat} />;
    case "collision_rejection":
      return <CollisionScene variant={variant} beat={beat} />;
    case "safe_plan":
      return <SafePlanScene variant={variant} beat={beat} />;
    case "human_confirm":
      return <HumanConfirmScene variant={variant} beat={beat} />;
    case "response":
      return <ResponseScene variant={variant} beat={beat} />;
    case "resolution":
      return <ResolutionScene variant={variant} beat={beat} />;
    case "editability":
      return <EditabilityScene variant={variant} beat={beat} />;
    case "identity":
      return <IdentityScene variant={variant} beat={beat} />;
  }
};

const withStarts = (beats: Beat[]) => {
  let from = 0;
  return beats.map((beat) => {
    const result = {...beat, from};
    from += beat.duration;
    return result;
  });
};

const OptionalScore = ({variant}: {variant: Variant}) => {
  const {fps, durationInFrames} = useVideoConfig();
  return (
    <Audio
      src={staticFile(
        variant === "vertical"
          ? "audio/semaframe-emergency-city-v3-vertical.wav"
          : "audio/semaframe-emergency-city-v3.wav",
      )}
      trimAfter={durationInFrames}
      volume={(frame) =>
        interpolate(
          frame,
          [0, Math.round(fps * 0.5), durationInFrames - fps, durationInFrames],
          [0, 0.42, 0.42, 0],
          clamp,
        )
      }
    />
  );
};

const EmergencyCityProofV3 = ({variant}: {variant: Variant}) => {
  const beats = variant === "landscape" ? landscapeBeats : verticalBeats;
  return (
    <AbsoluteFill style={{overflow: "hidden", background: "#07111D"}}>
      <OptionalScore variant={variant} />
      {withStarts(beats).map((beat) => (
        <Sequence
          key={beat.id}
          from={beat.from}
          durationInFrames={beat.duration}
          premountFor={30}
        >
          <BeatScene variant={variant} beat={beat} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

export const SemaFrameEmergencyCityProofV3 = () => (
  <EmergencyCityProofV3 variant="landscape" />
);

export const SemaFrameEmergencyCityProofV3Vertical = () => (
  <EmergencyCityProofV3 variant="vertical" />
);

const EmergencyCityProofV4 = ({variant, language}: {variant: Variant; language: Language}) => {
  const beats = variant === "landscape" ? v4LandscapeBeats : v4VerticalBeats;
  return (
    <AbsoluteFill style={{overflow: "hidden", background: "#07111D"}}>
      <OptionalScore variant={variant} />
      {withStarts(beats).map((beat) => (
        <Sequence
          key={beat.id}
          from={beat.from}
          durationInFrames={beat.duration}
          premountFor={30}
        >
          <V4BeatScene variant={variant} beat={beat} language={language} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

export const SemaFrameEmergencyCityProofV4 = () => (
  <EmergencyCityProofV4 variant="landscape" language="zh" />
);

export const SemaFrameEmergencyCityProofV4Vertical = () => (
  <EmergencyCityProofV4 variant="vertical" language="zh" />
);

export const SemaFrameEmergencyCityProofV4English = () => (
  <EmergencyCityProofV4 variant="landscape" language="en" />
);

export const SemaFrameEmergencyCityProofV4EnglishVertical = () => (
  <EmergencyCityProofV4 variant="vertical" language="en" />
);

const PosterProof = ({variant}: {variant: Variant}) => {
  const vertical = variant === "vertical";
  const source: SourceRange = {folder: "final-frames", fromFrame: 132, toFrame: 132};
  return (
    <AbsoluteFill style={{overflow: "hidden", background: "#07111D"}}>
      {vertical ? (
        <VerticalEvidenceBoard beat="identity" source={source} duration={1} />
      ) : (
        <>
          <SequenceImage source={source} duration={1} style={{filter: "contrast(1.055) saturate(1.1)"}} />
          <FilmShade variant="landscape" strength={0.88} />
        </>
      )}
      <div
        style={{
          position: "absolute",
          left: vertical ? 60 : 96,
          top: vertical ? 170 : 150,
          width: vertical ? 960 : 980,
          color: "#F7F8F6",
          fontFamily: sans,
          fontSize: vertical ? 82 : 82,
          fontWeight: 860,
          letterSpacing: -2.2,
          lineHeight: 1.08,
          textShadow: "0 7px 34px rgba(0,0,0,.94)",
        }}
      >
        AI为城市打开<br />一条生命通道
      </div>
      <div
        style={{
          position: "absolute",
          left: vertical ? 60 : 96,
          top: vertical ? 1580 : 908,
          padding: vertical ? "15px 24px" : "12px 20px",
          borderRadius: 999,
          background: "rgba(4,12,20,.9)",
          outline: "1px solid rgba(99,240,165,.48)",
          color: "#63F0A5",
          fontFamily: mono,
          fontSize: vertical ? 31 : 24,
          fontWeight: 760,
          boxShadow: "0 16px 44px rgba(0,0,0,.4)",
        }}
      >
        1次点击 · 11动作 · 0碰撞
      </div>
      <div
        style={{
          position: "absolute",
          right: vertical ? 60 : 96,
          bottom: vertical ? 190 : 62,
          color: "rgba(247,248,246,.82)",
          fontFamily: sans,
          fontSize: vertical ? 27 : 22,
          fontWeight: 830,
          letterSpacing: vertical ? 5.5 : 4.5,
        }}
      >
        SEMAFRAME
      </div>
    </AbsoluteFill>
  );
};

export const SemaFrameEmergencyCityProofV3Poster = () => (
  <PosterProof variant="landscape" />
);

export const SemaFrameEmergencyCityProofV3VerticalPoster = () => (
  <PosterProof variant="vertical" />
);

const PosterProofV4 = ({variant, language}: {variant: Variant; language: Language}) => {
  const vertical = variant === "vertical";
  const source: SourceRange = {folder: "final-frames", fromFrame: 132, toFrame: 132};
  const copy = language === "en"
    ? {
        title: <>AI can operate<br />a live 3D world</>,
        proof: "READ DATA · AVOID COLLISIONS · EDIT · UNDO",
      }
    : {
        title: <>AI真的能操作<br />3D世界了</>,
        proof: "读数据 · 避碰撞 · 改场景 · 可撤销",
      };
  return (
    <AbsoluteFill style={{overflow: "hidden", background: "#07111D"}}>
      {vertical ? (
        <VerticalEvidenceBoard beat="identity" source={source} duration={1} language={language} />
      ) : (
        <>
          <SequenceImage source={source} duration={1} language={language} style={{filter: "contrast(1.055) saturate(1.1)"}} />
          <FilmShade variant="landscape" strength={0.88} />
        </>
      )}
      <div
        style={{
          position: "absolute",
          left: vertical ? 60 : 96,
          top: vertical ? 170 : 150,
          width: vertical ? 960 : 1040,
          color: "#F7F8F6",
          fontFamily: sans,
          fontSize: vertical ? 82 : 82,
          fontWeight: 860,
          letterSpacing: -2.2,
          lineHeight: 1.08,
          textShadow: "0 7px 34px rgba(0,0,0,.94)",
        }}
      >
        {copy.title}
      </div>
      <div
        style={{
          position: "absolute",
          left: vertical ? 60 : 96,
          top: vertical ? 1580 : 908,
          padding: vertical ? "15px 24px" : "12px 20px",
          borderRadius: 999,
          background: "rgba(4,12,20,.9)",
          outline: "1px solid rgba(99,240,165,.48)",
          color: "#63F0A5",
          fontFamily: mono,
          fontSize: vertical ? 31 : 24,
          fontWeight: 760,
          boxShadow: "0 16px 44px rgba(0,0,0,.4)",
        }}
      >
        {copy.proof}
      </div>
      <div
        style={{
          position: "absolute",
          right: vertical ? 60 : 96,
          bottom: vertical ? 190 : 62,
          color: "rgba(247,248,246,.82)",
          fontFamily: sans,
          fontSize: vertical ? 27 : 22,
          fontWeight: 830,
          letterSpacing: vertical ? 5.5 : 4.5,
        }}
      >
        SEMAFRAME
      </div>
    </AbsoluteFill>
  );
};

export const SemaFrameEmergencyCityProofV4Poster = () => (
  <PosterProofV4 variant="landscape" language="zh" />
);

export const SemaFrameEmergencyCityProofV4VerticalPoster = () => (
  <PosterProofV4 variant="vertical" language="zh" />
);

export const SemaFrameEmergencyCityProofV4EnglishPoster = () => (
  <PosterProofV4 variant="landscape" language="en" />
);

export const SemaFrameEmergencyCityProofV4EnglishVerticalPoster = () => (
  <PosterProofV4 variant="vertical" language="en" />
);
