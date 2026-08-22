import {Audio} from "@remotion/media";
import React, {type CSSProperties, type ReactNode} from "react";
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
import {mono, sans} from "./theme";

const ROOT = "reality-twin";
const SOURCE_WIDTH = 1920;
const SOURCE_HEIGHT = 1080;
const clamp = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;

export const REALITY_TWIN_PROOF_V1_LANDSCAPE_DURATION = 960;
export const REALITY_TWIN_PROOF_V1_VERTICAL_DURATION = 900;

type Variant = "landscape" | "vertical";
type Tone = "paper" | "cyan" | "success" | "warning" | "danger";
type CaptureFolder =
  | "orbit-frames"
  | "import-frames"
  | "calibration-frames"
  | "verification-frames"
  | "spatial-read-frames"
  | "proxy-build-frames"
  | "proxy-edit-frames"
  | "export-frames"
  | "reopen-frames"
  | "final-frames";
type BeatId =
  | "hook"
  | "product"
  | "import"
  | "calibrate"
  | "verify"
  | "bounds"
  | "proxy"
  | "edit"
  | "export"
  | "persist"
  | "identity";

type SourceRange = Readonly<{
  folder: CaptureFolder;
  fromFrame: number;
  toFrame: number;
}>;

type Beat = Readonly<{
  id: BeatId;
  duration: number;
  source: SourceRange;
  secondarySource?: SourceRange;
}>;

type Crop = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

type BeatCopy = Readonly<{
  title: ReactNode;
  proof: string;
  titleTone?: Tone;
  proofTone?: Exclude<Tone, "paper">;
}>;

const colors: Record<Tone, string> = {
  paper: "#F7F8F6",
  cyan: "#64D7FF",
  success: "#63F0A5",
  warning: "#FFC568",
  danger: "#FF7373",
};

const landscapeBeats: readonly Beat[] = [
  {
    id: "hook",
    duration: 60,
    source: {folder: "orbit-frames", fromFrame: 0, toFrame: 47},
    secondarySource: {folder: "final-frames", fromFrame: 0, toFrame: 47},
  },
  {id: "product", duration: 60, source: {folder: "final-frames", fromFrame: 12, toFrame: 59}},
  {id: "import", duration: 90, source: {folder: "import-frames", fromFrame: 0, toFrame: 59}},
  {id: "calibrate", duration: 135, source: {folder: "calibration-frames", fromFrame: 0, toFrame: 89}},
  {id: "verify", duration: 90, source: {folder: "verification-frames", fromFrame: 0, toFrame: 59}},
  {id: "bounds", duration: 90, source: {folder: "spatial-read-frames", fromFrame: 0, toFrame: 59}},
  {id: "proxy", duration: 135, source: {folder: "proxy-build-frames", fromFrame: 0, toFrame: 89}},
  {id: "edit", duration: 105, source: {folder: "proxy-edit-frames", fromFrame: 0, toFrame: 89}},
  {id: "export", duration: 75, source: {folder: "export-frames", fromFrame: 0, toFrame: 59}},
  {id: "persist", duration: 60, source: {folder: "reopen-frames", fromFrame: 0, toFrame: 59}},
  {id: "identity", duration: 60, source: {folder: "final-frames", fromFrame: 0, toFrame: 59}},
] as const;

const verticalBeats: readonly Beat[] = [
  {
    id: "hook",
    duration: 60,
    source: {folder: "orbit-frames", fromFrame: 0, toFrame: 47},
    secondarySource: {folder: "final-frames", fromFrame: 0, toFrame: 47},
  },
  {id: "product", duration: 60, source: {folder: "final-frames", fromFrame: 12, toFrame: 59}},
  {id: "import", duration: 75, source: {folder: "import-frames", fromFrame: 0, toFrame: 59}},
  {id: "calibrate", duration: 120, source: {folder: "calibration-frames", fromFrame: 0, toFrame: 89}},
  {id: "verify", duration: 75, source: {folder: "verification-frames", fromFrame: 0, toFrame: 59}},
  {id: "bounds", duration: 75, source: {folder: "spatial-read-frames", fromFrame: 0, toFrame: 59}},
  {id: "proxy", duration: 120, source: {folder: "proxy-build-frames", fromFrame: 0, toFrame: 89}},
  {id: "edit", duration: 105, source: {folder: "proxy-edit-frames", fromFrame: 0, toFrame: 89}},
  {id: "export", duration: 75, source: {folder: "export-frames", fromFrame: 0, toFrame: 59}},
  {id: "persist", duration: 60, source: {folder: "reopen-frames", fromFrame: 0, toFrame: 59}},
  {id: "identity", duration: 75, source: {folder: "final-frames", fromFrame: 0, toFrame: 59}},
] as const;

const copy: Record<BeatId, BeatCopy> = {
  hook: {
    title: <>A real 3D scan.<br />Can an Agent work with it?</>,
    proof: "SMITHSONIAN MUSEUM SCAN · PREPARED OFFLINE",
    proofTone: "warning",
  },
  product: {
    title: <>SEMAFRAME LINKS SCANS<br />TO <span style={{color: colors.cyan}}>EDITABLE MODELS</span></>,
    proof: "AN AGENT-OPERABLE SPATIAL WORKSPACE",
    proofTone: "cyan",
  },
  import: {
    title: "Bring in the prepared museum scan",
    proof: "EXACT FILE VERIFIED · LOCAL BYTES READY",
    titleTone: "cyan",
    proofTone: "cyan",
  },
  calibrate: {
    title: "Pick two points. Enter one known length.",
    proof: "REAL CAPTURE RECEIPT · SETS REAL-WORLD SCALE",
    titleTone: "cyan",
    proofTone: "cyan",
  },
  verify: {
    title: "A second span checks the scale",
    proof: "DISTINCT A/B SESSION · LIVE CAPTURE RESULT",
    titleTone: "success",
    proofTone: "success",
  },
  bounds: {
    title: "Now the Agent can read scale and placement",
    proof: "SCALE · POSITION · SPATIAL RELATIONSHIPS",
    titleTone: "cyan",
    proofTone: "cyan",
  },
  proxy: {
    title: "The Agent creates an editable model around the scan",
    proof: "EXACT SI PROXY · HUMAN EDITABLE",
    titleTone: "success",
    proofTone: "success",
  },
  edit: {
    title: "Reusable. Collision-aware. Still editable.",
    proof: "LIVE WORKSPACE RECEIPTS · PROXY OWNS COLLISION",
    titleTone: "success",
    proofTone: "success",
  },
  export: {
    title: "Send the reusable case model to other 3D tools",
    proof: "OPENUSD USDA · CAPTURE EXCLUDED",
    titleTone: "cyan",
    proofTone: "cyan",
  },
  persist: {
    title: "Undo. Save. Reopen. Keep editing.",
    proof: "ONE REVISIONED WORKSPACE · LOCAL ASSET VAULT",
    proofTone: "success",
  },
  identity: {
    title: <>Real-world context.<br />Editable models for decisions.</>,
    proof: "SEMAFRAME · REALITY LINKED TO STRUCTURE",
    titleTone: "cyan",
    proofTone: "success",
  },
};

const detailCrops: Record<BeatId, Crop> = {
  hook: {x: 0.14, y: 0.12, width: 0.72, height: 0.72},
  product: {x: 0.14, y: 0.12, width: 0.72, height: 0.72},
  import: {x: 0.02, y: 0.12, width: 0.42, height: 0.76},
  calibrate: {x: 0.2, y: 0.16, width: 0.62, height: 0.68},
  verify: {x: 0.2, y: 0.16, width: 0.62, height: 0.68},
  bounds: {x: 0.53, y: 0.08, width: 0.45, height: 0.84},
  proxy: {x: 0.16, y: 0.14, width: 0.68, height: 0.72},
  edit: {x: 0.18, y: 0.14, width: 0.66, height: 0.72},
  export: {x: 0.52, y: 0.08, width: 0.46, height: 0.84},
  persist: {x: 0.12, y: 0.12, width: 0.76, height: 0.74},
  identity: {x: 0.14, y: 0.12, width: 0.72, height: 0.72},
};

const heroCrops: Record<"hook" | "product" | "identity", Crop> = {
  hook: {x: 0.24, y: 0.04, width: 0.58, height: 0.92},
  product: {x: 0.2, y: 0.04, width: 0.62, height: 0.92},
  identity: {x: 0.18, y: 0.04, width: 0.64, height: 0.92},
};

const heroBeats = new Set<BeatId>(["hook", "product", "identity"]);

const captureFrame = (folder: CaptureFolder, frame: number) =>
  staticFile(`${ROOT}/${folder}/frame-${String(frame).padStart(4, "0")}.jpg`);

const sourceFrameFor = (frame: number, duration: number, source: SourceRange) => {
  const mapped = Math.floor(interpolate(
    frame,
    [0, Math.max(1, duration - 1)],
    [source.fromFrame, source.toFrame],
    clamp,
  ));
  return Math.min(
    Math.max(mapped, Math.min(source.fromFrame, source.toFrame)),
    Math.max(source.fromFrame, source.toFrame),
  );
};

const CaptureImage = ({source, duration, style}: {
  source: SourceRange;
  duration: number;
  style?: CSSProperties;
}) => {
  const frame = useCurrentFrame();
  const sourceFrame = sourceFrameFor(frame, duration, source);
  return (
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
  );
};

const CroppedCaptureImage = ({source, duration, crop, width, height}: {
  source: SourceRange;
  duration: number;
  crop: Crop;
  width: number;
  height: number;
}) => {
  const frame = useCurrentFrame();
  const sourceFrame = sourceFrameFor(frame, duration, source);
  const cropX = crop.x * SOURCE_WIDTH;
  const cropY = crop.y * SOURCE_HEIGHT;
  const cropWidth = crop.width * SOURCE_WIDTH;
  const cropHeight = crop.height * SOURCE_HEIGHT;
  const scale = Math.max(width / cropWidth, height / cropHeight);
  return (
    <Img
      src={captureFrame(source.folder, sourceFrame)}
      style={{
        position: "absolute",
        left: -cropX * scale + (width - cropWidth * scale) / 2,
        top: -cropY * scale + (height - cropHeight * scale) / 2,
        width: SOURCE_WIDTH * scale,
        height: SOURCE_HEIGHT * scale,
        maxWidth: "none",
      }}
    />
  );
};

const transitionProgress = (frame: number, duration: number, enabled: boolean) => enabled
  ? interpolate(
    frame,
    [Math.round(duration * 0.4), Math.round(duration * 0.88)],
    [0, 1],
    {...clamp, easing: Easing.inOut(Easing.sin)},
  )
  : 0;

const CrossfadeCaptureImage = ({source, secondarySource, duration, style}: {
  source: SourceRange;
  secondarySource?: SourceRange;
  duration: number;
  style?: CSSProperties;
}) => {
  const frame = useCurrentFrame();
  const reveal = transitionProgress(frame, duration, secondarySource !== undefined);
  return (
    <>
      <CaptureImage source={source} duration={duration} style={{...style, opacity: 1 - reveal}} />
      {secondarySource ? (
        <CaptureImage source={secondarySource} duration={duration} style={{...style, opacity: reveal}} />
      ) : null}
    </>
  );
};

const CrossfadeCroppedCaptureImage = ({source, secondarySource, duration, crop, width, height}: {
  source: SourceRange;
  secondarySource?: SourceRange;
  duration: number;
  crop: Crop;
  width: number;
  height: number;
}) => {
  const frame = useCurrentFrame();
  const reveal = transitionProgress(frame, duration, secondarySource !== undefined);
  return (
    <>
      <div style={{position: "absolute", inset: 0, opacity: 1 - reveal}}>
        <CroppedCaptureImage source={source} duration={duration} crop={crop} width={width} height={height} />
      </div>
      {secondarySource ? (
        <div style={{position: "absolute", inset: 0, opacity: reveal}}>
          <CroppedCaptureImage source={secondarySource} duration={duration} crop={crop} width={width} height={height} />
        </div>
      ) : null}
    </>
  );
};

const FilmShade = ({variant}: {variant: Variant}) => (
  <AbsoluteFill
    style={{
      pointerEvents: "none",
      background: variant === "landscape"
        ? "linear-gradient(90deg,rgba(3,8,14,.82),rgba(3,8,14,.48) 34%,rgba(3,8,14,.08) 63%,rgba(3,8,14,0) 82%),linear-gradient(0deg,rgba(3,8,14,.65),rgba(3,8,14,0) 34%)"
        : "linear-gradient(180deg,rgba(3,8,14,.52),rgba(3,8,14,.05) 38%,rgba(3,8,14,.66))",
    }}
  />
);

const VerticalEvidenceBoard = ({beat, source, secondarySource, duration}: {
  beat: BeatId;
  source: SourceRange;
  secondarySource?: SourceRange;
  duration: number;
}) => {
  const hero = heroBeats.has(beat);
  return (
    <AbsoluteFill style={{overflow: "hidden", background: "#07111D"}}>
      <CrossfadeCaptureImage
        source={source}
        secondarySource={secondarySource}
        duration={duration}
        style={{
          filter: "blur(32px) brightness(.25) saturate(1.15)",
          transform: "scale(1.08)",
        }}
      />
      {hero ? (
        <div style={{
          position: "absolute",
          left: 60,
          top: 360,
          width: 880,
          height: 1040,
          overflow: "hidden",
          borderRadius: 34,
          outline: "1px solid rgba(255,255,255,.22)",
          boxShadow: "0 30px 96px rgba(0,0,0,.52)",
        }}>
          <CrossfadeCroppedCaptureImage
            source={source}
            secondarySource={secondarySource}
            duration={duration}
            crop={heroCrops[beat as "hook" | "product" | "identity"]}
            width={880}
            height={1040}
          />
        </div>
      ) : (
        <>
          <div style={{
            position: "absolute",
            left: 60,
            top: 360,
            width: 880,
            height: 495,
            overflow: "hidden",
            borderRadius: 30,
            outline: "1px solid rgba(255,255,255,.2)",
            boxShadow: "0 24px 72px rgba(0,0,0,.46)",
          }}>
            <CrossfadeCaptureImage source={source} secondarySource={secondarySource} duration={duration} />
          </div>
          <div style={{
            position: "absolute",
            left: 60,
            top: 890,
            width: 880,
            height: 460,
            overflow: "hidden",
            borderRadius: 30,
            outline: "1px solid rgba(255,255,255,.2)",
            boxShadow: "0 24px 72px rgba(0,0,0,.46)",
          }}>
            <CrossfadeCroppedCaptureImage
              source={source}
              secondarySource={secondarySource}
              duration={duration}
              crop={detailCrops[beat]}
              width={880}
              height={460}
            />
          </div>
        </>
      )}
      <FilmShade variant="vertical" />
    </AbsoluteFill>
  );
};

const WorldLayer = ({variant, beat, source, secondarySource, duration}: {
  variant: Variant;
  beat: BeatId;
  source: SourceRange;
  secondarySource?: SourceRange;
  duration: number;
}) => {
  const frame = useCurrentFrame();
  const progress = interpolate(
    frame,
    [0, Math.max(1, duration - 1)],
    [0, 1],
    {...clamp, easing: Easing.inOut(Easing.sin)},
  );
  const transform = variant === "landscape"
    ? `translate3d(${-12 * progress}px, ${-5 * progress}px, 0) scale(${1.008 + progress * 0.032})`
    : `translate3d(${4 - progress * 8}px, ${3 - progress * 6}px, 0) scale(${1.004 + progress * 0.018})`;

  if (variant === "vertical") {
    return (
      <AbsoluteFill style={{transform, transformOrigin: "50% 50%"}}>
        <VerticalEvidenceBoard
          beat={beat}
          source={source}
          secondarySource={secondarySource}
          duration={duration}
        />
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{overflow: "hidden", background: "#07111D", transform, transformOrigin: "50% 50%"}}>
      <CrossfadeCaptureImage
        source={source}
        secondarySource={secondarySource}
        duration={duration}
        style={{filter: "contrast(1.06) saturate(1.09) brightness(.98)"}}
      />
      <FilmShade variant="landscape" />
    </AbsoluteFill>
  );
};

const titleBounds = (variant: Variant): CSSProperties => variant === "landscape"
  ? {left: 96, top: 84, width: 1080, height: 220}
  : {left: 60, top: 132, width: 880, height: 205};

const proofBounds = (variant: Variant): CSSProperties => variant === "landscape"
  ? {left: 96, top: 916, width: 1230, height: 78}
  : {left: 60, top: 1480, width: 880, height: 90};

const MotionTitle = ({variant, duration, tone = "paper", children}: {
  variant: Variant;
  duration: number;
  tone?: Tone;
  children: ReactNode;
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({
    frame,
    fps,
    durationInFrames: Math.round(0.34 * fps),
    config: {damping: 200},
  });
  const exit = interpolate(
    frame,
    [Math.max(1, duration - Math.round(0.2 * fps)), Math.max(2, duration - 1)],
    [1, 0],
    clamp,
  );
  return (
    <div style={{
      position: "absolute",
      ...titleBounds(variant),
      color: colors[tone],
      fontFamily: sans,
      fontSize: variant === "landscape" ? 62 : 64,
      fontWeight: 870,
      letterSpacing: variant === "landscape" ? -2.2 : -1.8,
      lineHeight: 1.07,
      textWrap: "balance",
      textShadow: "0 7px 34px rgba(0,0,0,.94)",
      opacity: enter * exit,
      transform: `translateY(${(1 - enter) * 18}px)`,
    }}>
      {children}
    </div>
  );
};

const ProofChip = ({variant, duration, tone = "cyan", children}: {
  variant: Variant;
  duration: number;
  tone?: Exclude<Tone, "paper">;
  children: ReactNode;
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({
    frame,
    fps,
    durationInFrames: Math.round(0.28 * fps),
    config: {damping: 200},
  });
  const exit = interpolate(
    frame,
    [Math.max(1, duration - Math.round(0.16 * fps)), Math.max(2, duration - 1)],
    [1, 0],
    clamp,
  );
  const color = colors[tone];
  return (
    <div style={{
      position: "absolute",
      ...proofBounds(variant),
      display: "flex",
      alignItems: "center",
      opacity: enter * exit,
      transform: `translateY(${(1 - enter) * 10}px)`,
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: variant === "landscape" ? 13 : 16,
        maxWidth: "100%",
        minHeight: variant === "landscape" ? 54 : 74,
        padding: variant === "landscape" ? "10px 18px" : "12px 22px",
        boxSizing: "border-box",
        borderRadius: 999,
        background: "rgba(4,12,20,.9)",
        outline: `1px solid ${color}77`,
        boxShadow: "0 16px 44px rgba(0,0,0,.4)",
        color: "#F1F6F8",
        fontFamily: mono,
        fontSize: variant === "landscape" ? 18 : 27,
        fontWeight: 760,
        letterSpacing: -0.1,
        lineHeight: 1.18,
      }}>
        <span style={{
          width: variant === "landscape" ? 11 : 14,
          height: variant === "landscape" ? 11 : 14,
          borderRadius: "50%",
          flex: "0 0 auto",
          background: color,
          boxShadow: `0 0 20px ${color}`,
        }} />
        {children}
      </div>
    </div>
  );
};

const BoundaryNote = ({variant}: {variant: Variant}) => (
  <div
    data-truth-boundary="gaussian-visual-only"
    style={{
      position: "absolute",
      right: variant === "landscape" ? 96 : 140,
      top: variant === "vertical" ? 1600 : undefined,
      bottom: variant === "landscape" ? 54 : undefined,
      width: variant === "landscape" ? 900 : 880,
      color: "rgba(225,234,239,.74)",
      fontFamily: sans,
      fontSize: variant === "landscape" ? 14 : 18,
      fontWeight: 660,
      letterSpacing: 0.1,
      lineHeight: 1.25,
      textAlign: "right",
      textShadow: "0 3px 12px rgba(0,0,0,.95)",
    }}
  >
    SCAN = VISUAL ONLY · PROXY = EXACT GEOMETRY · NOT SURVEY OR CAD MEASUREMENT
  </div>
);

const EvidenceTag = ({variant, x, y, label, detail, tone = "cyan", align = "left"}: {
  variant: Variant;
  x: number;
  y: number;
  label: string;
  detail: string;
  tone?: Exclude<Tone, "paper">;
  align?: "left" | "right";
}) => {
  const scale = variant === "landscape" ? 1 : 0.5;
  const left = variant === "landscape" ? x : 60 + x * scale;
  const top = variant === "landscape" ? y : 370 + y * scale;
  const color = colors[tone];
  return (
    <div style={{
      position: "absolute",
      left,
      top,
      transform: align === "right" ? "translateX(-100%)" : undefined,
      minWidth: variant === "landscape" ? 190 : 160,
      padding: variant === "landscape" ? "9px 12px" : "8px 10px",
      borderRadius: 11,
      background: "rgba(4,12,20,.88)",
      outline: `1px solid ${color}88`,
      boxShadow: "0 12px 32px rgba(0,0,0,.42)",
      color: "#F7FAFC",
      fontFamily: sans,
      fontSize: variant === "landscape" ? 17 : 15,
      fontWeight: 800,
      lineHeight: 1.16,
      textAlign: align,
    }}>
      {label}
      <div style={{
        marginTop: 5,
        color,
        fontFamily: mono,
        fontSize: variant === "landscape" ? 11 : 10,
        fontWeight: 760,
        letterSpacing: 0.35,
      }}>
        {detail}
      </div>
    </div>
  );
};

const FadeOverlay = ({duration, delayFrames = 8, children}: {
  duration: number;
  delayFrames?: number;
  children: ReactNode;
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({
    frame,
    fps,
    delay: delayFrames,
    durationInFrames: Math.round(0.34 * fps),
    config: {damping: 200},
  });
  const exit = interpolate(frame, [Math.max(1, duration - 9), Math.max(2, duration - 1)], [1, 0], clamp);
  return <div style={{opacity: enter * exit}}>{children}</div>;
};

const CalibrationReceipt = ({variant, duration}: {variant: Variant; duration: number}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const segmentDuration = Math.ceil(duration / 3);
  const stage = Math.min(2, Math.floor(frame / segmentDuration));
  const stages = [
    {label: "PICK ON LIVE GAUSSIAN SURFACE", color: colors.cyan},
    {label: "REAL A/B PICK RECEIPT", color: colors.cyan},
    {label: "KNOWN LENGTH APPLIED IN THE APP", color: colors.success},
  ] as const;
  const active = stages[stage];
  const enter = spring({
    frame: frame - stage * segmentDuration,
    fps,
    durationInFrames: Math.round(0.26 * fps),
    config: {damping: 200},
  });
  const exit = interpolate(frame, [duration - 9, duration - 1], [1, 0], clamp);
  return (
    <div
      data-calibration-receipt="non-spatial-summary"
      data-calibration-stage={stage}
      style={{
        position: "absolute",
        left: variant === "landscape" ? 96 : 60,
        top: variant === "landscape" ? 734 : 1384,
        width: variant === "landscape" ? 510 : 880,
        minHeight: variant === "landscape" ? 66 : 58,
        boxSizing: "border-box",
        padding: variant === "landscape" ? "12px 16px" : "10px 14px",
        borderRadius: 12,
        background: "rgba(4,12,20,.92)",
        outline: `1px solid ${active.color}99`,
        boxShadow: "0 16px 42px rgba(0,0,0,.44)",
        color: active.color,
        fontFamily: mono,
        fontSize: variant === "landscape" ? 14 : 16,
        fontWeight: 800,
        letterSpacing: 0.25,
        opacity: enter * exit,
        transform: `translateY(${(1 - enter) * 8}px)`,
      }}
    >
      <span style={{color: "rgba(236,243,246,.74)", marginRight: 12}}>CAPTURE STAGE {stage + 1}/3</span>
      {active.label}
    </div>
  );
};

const VerificationOverlay = ({variant, duration}: {variant: Variant; duration: number}) => (
  <FadeOverlay duration={duration}>
    <EvidenceTag variant={variant} x={780} y={390} label="REFERENCE SPAN" detail="SETS METRIC SCALE" tone="cyan" />
    <EvidenceTag variant={variant} x={1340} y={650} label="SECOND SPAN" detail="DISTINCT VISIBLE PAIR" tone="success" align="right" />
  </FadeOverlay>
);

const BoundsOverlay = ({variant, duration}: {variant: Variant; duration: number}) => (
  <FadeOverlay duration={duration}>
    <div style={{
      position: "absolute",
      right: variant === "landscape" ? 112 : 140,
      top: variant === "landscape" ? 290 : 1000,
      width: variant === "landscape" ? 430 : 430,
      padding: variant === "landscape" ? "22px 24px" : "20px 22px",
      borderRadius: 18,
      background: "rgba(4,12,20,.91)",
      outline: "1px solid rgba(100,215,255,.52)",
      boxShadow: "0 22px 60px rgba(0,0,0,.5)",
      color: "#F6FAFC",
      fontFamily: mono,
    }}>
      <div style={{color: colors.cyan, fontSize: variant === "landscape" ? 15 : 18, fontWeight: 850, letterSpacing: 1.1}}>SAFE AGENT READBACK</div>
      {["CALIBRATION", "METRIC WORLD BOUNDS", "PROXY RELATIONS"].map((label) => (
        <div key={label} style={{display: "flex", alignItems: "center", gap: 12, marginTop: 16, fontSize: variant === "landscape" ? 17 : 20, fontWeight: 720}}>
          <span style={{width: 10, height: 10, borderRadius: "50%", background: colors.success, boxShadow: `0 0 14px ${colors.success}`}} />
          {label}
        </div>
      ))}
      <div style={{marginTop: 18, color: "rgba(226,236,241,.62)", fontFamily: sans, fontSize: variant === "landscape" ? 13 : 16, lineHeight: 1.35}}>
        No raw splats or pixels are exposed to the Agent.
      </div>
    </div>
  </FadeOverlay>
);

const ProxyOverlay = ({variant, duration}: {variant: Variant; duration: number}) => (
  <FadeOverlay duration={duration} delayFrames={12}>
    <EvidenceTag variant={variant} x={690} y={610} label="REAL SCAN" detail="VISUAL ONLY" tone="warning" />
    <EvidenceTag variant={variant} x={1330} y={500} label="EDITABLE MODEL" detail="EXACT SI PROXY" tone="success" align="right" />
  </FadeOverlay>
);

const EditOverlay = ({variant, duration}: {variant: Variant; duration: number}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  // proxy-edit-frames is a seven-state browser capture: baseline, publish,
  // rejected collision, corrected fit, numeric edit, Undo, and Redo. Drive the
  // summary from those source-frame boundaries so labels never run ahead of
  // the captured Workspace evidence.
  const sourceFrame = sourceFrameFor(frame, duration, {
    folder: "proxy-edit-frames",
    fromFrame: 0,
    toFrame: 89,
  });
  const stage = sourceFrame < 26 ? 0 : sourceFrame < 39 ? 1 : sourceFrame < 52 ? 2 : 3;
  const stageSourceStarts = [0, 26, 39, 52] as const;
  const stageStart = Math.round((stageSourceStarts[stage] / 89) * Math.max(1, duration - 1));
  const stages = [
    {text: "MODEL PUBLISHED", color: colors.cyan},
    {text: "COLLISION BLOCKED", color: colors.danger},
    {text: "FIT CORRECTED · 40 MM", color: colors.success},
    {text: "8 → 10 MM · UNDO / REDO", color: colors.success},
  ] as const;
  const active = stages[stage];
  const enter = spring({
    frame: frame - stageStart,
    fps,
    durationInFrames: Math.round(0.28 * fps),
    config: {damping: 200},
  });
  const exit = interpolate(frame, [duration - 9, duration - 1], [1, 0], clamp);
  return (
    <div
      data-collision-receipt="captured-workspace-summary"
      data-collision-stage={stage}
      style={{
      position: "absolute",
      left: variant === "landscape" ? 96 : 60,
      top: variant === "landscape" ? 720 : 1384,
      display: "flex",
      alignItems: "center",
      gap: 12,
      opacity: exit,
      }}
    >
      <div style={{
        color: "rgba(236,243,246,.78)",
        fontFamily: mono,
        fontSize: variant === "landscape" ? 13 : 15,
        fontWeight: 800,
        letterSpacing: 0.5,
      }}>
        CAPTURED WORKSPACE
      </div>
      <div style={{
          padding: variant === "landscape" ? "12px 16px" : "12px 14px",
          borderRadius: 10,
          background: "rgba(4,12,20,.9)",
          outline: `1px solid ${active.color}`,
          color: active.color,
          fontFamily: mono,
          fontSize: variant === "landscape" ? 16 : 18,
          fontWeight: 820,
          opacity: enter,
          transform: `translateY(${(1 - enter) * 10}px)`,
        }}>
        {active.text}
      </div>
    </div>
  );
};

const ExportOverlay = ({variant, duration}: {variant: Variant; duration: number}) => (
  <FadeOverlay duration={duration}>
    <div style={{
      position: "absolute",
      right: variant === "landscape" ? 110 : 140,
      top: variant === "landscape" ? 310 : 1010,
      width: variant === "landscape" ? 410 : 440,
      padding: "20px 22px",
      borderRadius: 16,
      background: "rgba(4,12,20,.92)",
      outline: "1px solid rgba(99,240,165,.56)",
      boxShadow: "0 22px 60px rgba(0,0,0,.5)",
      color: "#F6FAFC",
      fontFamily: mono,
    }}>
      <div style={{color: colors.success, fontSize: variant === "landscape" ? 18 : 21, fontWeight: 850}}>OPENUSD USDA</div>
      <div style={{marginTop: 12, fontSize: variant === "landscape" ? 15 : 18, fontWeight: 720}}>metersPerUnit = 1</div>
      <div style={{marginTop: 8, fontSize: variant === "landscape" ? 15 : 18, fontWeight: 720}}>upAxis = Y</div>
      <div style={{marginTop: 16, color: colors.warning, fontFamily: sans, fontSize: variant === "landscape" ? 13 : 16, fontWeight: 760, lineHeight: 1.32}}>
        PARAMETRIC CASE MODEL · CAPTURE EXCLUDED
      </div>
    </div>
  </FadeOverlay>
);

const PersistenceOverlay = ({variant, duration}: {variant: Variant; duration: number}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const labels = ["UNDO", "REDO", "SAVE", "REOPEN"];
  const exit = interpolate(frame, [duration - 8, duration - 1], [1, 0], clamp);
  return (
    <div style={{
      position: "absolute",
      left: variant === "landscape" ? 96 : 60,
      top: variant === "landscape" ? 730 : 1384,
      display: "flex",
      gap: variant === "landscape" ? 12 : 10,
      opacity: exit,
    }}>
      {labels.map((label, index) => {
        const enter = spring({
          frame,
          fps,
          delay: Math.round(index * duration * 0.18),
          durationInFrames: Math.round(0.3 * fps),
          config: {damping: 200},
        });
        return (
          <div key={label} style={{
            padding: variant === "landscape" ? "12px 16px" : "11px 13px",
            borderRadius: 10,
            background: "rgba(99,240,165,.14)",
            outline: `1px solid ${colors.success}`,
            color: colors.success,
            fontFamily: mono,
            fontSize: variant === "landscape" ? 16 : 18,
            fontWeight: 820,
            opacity: enter,
            transform: `translateY(${(1 - enter) * 9}px)`,
          }}>
            {label}
          </div>
        );
      })}
    </div>
  );
};

const BeatOverlay = ({beat, variant, duration}: {
  beat: BeatId;
  variant: Variant;
  duration: number;
}) => {
  switch (beat) {
    case "import":
      return (
        <FadeOverlay duration={duration}>
          <EvidenceTag variant={variant} x={660} y={630} label="GAUSSIAN REALITY" detail="FROM MUSEUM 3D SCAN" tone="cyan" />
        </FadeOverlay>
      );
    case "calibrate":
      return <CalibrationReceipt variant={variant} duration={duration} />;
    case "verify":
      return <VerificationOverlay variant={variant} duration={duration} />;
    case "bounds":
      return <BoundsOverlay variant={variant} duration={duration} />;
    case "proxy":
      return <ProxyOverlay variant={variant} duration={duration} />;
    case "edit":
      return <EditOverlay variant={variant} duration={duration} />;
    case "export":
      return <ExportOverlay variant={variant} duration={duration} />;
    case "persist":
      return <PersistenceOverlay variant={variant} duration={duration} />;
    default:
      return null;
  }
};

const BeatScene = ({beat, variant}: {beat: Beat; variant: Variant}) => {
  const item = copy[beat.id];
  return (
    <AbsoluteFill data-reality-twin-beat={beat.id} style={{overflow: "hidden", background: "#07111D"}}>
      <WorldLayer
        variant={variant}
        beat={beat.id}
        source={beat.source}
        secondarySource={beat.secondarySource}
        duration={beat.duration}
      />
      <BeatOverlay beat={beat.id} variant={variant} duration={beat.duration} />
      <MotionTitle variant={variant} duration={beat.duration} tone={item.titleTone}>
        {item.title}
      </MotionTitle>
      <ProofChip variant={variant} duration={beat.duration} tone={item.proofTone}>
        {item.proof}
      </ProofChip>
      <BoundaryNote variant={variant} />
    </AbsoluteFill>
  );
};

const withStarts = (beats: readonly Beat[]) => beats.reduce<Array<Beat & {from: number}>>((result, beat) => {
  const previous = result.at(-1);
  result.push({...beat, from: previous ? previous.from + previous.duration : 0});
  return result;
}, []);

const RealityTwinFilm = ({variant}: {variant: Variant}) => {
  const {fps, durationInFrames} = useVideoConfig();
  const beats = variant === "landscape" ? landscapeBeats : verticalBeats;
  return (
    <AbsoluteFill
      data-reality-twin-variant={variant}
      style={{overflow: "hidden", background: "#07111D"}}
    >
      <Audio
        src={staticFile("audio/semaframe-original-bed.wav")}
        volume={(frame) => interpolate(
          frame,
          [0, 1.5 * fps, durationInFrames - 2.2 * fps, durationInFrames],
          [0, 0.72, 0.72, 0],
          clamp,
        )}
      />
      {withStarts(beats).map((beat) => (
        <Sequence
          key={`${beat.id}-${beat.from}`}
          from={beat.from}
          durationInFrames={beat.duration}
          premountFor={fps}
        >
          <BeatScene beat={beat} variant={variant} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

export const SemaFrameRealityTwinProofV1 = () => (
  <RealityTwinFilm variant="landscape" />
);

export const SemaFrameRealityTwinProofV1Vertical = () => (
  <RealityTwinFilm variant="vertical" />
);

const RealityTwinPoster = ({variant}: {variant: Variant}) => {
  const vertical = variant === "vertical";
  const source: SourceRange = {folder: "final-frames", fromFrame: 42, toFrame: 42};
  return (
    <AbsoluteFill data-reality-twin-poster={variant} style={{overflow: "hidden", background: "#07111D"}}>
      {vertical ? (
        <VerticalEvidenceBoard beat="identity" source={source} duration={1} />
      ) : (
        <>
          <CaptureImage
            source={source}
            duration={1}
            style={{filter: "contrast(1.06) saturate(1.1) brightness(.98)"}}
          />
          <FilmShade variant="landscape" />
        </>
      )}
      <div style={{
        position: "absolute",
        left: vertical ? 60 : 96,
        top: vertical ? 132 : 138,
        width: vertical ? 880 : 1500,
        color: "#F7F8F6",
        fontFamily: sans,
        fontSize: vertical ? 68 : 76,
        fontWeight: 880,
        letterSpacing: -2.3,
        lineHeight: 1.06,
        textShadow: "0 7px 34px rgba(0,0,0,.95)",
      }}>
        A real scan.<br />
        {vertical ? <>An editable model<br />built around it.</> : <>An editable model built around it.</>}
      </div>
      <div style={{
        position: "absolute",
        left: vertical ? 60 : 96,
        top: vertical ? 1480 : 900,
        maxWidth: vertical ? 880 : 1150,
        padding: vertical ? "15px 22px" : "12px 20px",
        borderRadius: 999,
        background: "rgba(4,12,20,.91)",
        outline: "1px solid rgba(99,240,165,.56)",
        boxShadow: "0 16px 44px rgba(0,0,0,.42)",
        color: colors.success,
        fontFamily: mono,
        fontSize: vertical ? 29 : 23,
        fontWeight: 800,
      }}>
        MUSEUM SCAN · EDITABLE PROXY · OPENUSD
      </div>
      <div style={{
        position: "absolute",
        right: vertical ? 140 : 96,
        bottom: vertical ? 260 : 58,
        color: "rgba(247,248,246,.86)",
        fontFamily: sans,
        fontSize: vertical ? 27 : 22,
        fontWeight: 840,
        letterSpacing: vertical ? 5.5 : 4.5,
      }}>
        SEMAFRAME
      </div>
    </AbsoluteFill>
  );
};

export const SemaFrameRealityTwinProofV1Poster = () => (
  <RealityTwinPoster variant="landscape" />
);

export const SemaFrameRealityTwinProofV1VerticalPoster = () => (
  <RealityTwinPoster variant="vertical" />
);
