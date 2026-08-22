import {Audio} from "@remotion/media";
import React from "react";
import type {CSSProperties, ReactNode} from "react";
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
import {mono, sans} from "./theme";

const ROOT = "realityops";
const SOURCE_WIDTH = 1600;
const SOURCE_HEIGHT = 900;
const CAPTURED_FRAME_COUNT = 48;
const clamp = {extrapolateLeft: "clamp", extrapolateRight: "clamp"} as const;

export const REALITY_OPS_PROOF_V2_LANDSCAPE_DURATION = 1080;
export const REALITY_OPS_PROOF_V2_VERTICAL_DURATION = 960;

type Variant = "landscape" | "vertical";
type Locale = "zh-CN" | "en-US";
type Tone = "paper" | "danger" | "success" | "cyan";
type MotionFolder =
  | "immersive-room-frames"
  | "immersive-build-frames"
  | "immersive-collision-frames"
  | "immersive-correction-frames"
  | "immersive-control-frames"
  | "immersive-undo-redo-frames"
  | "immersive-final-frames";
type BeatId =
  | "need"
  | "product_definition"
  | "request"
  | "build"
  | "space_read"
  | "collision"
  | "atomic_rejection"
  | "correction"
  | "operate"
  | "persistence"
  | "export"
  | "identity";

type MotionSource = Readonly<{
  kind: "motion";
  folder: MotionFolder;
  fromFrame: number;
  toFrame: number;
}>;
type StillSource = Readonly<{kind: "still"; name: string}>;
type Source = MotionSource | StillSource;
type Beat = Readonly<{id: BeatId; duration: number; source: Source}>;
type Crop = Readonly<{x: number; y: number; width: number; height: number}>;

const landscapeBeats: readonly Beat[] = [
  {id: "need", duration: 60, source: {kind: "motion", folder: "immersive-final-frames", fromFrame: 0, toFrame: 15}},
  {id: "product_definition", duration: 75, source: {kind: "motion", folder: "immersive-final-frames", fromFrame: 5, toFrame: 24}},
  {id: "request", duration: 75, source: {kind: "motion", folder: "immersive-room-frames", fromFrame: 28, toFrame: 47}},
  {id: "build", duration: 105, source: {kind: "motion", folder: "immersive-build-frames", fromFrame: 0, toFrame: 47}},
  {id: "space_read", duration: 90, source: {kind: "motion", folder: "immersive-collision-frames", fromFrame: 0, toFrame: 20}},
  {id: "collision", duration: 90, source: {kind: "motion", folder: "immersive-collision-frames", fromFrame: 17, toFrame: 47}},
  {id: "atomic_rejection", duration: 75, source: {kind: "still", name: "04-collision-preflight.png"}},
  {id: "correction", duration: 105, source: {kind: "motion", folder: "immersive-correction-frames", fromFrame: 0, toFrame: 47}},
  {id: "operate", duration: 120, source: {kind: "motion", folder: "immersive-control-frames", fromFrame: 0, toFrame: 47}},
  {id: "persistence", duration: 105, source: {kind: "motion", folder: "immersive-undo-redo-frames", fromFrame: 0, toFrame: 47}},
  {id: "export", duration: 75, source: {kind: "still", name: "09-model-exports.png"}},
  {id: "identity", duration: 105, source: {kind: "motion", folder: "immersive-final-frames", fromFrame: 0, toFrame: 47}},
] as const;

const verticalBeats: readonly Beat[] = [
  {id: "need", duration: 45, source: {kind: "motion", folder: "immersive-final-frames", fromFrame: 0, toFrame: 15}},
  {id: "product_definition", duration: 60, source: {kind: "motion", folder: "immersive-final-frames", fromFrame: 5, toFrame: 24}},
  {id: "request", duration: 60, source: {kind: "motion", folder: "immersive-room-frames", fromFrame: 28, toFrame: 47}},
  {id: "build", duration: 90, source: {kind: "motion", folder: "immersive-build-frames", fromFrame: 0, toFrame: 47}},
  {id: "space_read", duration: 75, source: {kind: "motion", folder: "immersive-collision-frames", fromFrame: 0, toFrame: 20}},
  {id: "collision", duration: 75, source: {kind: "motion", folder: "immersive-collision-frames", fromFrame: 17, toFrame: 47}},
  {id: "atomic_rejection", duration: 60, source: {kind: "still", name: "04-collision-preflight.png"}},
  {id: "correction", duration: 90, source: {kind: "motion", folder: "immersive-correction-frames", fromFrame: 0, toFrame: 47}},
  {id: "operate", duration: 105, source: {kind: "motion", folder: "immersive-control-frames", fromFrame: 0, toFrame: 47}},
  {id: "persistence", duration: 90, source: {kind: "motion", folder: "immersive-undo-redo-frames", fromFrame: 0, toFrame: 47}},
  {id: "export", duration: 75, source: {kind: "still", name: "09-model-exports.png"}},
  {id: "identity", duration: 135, source: {kind: "motion", folder: "immersive-final-frames", fromFrame: 0, toFrame: 47}},
] as const;

const colors: Record<Tone, string> = {
  paper: "#F7F8F6",
  danger: "#FF5E76",
  success: "#63F0A5",
  cyan: "#64D7FF",
};

const sourcePath = (source: Source, frame: number, duration: number) => {
  if (source.kind === "still") return staticFile(`${ROOT}/${source.name}`);
  const mapped = Math.floor(
    interpolate(
      frame,
      [0, Math.max(1, duration - 1)],
      [source.fromFrame, source.toFrame],
      clamp,
    ),
  );
  const safeFrame = Math.min(CAPTURED_FRAME_COUNT - 1, Math.max(0, mapped));
  return staticFile(`${ROOT}/${source.folder}/frame-${String(safeFrame).padStart(4, "0")}.jpg`);
};

const SourceImage = ({source, duration, style}: {source: Source; duration: number; style?: CSSProperties}) => {
  const frame = useCurrentFrame();
  return (
    <Img
      src={sourcePath(source, frame, duration)}
      style={{position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", ...style}}
    />
  );
};

const detailCrops: Record<BeatId, Crop> = {
  need: {x: 0.08, y: 0.2, width: 0.82, height: 0.64},
  product_definition: {x: 0.08, y: 0.2, width: 0.82, height: 0.64},
  request: {x: 0.22, y: 0.3, width: 0.62, height: 0.52},
  build: {x: 0.02, y: 0.28, width: 0.56, height: 0.55},
  space_read: {x: 0.18, y: 0.28, width: 0.62, height: 0.55},
  collision: {x: 0.27, y: 0.27, width: 0.48, height: 0.52},
  atomic_rejection: {x: 0.27, y: 0.27, width: 0.48, height: 0.52},
  correction: {x: 0.38, y: 0.38, width: 0.54, height: 0.48},
  operate: {x: 0.38, y: 0.32, width: 0.56, height: 0.54},
  persistence: {x: 0.34, y: 0.32, width: 0.58, height: 0.55},
  export: {x: 0.53, y: 0.12, width: 0.46, height: 0.77},
  identity: {x: 0.08, y: 0.2, width: 0.82, height: 0.64},
};

const CroppedSourceImage = ({source, duration, crop}: {source: Source; duration: number; crop: Crop}) => {
  const frame = useCurrentFrame();
  const width = 960;
  const height = 500;
  const cropX = crop.x * SOURCE_WIDTH;
  const cropY = crop.y * SOURCE_HEIGHT;
  const cropWidth = crop.width * SOURCE_WIDTH;
  const cropHeight = crop.height * SOURCE_HEIGHT;
  const scale = Math.max(width / cropWidth, height / cropHeight);
  return (
    <Img
      src={sourcePath(source, frame, duration)}
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

const FilmShade = ({variant}: {variant: Variant}) => (
  <AbsoluteFill
    style={{
      pointerEvents: "none",
      background:
        variant === "landscape"
          ? "linear-gradient(90deg,rgba(3,8,14,.78),rgba(3,8,14,.45) 33%,rgba(3,8,14,.05) 64%,rgba(3,8,14,0) 82%),linear-gradient(0deg,rgba(3,8,14,.62),rgba(3,8,14,0) 35%)"
          : "linear-gradient(180deg,rgba(3,8,14,.5),rgba(3,8,14,.05) 36%,rgba(3,8,14,.6))",
    }}
  />
);

const VerticalEvidenceBoard = ({beat, source, duration}: {beat: BeatId; source: Source; duration: number}) => {
  const frame = useCurrentFrame();
  const image = sourcePath(source, frame, duration);
  return (
    <AbsoluteFill style={{overflow: "hidden", background: "#07111D"}}>
      <Img
        src={image}
        style={{position: "absolute", inset: -90, width: 1260, height: 2100, objectFit: "cover", filter: "blur(30px) brightness(.3) saturate(1.1)", transform: "scale(1.08)"}}
      />
      <div style={{position: "absolute", left: 60, top: 390, width: 960, height: 540, overflow: "hidden", borderRadius: 34, outline: "1px solid rgba(255,255,255,.18)", boxShadow: "0 28px 90px rgba(0,0,0,.48)"}}>
        <SourceImage source={source} duration={duration} />
      </div>
      <div style={{position: "absolute", left: 60, top: 970, width: 960, height: 500, overflow: "hidden", borderRadius: 34, outline: "1px solid rgba(255,255,255,.18)", boxShadow: "0 28px 90px rgba(0,0,0,.48)"}}>
        <CroppedSourceImage source={source} duration={duration} crop={detailCrops[beat]} />
      </div>
      <FilmShade variant="vertical" />
    </AbsoluteFill>
  );
};

const WorldLayer = ({variant, beat, source, duration}: {variant: Variant; beat: BeatId; source: Source; duration: number}) => {
  const frame = useCurrentFrame();
  const cameraProgress = interpolate(frame, [0, Math.max(1, duration - 1)], [0, 1], clamp);
  const cameraScale = variant === "landscape"
    ? 1.008 + cameraProgress * 0.04
    : 1.004 + cameraProgress * 0.022;
  const cameraTransform = variant === "landscape"
    ? `translate3d(${-12 * cameraProgress}px, ${-5 * cameraProgress}px, 0) scale(${cameraScale})`
    : `translate3d(${4 - 8 * cameraProgress}px, ${3 - 6 * cameraProgress}px, 0) scale(${cameraScale})`;
  if (variant === "vertical") {
    return (
      <AbsoluteFill style={{transform: cameraTransform, transformOrigin: "50% 50%"}}>
        <VerticalEvidenceBoard beat={beat} source={source} duration={duration} />
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{overflow: "hidden", background: "#07111D", transform: cameraTransform, transformOrigin: "50% 50%"}}>
      <SourceImage source={source} duration={duration} style={{filter: "contrast(1.06) saturate(1.08) brightness(.98)"}} />
      <FilmShade variant="landscape" />
    </AbsoluteFill>
  );
};

const titleBounds = (variant: Variant): CSSProperties =>
  variant === "landscape"
    ? {left: 96, top: 82, width: 1010, height: 210}
    : {left: 60, top: 140, width: 960, height: 210};

const proofBounds = (variant: Variant): CSSProperties =>
  variant === "landscape"
    ? {left: 96, top: 918, width: 1120, height: 76}
    : {left: 60, top: 1580, width: 960, height: 92};

const MotionTitle = ({variant, locale, duration, tone = "paper", children}: {variant: Variant; locale: Locale; duration: number; tone?: Tone; children: ReactNode}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({frame, fps, durationInFrames: Math.round(0.34 * fps), config: {damping: 200}});
  const exit = interpolate(frame, [Math.max(1, duration - Math.round(0.2 * fps)), Math.max(2, duration - 1)], [1, 0], clamp);
  return (
    <div
      style={{
        position: "absolute",
        ...titleBounds(variant),
        color: colors[tone],
        fontFamily: sans,
        fontSize: locale === "en-US"
          ? variant === "landscape" ? 58 : 62
          : variant === "landscape" ? 66 : 70,
        fontWeight: 880,
        letterSpacing: -1.5,
        lineHeight: 1.08,
        textWrap: "balance",
        textShadow: "0 6px 32px rgba(0,0,0,.94)",
        opacity: enter * exit,
        transform: `translateY(${(1 - enter) * 18}px)`,
      }}
    >
      {children}
    </div>
  );
};

const ProofChip = ({variant, locale, duration, tone = "cyan", delaySeconds = 0, children}: {variant: Variant; locale: Locale; duration: number; tone?: Exclude<Tone, "paper">; delaySeconds?: number; children: ReactNode}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({frame, fps, delay: Math.round(delaySeconds * fps), durationInFrames: Math.round(0.27 * fps), config: {damping: 200}});
  const exit = interpolate(frame, [Math.max(1, duration - Math.round(0.16 * fps)), Math.max(2, duration - 1)], [1, 0], clamp);
  const color = colors[tone];
  return (
    <div style={{position: "absolute", ...proofBounds(variant), display: "flex", alignItems: "center", opacity: enter * exit, transform: `translateY(${(1 - enter) * 10}px)`}}>
      <div style={{display: "flex", alignItems: "center", gap: variant === "landscape" ? 13 : 16, maxWidth: "100%", minHeight: variant === "landscape" ? 54 : 70, padding: variant === "landscape" ? "10px 18px" : "11px 23px", boxSizing: "border-box", borderRadius: 999, background: "rgba(4,12,20,.9)", outline: `1px solid ${color}77`, boxShadow: "0 16px 44px rgba(0,0,0,.38)", color: "#F1F6F8", fontFamily: mono, fontSize: locale === "en-US" ? variant === "landscape" ? 18 : 27 : variant === "landscape" ? 20 : 34, fontWeight: 740, letterSpacing: -0.1, lineHeight: 1.15, whiteSpace: locale === "en-US" ? "normal" : "nowrap"}}>
        <span style={{width: variant === "landscape" ? 11 : 14, height: variant === "landscape" ? 11 : 14, flex: "0 0 auto", borderRadius: "50%", background: color, boxShadow: `0 0 20px ${color}`}} />
        {children}
      </div>
    </div>
  );
};

const BoundaryNote = ({variant, locale}: {variant: Variant; locale: Locale}) => (
  <div style={{position: "absolute", right: variant === "landscape" ? 96 : 60, bottom: variant === "landscape" ? 58 : 190, width: variant === "landscape" ? 720 : 960, color: "rgba(225,234,239,.72)", fontFamily: sans, fontSize: variant === "landscape" ? 15 : 20, fontWeight: 650, letterSpacing: 0.15, lineHeight: 1.25, textAlign: "right", textShadow: "0 3px 12px rgba(0,0,0,.95)"}}>
    {locale === "en-US"
      ? "SYNTHETIC SCENE · DETERMINISTIC SNAPSHOT · BOUNDED PREFLIGHT, NOT CERTIFICATION"
      : "合成演示场景 · 遥测为确定性快照 · 有限物理预检非工程认证"}
  </div>
);

const sourcePoint = (variant: Variant, x: number, y: number) =>
  variant === "landscape"
    ? {x: x * 1.2, y: y * 1.2}
    : {x: 60 + x * 0.6, y: 390 + y * 0.6};

const SemanticTag = ({x, y, label, secondary, tone = "cyan", align = "left", variant}: {x: number; y: number; label: string; secondary: string; tone?: Exclude<Tone, "paper">; align?: "left" | "right"; variant: Variant}) => {
  const point = sourcePoint(variant, x, y);
  const color = colors[tone];
  return (
    <div style={{position: "absolute", left: point.x, top: point.y, transform: align === "right" ? "translateX(-100%)" : undefined, minWidth: variant === "landscape" ? 160 : 132, padding: variant === "landscape" ? "8px 11px" : "7px 9px", borderRadius: 10, background: "rgba(4,12,20,.86)", outline: `1px solid ${color}88`, boxShadow: "0 10px 30px rgba(0,0,0,.38)", color: "#F7FAFC", fontFamily: sans, fontSize: variant === "landscape" ? 16 : 14, fontWeight: 780, lineHeight: 1.15, textAlign: align}}>
      {label}
      <div style={{marginTop: 4, color, fontFamily: mono, fontSize: variant === "landscape" ? 11 : 10, fontWeight: 760, letterSpacing: 0.4}}>{secondary}</div>
    </div>
  );
};

const BuildOverlay = ({variant, locale, duration}: {variant: Variant; locale: Locale; duration: number}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({frame, fps, delay: Math.round(1.25 * fps), durationInFrames: Math.round(0.4 * fps), config: {damping: 200}});
  const exit = interpolate(frame, [duration - Math.round(0.35 * fps), duration - 1], [1, 0], clamp);
  return (
    <div style={{opacity: enter * exit}}>
      <SemanticTag variant={variant} x={470} y={540} label={locale === "en-US" ? "Backup pump skid" : "备用泵组"} secondary="ROOT + 7 EDITABLE PARTS" tone="cyan" />
      <SemanticTag variant={variant} x={845} y={475} label={locale === "en-US" ? "Service aisle" : "维修通道"} secondary="PROTECTED CLEARANCE" tone="success" />
    </div>
  );
};

const SpaceOverlay = ({variant, locale, duration}: {variant: Variant; locale: Locale; duration: number}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({frame, fps, delay: Math.round(0.32 * fps), durationInFrames: Math.round(0.34 * fps), config: {damping: 200}});
  const exit = interpolate(frame, [duration - Math.round(0.25 * fps), duration - 1], [1, 0], clamp);
  return (
    <div style={{opacity: enter * exit}}>
      <SemanticTag variant={variant} x={420} y={455} label={locale === "en-US" ? "Existing pump P-101" : "现有泵 P-101"} secondary="POSITION · BOUNDS" tone="cyan" />
      <SemanticTag variant={variant} x={835} y={520} label={locale === "en-US" ? "Service aisle" : "维修通道"} secondary="COLLIDER · RULE" tone="success" />
      <SemanticTag variant={variant} x={1450} y={160} label={locale === "en-US" ? "Vibration data" : "振动数据"} secondary="SOURCE SNAPSHOT" tone="cyan" align="right" />
    </div>
  );
};

const CollisionOverlay = ({variant, duration}: {variant: Variant; duration: number}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({frame, fps, delay: Math.round(0.35 * fps), durationInFrames: Math.round(0.42 * fps), config: {damping: 18, stiffness: 180}});
  const exit = interpolate(frame, [duration - Math.round(0.3 * fps), duration - 1], [1, 0], clamp);
  const center = sourcePoint(variant, 825, 555);
  const scale = variant === "landscape" ? 1.2 : 0.6;
  return (
    <div style={{position: "absolute", left: center.x, top: center.y, width: 350 * scale, height: 300 * scale, transform: `translate(-50%,-50%) scale(${0.86 + 0.14 * enter})`, borderRadius: 999, outline: `${variant === "landscape" ? 7 : 5}px solid rgba(255,77,103,.96)`, boxShadow: "0 0 42px rgba(255,49,82,.64), inset 0 0 38px rgba(255,49,82,.16)", opacity: enter * exit}}>
      <div style={{position: "absolute", right: -20, top: -24, width: variant === "landscape" ? 68 : 54, height: variant === "landscape" ? 68 : 54, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "50%", background: colors.danger, color: "white", fontFamily: sans, fontSize: variant === "landscape" ? 46 : 38, fontWeight: 900, boxShadow: "0 10px 26px rgba(0,0,0,.45)"}}>×</div>
    </div>
  );
};

const CorrectionOverlay = ({variant, locale, duration}: {variant: Variant; locale: Locale; duration: number}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({frame, fps, delay: Math.round((variant === "landscape" ? 2.3 : 1.9) * fps), durationInFrames: Math.round(0.38 * fps), config: {damping: 200}});
  const exit = interpolate(frame, [duration - Math.round(0.28 * fps), duration - 1], [1, 0], clamp);
  return (
    <div style={{opacity: enter * exit}}>
      <SemanticTag variant={variant} x={1190} y={675} label={locale === "en-US" ? "Backup pump instance" : "备用泵实例"} secondary="0 CONFLICTS" tone="success" align="right" />
    </div>
  );
};

const DataActionOverlay = ({variant, locale, duration}: {variant: Variant; locale: Locale; duration: number}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({frame, fps, delay: Math.round(0.35 * fps), durationInFrames: Math.round(0.4 * fps), config: {damping: 200}});
  const exit = interpolate(frame, [duration - Math.round(0.28 * fps), duration - 1], [1, 0], clamp);
  const chart = sourcePoint(variant, 1370, 175);
  const pump = sourcePoint(variant, 1110, 625);
  const button = sourcePoint(variant, 800, 805);
  const beacon = sourcePoint(variant, 960, 520);
  const line = (a: {x: number; y: number}, b: {x: number; y: number}, color: string, key: string) => (
    <line key={key} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={variant === "landscape" ? 3 : 2} strokeDasharray="10 8" />
  );
  return (
    <div style={{opacity: enter * exit}}>
      <svg style={{position: "absolute", inset: 0, width: "100%", height: "100%", filter: "drop-shadow(0 0 7px rgba(0,0,0,.8))"}}>
        {line(chart, pump, colors.cyan, "data")}
        {line(button, beacon, colors.success, "action")}
      </svg>
      <SemanticTag variant={variant} x={1450} y={170} label={locale === "en-US" ? "Vibration snapshot" : "振动数据快照"} secondary="DATA → 2D CHART" tone="cyan" align="right" />
      <SemanticTag variant={variant} x={790} y={780} label={locale === "en-US" ? "2D button" : "2D 按钮"} secondary="ACTION → 3D BEACON" tone="success" align="right" />
    </div>
  );
};

const PersistenceOverlay = ({variant, duration}: {variant: Variant; duration: number}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const labels = ["UNDO", "REDO", "SAVE", "REOPEN"];
  const revealFractions = [0.08, 0.32, 0.56, 0.76];
  const exit = interpolate(frame, [duration - Math.round(0.25 * fps), duration - 1], [1, 0], clamp);
  return (
    <div style={{position: "absolute", left: variant === "landscape" ? 96 : 60, top: variant === "landscape" ? 750 : 1495, display: "flex", gap: variant === "landscape" ? 12 : 10, opacity: exit}}>
      {labels.map((label, index) => {
        const delay = Math.round(revealFractions[index] * duration);
        const enter = spring({frame, fps, delay, durationInFrames: Math.round(0.34 * fps), config: {damping: 200}});
        const active = frame >= delay;
        return (
          <div key={label} style={{padding: variant === "landscape" ? "12px 16px" : "10px 13px", borderRadius: 10, background: active ? "rgba(99,240,165,.15)" : "rgba(4,12,20,.86)", outline: `1px solid ${active ? colors.success : "rgba(255,255,255,.2)"}`, color: active ? colors.success : "#DCE5EB", fontFamily: mono, fontSize: variant === "landscape" ? 17 : 18, fontWeight: 800, opacity: enter, transform: `translateY(${(1 - enter) * 8}px)`}}>{label}</div>
        );
      })}
    </div>
  );
};

const ProductAnchors = ({variant, locale, duration}: {variant: Variant; locale: Locale; duration: number}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({frame, fps, delay: Math.round(0.5 * fps), durationInFrames: Math.round(0.42 * fps), config: {damping: 200}});
  const exit = interpolate(frame, [duration - Math.round(0.25 * fps), duration - 1], [1, 0], clamp);
  return (
    <div style={{opacity: enter * exit}}>
      <SemanticTag variant={variant} x={410} y={500} label={locale === "en-US" ? "3D objects" : "3D 物体"} secondary="EDITABLE STATE" tone="cyan" />
      <SemanticTag variant={variant} x={1435} y={155} label={locale === "en-US" ? "2D data panel" : "2D 数据面板"} secondary="BOUND RESOURCE" tone="cyan" align="right" />
      <SemanticTag variant={variant} x={825} y={560} label={locale === "en-US" ? "Spatial rules" : "空间规则"} secondary="COLLISION + PHYSICS" tone="success" />
    </div>
  );
};

const BeatOverlay = ({beat, variant, locale, duration}: {beat: BeatId; variant: Variant; locale: Locale; duration: number}) => {
  switch (beat) {
    case "product_definition": return <ProductAnchors variant={variant} locale={locale} duration={duration} />;
    case "build": return <BuildOverlay variant={variant} locale={locale} duration={duration} />;
    case "space_read": return <SpaceOverlay variant={variant} locale={locale} duration={duration} />;
    case "collision":
    case "atomic_rejection": return <CollisionOverlay variant={variant} duration={duration} />;
    case "correction": return <CorrectionOverlay variant={variant} locale={locale} duration={duration} />;
    case "operate": return <DataActionOverlay variant={variant} locale={locale} duration={duration} />;
    case "persistence": return <PersistenceOverlay variant={variant} duration={duration} />;
    default: return null;
  }
};

type BeatCopy = Record<BeatId, {title: ReactNode; proof: string; titleTone?: Tone; proofTone?: Exclude<Tone, "paper">}>;

const copyZh: BeatCopy = {
  need: {title: "工厂要加一台备用泵", proof: "目标：不停机，也不能挡住维修通道", titleTone: "paper", proofTone: "cyan"},
  product_definition: {title: <>这是 <span style={{color: colors.cyan}}>SEMAFRAME</span></>, proof: "AI 可读、可操作的 2D + 3D 工作空间", titleTone: "paper", proofTone: "cyan"},
  request: {title: <>我把任务交给 Agent<br />“加一台泵，别挡住通道”</>, proof: "人定义任务 · Agent 执行可审查操作", titleTone: "paper", proofTone: "cyan"},
  build: {title: "Agent 用 7 个部件组成泵组", proof: "根节点 + 7 个部件 · 模型可复用", titleTone: "cyan", proofTone: "cyan"},
  space_read: {title: "再读懂房间里的每个对象", proof: "位置 · 尺寸 · 碰撞体 · 维修通道", titleTone: "cyan", proofTone: "cyan"},
  collision: {title: "第一个位置会堵住通道", proof: "检测到 1 个碰撞", titleTone: "danger", proofTone: "danger"},
  atomic_rejection: {title: <>所以这次变更<br />根本没有发生</>, proof: "REJECTED · 修订号保持 10", titleTone: "danger", proofTone: "danger"},
  correction: {title: "Agent 换一个位置，重新检查", proof: "0 冲突 · 有限物理可行", titleTone: "success", proofTone: "success"},
  operate: {title: <>数据和按钮<br />也能接进这个世界</>, proof: "振动数据快照 · 2D 按钮 → 3D 提示灯", titleTone: "cyan", proofTone: "success"},
  persistence: {title: <>人随时能撤销<br />保存后还能继续</>, proof: "UNDO · REDO · SAVE · REOPEN", titleTone: "paper", proofTone: "success"},
  export: {title: "泵组还能交给其他 3D 工具", proof: "仅发布泵组 · OpenUSD + STEP 已验证", titleTone: "success", proofTone: "success"},
  identity: {title: <>不是生成动画<br />而是在修改可编辑的 3D 世界</>, proof: "SEMAFRAME · AI 可操作的 2D + 3D 工作空间", titleTone: "cyan", proofTone: "success"},
};

const copyEn: BeatCopy = {
  need: {title: "The factory needs a backup pump", proof: "Goal: stay online and keep the service aisle clear", titleTone: "paper", proofTone: "cyan"},
  product_definition: {title: <>THIS IS <span style={{color: colors.cyan}}>SEMAFRAME</span></>, proof: "An AI-readable, AI-operable 2D + 3D workspace", titleTone: "paper", proofTone: "cyan"},
  request: {title: <>I ask the Agent:<br />“Add a pump. Keep the aisle clear.”</>, proof: "Human sets the goal · Agent makes reviewable edits", titleTone: "paper", proofTone: "cyan"},
  build: {title: "The Agent assembles a pump from 7 editable parts", proof: "Root + 7 parts · reusable model", titleTone: "cyan", proofTone: "cyan"},
  space_read: {title: "Then it reads every object in the room", proof: "Position · size · colliders · service clearance", titleTone: "cyan", proofTone: "cyan"},
  collision: {title: "The first placement blocks the aisle", proof: "1 collision detected", titleTone: "danger", proofTone: "danger"},
  atomic_rejection: {title: <>So the placement<br />is never committed</>, proof: "REJECTED · REVISION STAYS 10", titleTone: "danger", proofTone: "danger"},
  correction: {title: "The Agent moves it and checks again", proof: "0 conflicts · bounded physics feasible", titleTone: "success", proofTone: "success"},
  operate: {title: <>Data and controls<br />join the same world</>, proof: "Vibration snapshot · 2D button → 3D beacon", titleTone: "cyan", proofTone: "success"},
  persistence: {title: <>A person can undo,<br />save, and keep editing</>, proof: "UNDO · REDO · SAVE · REOPEN", titleTone: "paper", proofTone: "success"},
  export: {title: "The pump can move into other 3D tools", proof: "PUMP ONLY · VERIFIED OPENUSD + STEP", titleTone: "success", proofTone: "success"},
  identity: {title: <>Not a pre-rendered result.<br />An editable 3D world is changing.</>, proof: "SEMAFRAME · AN AI-OPERABLE 2D + 3D WORKSPACE", titleTone: "cyan", proofTone: "success"},
};

const BeatScene = ({beat, variant, locale}: {beat: Beat; variant: Variant; locale: Locale}) => {
  const frame = useCurrentFrame();
  const item = (locale === "en-US" ? copyEn : copyZh)[beat.id];
  const activeSource: Source = beat.id !== "persistence"
    ? beat.source
    : frame >= Math.round(beat.duration * 0.75)
      ? {kind: "still", name: "08-reopened.png"}
      : frame >= Math.round(beat.duration * 0.55)
        ? {kind: "still", name: "07-history.png"}
        : beat.source;
  const proofDelaySeconds = beat.id === "build"
    ? variant === "landscape" ? 1.8 : 1.5
    : beat.id === "correction"
      ? variant === "landscape" ? 2.3 : 1.9
      : 0;
  return (
    <AbsoluteFill style={{overflow: "hidden", background: "#07111D"}}>
      <WorldLayer variant={variant} beat={beat.id} source={activeSource} duration={beat.duration} />
      <BeatOverlay beat={beat.id} variant={variant} locale={locale} duration={beat.duration} />
      <MotionTitle variant={variant} locale={locale} duration={beat.duration} tone={item.titleTone}>{item.title}</MotionTitle>
      <ProofChip variant={variant} locale={locale} duration={beat.duration} tone={item.proofTone} delaySeconds={proofDelaySeconds}>{item.proof}</ProofChip>
      <BoundaryNote variant={variant} locale={locale} />
    </AbsoluteFill>
  );
};

const timelineFor = (beats: readonly Beat[]) => beats.reduce<Array<Beat & {from: number}>>((result, beat) => {
  const previous = result.at(-1);
  result.push({...beat, from: previous ? previous.from + previous.duration : 0});
  return result;
}, []);

const ProofFilm = ({variant, locale}: {variant: Variant; locale: Locale}) => {
  const {fps, durationInFrames} = useVideoConfig();
  const beats = variant === "landscape" ? landscapeBeats : verticalBeats;
  return (
    <AbsoluteFill style={{background: "#07111D"}}>
      <Audio
        src={staticFile("audio/semaframe-original-bed.wav")}
        volume={(frame) => interpolate(frame, [0, 1.5 * fps, durationInFrames - 2.2 * fps, durationInFrames], [0, 0.76, 0.76, 0], clamp)}
      />
      {timelineFor(beats).map((beat) => (
        <Sequence key={`${beat.id}-${beat.from}`} from={beat.from} durationInFrames={beat.duration} premountFor={fps}>
          <BeatScene beat={beat} variant={variant} locale={locale} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

export const SemaFrameRealityOpsProofV2 = () => <ProofFilm variant="landscape" locale="zh-CN" />;
export const SemaFrameRealityOpsProofV2Vertical = () => <ProofFilm variant="vertical" locale="zh-CN" />;
export const SemaFrameRealityOpsProofV2English = () => <ProofFilm variant="landscape" locale="en-US" />;
export const SemaFrameRealityOpsProofV2VerticalEnglish = () => <ProofFilm variant="vertical" locale="en-US" />;

const Poster = ({variant, locale}: {variant: Variant; locale: Locale}) => {
  const source: Source = {kind: "motion", folder: "immersive-final-frames", fromFrame: 10, toFrame: 10};
  if (variant === "vertical") {
    return (
      <AbsoluteFill style={{overflow: "hidden", background: "#07111D"}}>
        <VerticalEvidenceBoard beat="identity" source={source} duration={1} />
        <div style={{position: "absolute", left: 60, top: 138, width: 960, color: "#F7F8F6", fontFamily: sans, fontSize: locale === "en-US" ? 64 : 72, fontWeight: 880, lineHeight: 1.08, letterSpacing: -1.4, textShadow: "0 6px 32px rgba(0,0,0,.94)"}}>{locale === "en-US" ? "LET AN AGENT ADD A BACKUP PUMP" : "让 Agent 给工厂加一台泵"}</div>
        <div style={{position: "absolute", left: 60, top: 1568, width: 960, color: colors.cyan, fontFamily: sans, fontSize: locale === "en-US" ? 42 : 47, fontWeight: 820, lineHeight: 1.16, textShadow: "0 6px 28px rgba(0,0,0,.9)"}}>{locale === "en-US" ? "First it checks: will it block the aisle?" : "它先检查：会不会堵住通道？"}</div>
        <div style={{position: "absolute", left: 60, bottom: 190, color: "#DDE8EE", fontFamily: mono, fontSize: locale === "en-US" ? 24 : 28, fontWeight: 760}}>SEMAFRAME · {locale === "en-US" ? "AN AI-OPERABLE 2D + 3D WORKSPACE" : "AI 可操作的 2D + 3D 工作空间"}</div>
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{overflow: "hidden", background: "#07111D"}}>
      <SourceImage source={source} duration={1} style={{filter: "contrast(1.06) saturate(1.08) brightness(.92)"}} />
      <FilmShade variant="landscape" />
      <div style={{position: "absolute", left: 96, top: 126, width: 980, color: "#F7F8F6", fontFamily: sans, fontSize: locale === "en-US" ? 75 : 82, fontWeight: 880, lineHeight: 1.06, letterSpacing: -1.8, textShadow: "0 6px 32px rgba(0,0,0,.94)"}}>{locale === "en-US" ? <>LET AN AGENT ADD<br />A BACKUP PUMP</> : <>让 Agent 给工厂<br />加一台备用泵</>}</div>
      <div style={{position: "absolute", left: 96, top: 560, width: 920, color: colors.cyan, fontFamily: sans, fontSize: locale === "en-US" ? 43 : 47, fontWeight: 820, lineHeight: 1.16, textShadow: "0 6px 28px rgba(0,0,0,.9)"}}>{locale === "en-US" ? "First it checks: will it block the aisle?" : "它先检查：会不会堵住通道？"}</div>
      <div style={{position: "absolute", left: 96, bottom: 82, color: "#DDE8EE", fontFamily: mono, fontSize: locale === "en-US" ? 21 : 23, fontWeight: 760}}>SEMAFRAME · {locale === "en-US" ? "AN AI-OPERABLE 2D + 3D WORKSPACE" : "AI 可操作的 2D + 3D 工作空间"}</div>
    </AbsoluteFill>
  );
};

export const SemaFrameRealityOpsProofV2Poster = () => <Poster variant="landscape" locale="zh-CN" />;
export const SemaFrameRealityOpsProofV2VerticalPoster = () => <Poster variant="vertical" locale="zh-CN" />;
export const SemaFrameRealityOpsProofV2EnglishPoster = () => <Poster variant="landscape" locale="en-US" />;
export const SemaFrameRealityOpsProofV2VerticalEnglishPoster = () => <Poster variant="vertical" locale="en-US" />;
