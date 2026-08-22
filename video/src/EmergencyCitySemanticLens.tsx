import type {ReactNode} from "react";
import {AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig} from "remotion";
import {mono, sans} from "./theme";

export type EmergencyCitySemanticLensVariant = "landscape" | "vertical";
export type EmergencyCitySemanticLensLanguage = "zh" | "en";

export type EmergencyCitySemanticLensProps = {
  variant: EmergencyCitySemanticLensVariant;
  duration: number;
  language?: EmergencyCitySemanticLensLanguage;
};

export type EmergencyCityAtomicFanOutProps = EmergencyCitySemanticLensProps & {
  /** Local frame of the real pressed-event commit. Defaults to this sequence's first frame. */
  commitFrame?: number;
};

type Point = {x: number; y: number};
type Alignment = "start" | "end" | "middle";

type AnchorDatum = {
  anchor: Point;
  label: Point;
  align: Alignment;
  primary: string;
  secondary: string;
  color: string;
};

type AtomicGroup = {
  id: "moves" | "signals" | "route_states";
  label: string;
  detail: string;
  hub: Point;
  labelPoint: Point;
  labelAlign: Alignment;
  targets: readonly Point[];
};

const palette = {
  cyan: "#64D7FF",
  red: "#FF5E76",
  green: "#63F0A5",
  gold: "#F2C76E",
  paper: "#F4F8FA",
  shadow: "rgba(4,11,18,.92)",
} as const;

const clamp = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;

const LANDSCAPE_WIDTH = 1920;
const LANDSCAPE_HEIGHT = 1080;
const VERTICAL_WIDTH = 1080;
const VERTICAL_HEIGHT = 1920;

// Portrait V4 keeps the truthful 1920x1080 source in the 960x540 evidence
// board at x=60/y=390. Mapping through that board keeps every callout attached
// to the same captured object instead of inventing a second portrait layout.
const toVerticalEvidenceBoard = ({x, y}: Point): Point => ({
  x: 60 + x * 0.5,
  y: 390 + y * 0.5,
});

const pointFor = (variant: EmergencyCitySemanticLensVariant, point: Point): Point =>
  variant === "landscape" ? point : toVerticalEvidenceBoard(point);

const lineWidthFor = (variant: EmergencyCitySemanticLensVariant) =>
  variant === "landscape" ? 2 : 2.4;

const dimensionsFor = (variant: EmergencyCitySemanticLensVariant) =>
  variant === "landscape"
    ? {width: LANDSCAPE_WIDTH, height: LANDSCAPE_HEIGHT}
    : {width: VERTICAL_WIDTH, height: VERTICAL_HEIGHT};

const lerpPoint = (from: Point, to: Point, progress: number): Point => ({
  x: from.x + (to.x - from.x) * progress,
  y: from.y + (to.y - from.y) * progress,
});

const localDuration = (duration: number) => Math.max(2, Math.round(duration));

const exitOpacity = (frame: number, duration: number, fps: number) => {
  const safeDuration = localDuration(duration);
  const lastFrame = safeDuration - 1;
  const fadeFrames = Math.min(lastFrame, Math.max(4, Math.round(0.2 * fps)));
  const fadeStart = Math.max(0, lastFrame - fadeFrames);
  return interpolate(frame, [fadeStart, Math.max(fadeStart + 1, lastFrame)], [1, 0], clamp);
};

const revealProgress = (frame: number, fps: number, index = 0) => spring({
  frame: frame - Math.round(index * 0.11 * fps),
  fps,
  durationInFrames: Math.max(8, Math.round(0.5 * fps)),
  config: {damping: 200},
});

const labelFontSize = (variant: EmergencyCitySemanticLensVariant) =>
  variant === "landscape" ? 23 : 25;

const detailFontSize = (variant: EmergencyCitySemanticLensVariant) =>
  variant === "landscape" ? 15 : 17;

const leaderPath = (anchor: Point, label: Point, align: Alignment) => {
  const labelEdge = {
    x: label.x + (align === "start" ? -16 : align === "end" ? 16 : 0),
    y: label.y - 8,
  };
  const elbow = {
    x: anchor.x + (labelEdge.x - anchor.x) * 0.62,
    y: labelEdge.y,
  };
  return `M ${anchor.x} ${anchor.y} L ${elbow.x} ${elbow.y} L ${labelEdge.x} ${labelEdge.y}`;
};

const AnchorLabel = ({
  datum,
  progress,
  opacity,
  variant,
  coordinatesAreResolved = false,
}: {
  datum: AnchorDatum;
  progress: number;
  opacity: number;
  variant: EmergencyCitySemanticLensVariant;
  coordinatesAreResolved?: boolean;
}) => {
  const anchor = coordinatesAreResolved ? datum.anchor : pointFor(variant, datum.anchor);
  const label = coordinatesAreResolved ? datum.label : pointFor(variant, datum.label);
  const visibleText = interpolate(progress, [0.42, 1], [0, 1], clamp);
  const fontSize = labelFontSize(variant);
  const detailSize = detailFontSize(variant);
  const lineWidth = lineWidthFor(variant);

  return (
    <g opacity={opacity}>
      <path
        d={leaderPath(anchor, label, datum.align)}
        fill="none"
        stroke={datum.color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={lineWidth}
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={1 - progress}
      />
      <circle
        cx={anchor.x}
        cy={anchor.y}
        r={(variant === "landscape" ? 5 : 6) * progress}
        fill={datum.color}
      />
      <circle
        cx={anchor.x}
        cy={anchor.y}
        r={(variant === "landscape" ? 12 : 14) * progress}
        fill="none"
        stroke={datum.color}
        strokeOpacity={0.34}
        strokeWidth={lineWidth}
      />
      <text
        x={label.x}
        y={label.y}
        textAnchor={datum.align}
        fill={palette.paper}
        fontFamily={sans}
        fontSize={fontSize}
        fontWeight={760}
        letterSpacing={0.2}
        opacity={visibleText}
        paintOrder="stroke"
        stroke={palette.shadow}
        strokeLinejoin="round"
        strokeWidth={variant === "landscape" ? 7 : 8}
      >
        {datum.primary}
        <tspan
          x={label.x}
          dy={variant === "landscape" ? 25 : 29}
          fill={datum.color}
          fontFamily={mono}
          fontSize={detailSize}
          fontWeight={650}
          letterSpacing={1.15}
        >
          {datum.secondary}
        </tspan>
      </text>
    </g>
  );
};

const OverlaySvg = ({
  variant,
  children,
  title,
}: {
  variant: EmergencyCitySemanticLensVariant;
  children: ReactNode;
  title: string;
}) => {
  const {width, height} = dimensionsFor(variant);
  return (
    <AbsoluteFill style={{pointerEvents: "none", overflow: "hidden"}}>
      <svg
        aria-hidden="true"
        width="100%"
        height="100%"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <title>{title}</title>
        {children}
      </svg>
    </AbsoluteFill>
  );
};

export const EMERGENCY_CITY_SEMANTIC_EVIDENCE = Object.freeze({
  ambulance: Object.freeze({id: "AMB-07", capability: "movable"}),
  protectedTree: Object.freeze({id: "CMP_000070", label: "Street tree 3", capability: "collider"}),
  signal: Object.freeze({id: "CMP_000078", label: "Emergency red signal 1", capability: "switchable"}),
  dispatchSnapshot: Object.freeze({etaSeconds: 28, clearanceM: 1.6}),
  revisionHistory: Object.freeze({blocked: 12, open: 13, reopened: 14}),
});

const productDefinitionAnchors: readonly AnchorDatum[] = [
  {
    anchor: {x: 1552, y: 653},
    label: {x: 1740, y: 700},
    align: "end",
    primary: "对象 · AMB-07",
    secondary: "MOVABLE",
    color: palette.cyan,
  },
  {
    anchor: {x: 1310, y: 828},
    label: {x: 1000, y: 850},
    align: "end",
    primary: "规则 · 街树3",
    secondary: "COLLIDER",
    color: palette.cyan,
  },
  {
    anchor: {x: 1002, y: 381},
    label: {x: 790, y: 275},
    align: "end",
    primary: "动作 · 红灯1",
    secondary: "SWITCHABLE",
    color: palette.cyan,
  },
] as const;

const productDefinitionPrimaryEnglish = [
  "OBJECT · AMB-07",
  "RULE · STREET TREE 3",
  "ACTION · RED SIGNAL 1",
] as const;

const productDefinitionAnchorsFor = (language: EmergencyCitySemanticLensLanguage) =>
  language === "en"
    ? productDefinitionAnchors.map((datum, index) => ({
        ...datum,
        primary: productDefinitionPrimaryEnglish[index],
      }))
    : productDefinitionAnchors;

/** Three scene-native anchors that define the product as objects, rules, and actions. */
export const EmergencyCityProductDefinitionSemanticAnchors = ({
  variant,
  duration,
  language = "zh",
}: EmergencyCitySemanticLensProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const exit = exitOpacity(frame, duration, fps);
  const anchors = productDefinitionAnchorsFor(language);

  return (
    <OverlaySvg variant={variant} title="AI-readable city objects, rules, and actions">
      {anchors.map((datum, index) => {
        const progress = revealProgress(frame, fps, index);
        return (
          <AnchorLabel
            key={datum.primary}
            datum={datum}
            progress={progress}
            opacity={progress * exit}
            variant={variant}
          />
        );
      })}
    </OverlaySvg>
  );
};

/** Short alias for V4 identity/reveal sequences. */
export const EmergencyCitySemanticLens = EmergencyCityProductDefinitionSemanticAnchors;

const dataChartAnchor = {x: 1458, y: 292};
const dataRoadAnchor = {x: 1035, y: 556};
const dataAmbulanceAnchor = {x: 1535, y: 655};

const dataLabels: readonly AnchorDatum[] = [
  {
    anchor: dataChartAnchor,
    label: {x: 1350, y: 188},
    align: "end",
    primary: "调度快照 · ETA 28s",
    secondary: "SOURCE DATA",
    color: palette.cyan,
  },
  {
    anchor: dataRoadAnchor,
    label: {x: 830, y: 680},
    align: "end",
    primary: "通道净宽 · 1.6m",
    secondary: "PLANNER CONSTRAINT",
    color: palette.cyan,
  },
] as const;

const dataPrimaryEnglish = [
  "DISPATCH SNAPSHOT · ETA 28s",
  "ROAD CLEARANCE · 1.6m",
] as const;

const dataLabelsFor = (language: EmergencyCitySemanticLensLanguage) =>
  language === "en"
    ? dataLabels.map((datum, index) => ({...datum, primary: dataPrimaryEnglish[index]}))
    : dataLabels;

/** Shows the real deterministic dispatch snapshot beside the road and ambulance planning context. */
export const EmergencyCityDataLink = ({variant, duration, language = "zh"}: EmergencyCitySemanticLensProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const exit = exitOpacity(frame, duration, fps);
  const chart = pointFor(variant, dataChartAnchor);
  const road = pointFor(variant, dataRoadAnchor);
  const ambulance = pointFor(variant, dataAmbulanceAnchor);
  const linkProgress = spring({
    frame,
    fps,
    durationInFrames: Math.max(10, Math.round(0.8 * fps)),
    config: {damping: 200},
  });
  const firstLegProgress = interpolate(linkProgress, [0, 0.56], [0, 1], clamp);
  const secondLegProgress = interpolate(linkProgress, [0.56, 1], [0, 1], clamp);
  const movingPoint = linkProgress < 0.56
    ? lerpPoint(chart, road, firstLegProgress)
    : lerpPoint(road, ambulance, secondLegProgress);
  const lineWidth = lineWidthFor(variant);
  const labels = dataLabelsFor(language);

  return (
    <OverlaySvg variant={variant} title="Dispatch snapshot read with road and ambulance planning context">
      <g opacity={exit}>
        <path
          d={`M ${chart.x} ${chart.y} L ${road.x} ${road.y} L ${ambulance.x} ${ambulance.y}`}
          fill="none"
          stroke={palette.cyan}
          strokeOpacity={0.88}
          strokeWidth={lineWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - linkProgress}
        />
        {[chart, road, ambulance].map((point, index) => (
          <circle
            key={`${point.x}-${point.y}`}
            cx={point.x}
            cy={point.y}
            r={(variant === "landscape" ? 5 : 6) * Math.max(0, linkProgress - index * 0.12)}
            fill={palette.cyan}
          />
        ))}
        <circle
          cx={movingPoint.x}
          cy={movingPoint.y}
          r={variant === "landscape" ? 8 : 10}
          fill={palette.paper}
          opacity={interpolate(linkProgress, [0, 0.08, 0.94, 1], [0, 1, 1, 0], clamp)}
        />
      </g>
      {labels.map((datum, index) => {
        const progress = revealProgress(frame, fps, index + 1);
        return (
          <AnchorLabel
            key={datum.primary}
            datum={datum}
            progress={progress}
            opacity={progress * exit}
            variant={variant}
          />
        );
      })}
    </OverlaySvg>
  );
};

const spatialLabels: readonly AnchorDatum[] = [
  {
    anchor: {x: 1535, y: 652},
    label: {x: 1740, y: 720},
    align: "end",
    primary: "对象 · AMB-07",
    secondary: "MOVABLE · WORLD3D",
    color: palette.cyan,
  },
  {
    anchor: {x: 1310, y: 828},
    label: {x: 1000, y: 850},
    align: "end",
    primary: "碰撞体 · 街树3",
    secondary: "PROTECTED COLLIDER",
    color: palette.red,
  },
  {
    anchor: {x: 1002, y: 370},
    label: {x: 790, y: 270},
    align: "end",
    primary: "声明动作 · 红灯1",
    secondary: "SWITCHABLE",
    color: palette.cyan,
  },
] as const;

const spatialPrimaryEnglish = [
  "OBJECT · AMB-07",
  "COLLIDER · STREET TREE 3",
  "DECLARED ACTION · RED SIGNAL 1",
] as const;

const spatialLabelsFor = (
  language: EmergencyCitySemanticLensLanguage,
  variant: EmergencyCitySemanticLensVariant,
) => language === "en"
  ? spatialLabels.map((datum, index) => ({
      ...datum,
      primary: spatialPrimaryEnglish[index],
      // The English declared-action label is much wider than its Chinese
      // equivalent. Shift only the portrait label in source coordinates so
      // its resolved left edge remains inside the 60px delivery safe area.
      label: variant === "vertical" && index === 2 ? {...datum.label, x: 1100} : datum.label,
    }))
  : spatialLabels;

/** Object, collider, and declared-action labels over the overhead spatial read. */
export const EmergencyCitySpatialLabels = ({variant, duration, language = "zh"}: EmergencyCitySemanticLensProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const exit = exitOpacity(frame, duration, fps);
  const labels = spatialLabelsFor(language, variant);
  const progresses = labels.map((_, index) => revealProgress(frame, fps, index));
  const ambulance = pointFor(variant, labels[0].anchor);
  const tree = pointFor(variant, labels[1].anchor);
  const signal = pointFor(variant, labels[2].anchor);
  const scale = variant === "landscape" ? 1 : 0.5;
  const lineWidth = lineWidthFor(variant);

  return (
    <OverlaySvg variant={variant} title="Movable object, protected collider, and switchable signal">
      <g fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={exit}>
        <rect
          x={ambulance.x - 78 * scale}
          y={ambulance.y - 50 * scale}
          width={156 * scale}
          height={100 * scale}
          rx={10 * scale}
          stroke={palette.cyan}
          strokeWidth={lineWidth}
          strokeDasharray={`${12 * scale} ${8 * scale}`}
          opacity={0.8 * progresses[0]}
        />
        <ellipse
          cx={tree.x}
          cy={tree.y}
          rx={58 * scale}
          ry={68 * scale}
          stroke={palette.red}
          strokeWidth={lineWidth + 0.7}
          opacity={0.9 * progresses[1]}
        />
        <circle
          cx={signal.x}
          cy={signal.y}
          r={29 * scale}
          stroke={palette.cyan}
          strokeWidth={lineWidth}
          opacity={0.82 * progresses[2]}
        />
      </g>
      {labels.map((datum, index) => (
        <AnchorLabel
          key={datum.primary}
          datum={datum}
          progress={progresses[index]}
          opacity={progresses[index] * exit}
          variant={variant}
        />
      ))}
    </OverlaySvg>
  );
};

export const EMERGENCY_CITY_ATOMIC_FAN_OUT_EVIDENCE = Object.freeze({
  moves: 5,
  signals: 4,
  routeStates: 2,
  totalTargets: 11,
  commitMode: "atomic",
});

const fanOutSource = {x: 960, y: 991};

const atomicGroups: readonly AtomicGroup[] = [
  {
    id: "moves",
    label: "5个移动",
    detail: "AMBULANCE + 4 BLOCKERS",
    hub: {x: 900, y: 700},
    labelPoint: {x: 635, y: 700},
    labelAlign: "end",
    targets: [
      {x: 807, y: 326},
      {x: 963, y: 361},
      {x: 746, y: 539},
      {x: 1133, y: 541},
      {x: 912, y: 789},
    ],
  },
  {
    id: "signals",
    label: "4个信号状态",
    detail: "2 RED OFF + 2 GREEN ON",
    hub: {x: 1045, y: 610},
    labelPoint: {x: 1240, y: 500},
    labelAlign: "start",
    targets: [
      {x: 818, y: 449},
      {x: 838, y: 469},
      {x: 1010, y: 496},
      {x: 1030, y: 516},
    ],
  },
  {
    id: "route_states",
    label: "2个路线状态",
    detail: "11 TARGETS · ATOMIC",
    hub: {x: 1095, y: 730},
    labelPoint: {x: 1265, y: 705},
    labelAlign: "start",
    targets: [
      {x: 982, y: 584},
      {x: 1010, y: 610},
    ],
  },
] as const;

const atomicGroupLabelsEnglish = ["5 MOVES", "4 SIGNAL STATES", "2 ROUTE STATES"] as const;

const atomicGroupsFor = (language: EmergencyCitySemanticLensLanguage): readonly AtomicGroup[] =>
  language === "en"
    ? atomicGroups.map((group, index) => ({...group, label: atomicGroupLabelsEnglish[index]}))
    : atomicGroups;

const groupDatum = (group: AtomicGroup): AnchorDatum => ({
  anchor: group.hub,
  label: group.labelPoint,
  align: group.labelAlign,
  primary: group.label,
  secondary: group.detail,
  color: palette.green,
});

/** The real five-move, four-signal, two-route-state pressed-event fan-out. */
export const EmergencyCityAtomicFanOut = ({
  variant,
  duration,
  commitFrame = 0,
  language = "zh",
}: EmergencyCityAtomicFanOutProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  // The source camera begins its response follow-shot at source frame 92.
  // Retire the screen-space topology before that movement so its anchors
  // never drift away from the captured targets.
  const anchoredDuration = Math.min(localDuration(duration), variant === "landscape" ? 42 : 34);
  const exit = exitOpacity(frame, anchoredDuration, fps);
  const topology = spring({
    frame: frame - commitFrame,
    fps,
    durationInFrames: Math.max(10, Math.round(0.62 * fps)),
    config: {damping: 200},
  });
  const commitDelta = frame - commitFrame;
  const pulse = interpolate(
    commitDelta,
    [0, Math.max(1, Math.round(0.12 * fps)), Math.max(2, Math.round(0.35 * fps)), Math.max(3, Math.round(0.75 * fps))],
    [0, 1, 0.38, 0],
    clamp,
  );
  const source = pointFor(variant, fanOutSource);
  const lineWidth = lineWidthFor(variant);
  const groups = atomicGroupsFor(language);

  return (
    <OverlaySvg variant={variant} title="One pressed event atomically reaches eleven real targets">
      <g fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={exit}>
        {groups.flatMap((group) => {
          const hub = pointFor(variant, group.hub);
          const stem = (
            <path
              key={`${group.id}-stem`}
              d={`M ${source.x} ${source.y} L ${hub.x} ${hub.y}`}
              stroke={palette.green}
              strokeWidth={lineWidth + pulse * 2.2}
              strokeOpacity={0.24 + topology * 0.48 + pulse * 0.28}
              pathLength={1}
              strokeDasharray={1}
              strokeDashoffset={1 - topology}
            />
          );
          const branches = group.targets.map((target, targetIndex) => {
            const resolvedTarget = pointFor(variant, target);
            return (
              <path
                key={`${group.id}-target-${targetIndex}`}
                d={`M ${hub.x} ${hub.y} L ${resolvedTarget.x} ${resolvedTarget.y}`}
                stroke={palette.green}
                strokeWidth={lineWidth + pulse * 1.6}
                strokeOpacity={0.2 + topology * 0.56 + pulse * 0.24}
                pathLength={1}
                strokeDasharray={1}
                strokeDashoffset={1 - topology}
              />
            );
          });
          return [stem, ...branches];
        })}
      </g>
      <g opacity={exit}>
        <circle
          cx={source.x}
          cy={source.y}
          r={(variant === "landscape" ? 9 : 11) + pulse * 13}
          fill={palette.green}
          fillOpacity={0.88}
        />
        <circle
          cx={source.x}
          cy={source.y}
          r={(variant === "landscape" ? 19 : 23) + pulse * (variant === "landscape" ? 14 : 25)}
          fill="none"
          stroke={palette.green}
          strokeOpacity={0.35 + pulse * 0.5}
          strokeWidth={lineWidth}
        />
        {groups.flatMap((group) => group.targets.map((target, targetIndex) => {
          const point = pointFor(variant, target);
          return (
            <circle
              key={`${group.id}-node-${targetIndex}`}
              cx={point.x}
              cy={point.y}
              r={(variant === "landscape" ? 4.5 : 5.5) + pulse * 5}
              fill={palette.green}
              opacity={topology * (0.72 + pulse * 0.28)}
            />
          );
        }))}
      </g>
      {groups.map((group, index) => {
        const progress = revealProgress(frame - commitFrame, fps, index);
        return (
          <AnchorLabel
            key={group.id}
            datum={groupDatum(group)}
            progress={progress}
            opacity={progress * exit}
            variant={variant}
          />
        );
      })}
    </OverlaySvg>
  );
};

export const EMERGENCY_CITY_REVISION_EVIDENCE = Object.freeze([
  Object.freeze({revision: 12, state: "BLOCKED"}),
  Object.freeze({revision: 13, state: "OPEN"}),
  Object.freeze({revision: 14, state: "REOPEN VERIFIED"}),
]);

const revisionPoints = {
  landscape: [
    {x: 410, y: 848},
    {x: 760, y: 848},
    {x: 1145, y: 848},
  ],
  vertical: [
    {x: 170, y: 1515},
    {x: 520, y: 1515},
    {x: 880, y: 1515},
  ],
} as const;

const revisionLabels = (variant: EmergencyCitySemanticLensVariant): readonly AnchorDatum[] => {
  const points = revisionPoints[variant];
  const labelY = variant === "landscape" ? 800 : 1450;
  return [
    {
      anchor: points[0],
      label: {x: points[0].x, y: labelY},
      align: "middle",
      primary: "REV 12",
      secondary: "BLOCKED",
      color: palette.gold,
    },
    {
      anchor: points[1],
      label: {x: points[1].x, y: labelY},
      align: "middle",
      primary: "REV 13",
      secondary: "OPEN · UNDO / REDO",
      color: palette.gold,
    },
    {
      anchor: points[2],
      label: {x: points[2].x, y: labelY},
      align: "middle",
      primary: "REOPEN 14",
      secondary: "STATE + ROUTES VERIFIED",
      color: palette.gold,
    },
  ];
};

/** Compact revision, undo/redo, and reopen-persistence proof for editability. */
export const EmergencyCityRevisionPersistenceCues = ({
  variant,
  duration,
}: EmergencyCitySemanticLensProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const exit = exitOpacity(frame, duration, fps);
  const safeDuration = localDuration(duration);
  const points = revisionPoints[variant];
  const entrance = revealProgress(frame, fps);
  // These local frames are the first rendered frames containing the real
  // source events: Undo at source 16, Redo at source 56, then Reopen 14 from
  // the first frame of the dedicated reopen capture.
  const undoAppliedFrame = 12;
  const redoAppliedFrame = 40;
  const reopenLoadedFrame = 60;
  const cursorX = interpolate(
    frame,
    [
      0,
      undoAppliedFrame - 1,
      undoAppliedFrame,
      redoAppliedFrame - 1,
      redoAppliedFrame,
      reopenLoadedFrame - 1,
      reopenLoadedFrame,
      safeDuration - 1,
    ],
    [points[1].x, points[1].x, points[0].x, points[0].x, points[1].x, points[1].x, points[2].x, points[2].x],
    {...clamp, easing: Easing.inOut(Easing.quad)},
  );
  const activeIndex = frame < undoAppliedFrame
    ? 1
    : frame < redoAppliedFrame
      ? 0
      : frame < reopenLoadedFrame
        ? 1
        : 2;
  const labels = revisionLabels(variant);
  const lineWidth = lineWidthFor(variant);

  return (
    <OverlaySvg variant={variant} title="Undo, redo, and reopen preserve revisioned scene state">
      <g opacity={entrance * exit}>
        <line
          x1={points[0].x}
          y1={points[0].y}
          x2={points[2].x}
          y2={points[2].y}
          stroke={palette.gold}
          strokeOpacity={0.48}
          strokeWidth={lineWidth}
        />
        {points.map((point, index) => (
          <g key={`${point.x}-${point.y}`}>
            <circle
              cx={point.x}
              cy={point.y}
              r={variant === "landscape" ? 8 : 10}
              fill={activeIndex === index ? palette.gold : palette.shadow}
              stroke={palette.gold}
              strokeWidth={lineWidth}
            />
            <line
              x1={point.x}
              y1={point.y - (variant === "landscape" ? 13 : 15)}
              x2={point.x}
              y2={point.y + (variant === "landscape" ? 13 : 15)}
              stroke={palette.gold}
              strokeOpacity={0.42}
              strokeWidth={lineWidth}
            />
          </g>
        ))}
        <circle
          cx={cursorX}
          cy={points[0].y}
          r={variant === "landscape" ? 17 : 20}
          fill="none"
          stroke={palette.gold}
          strokeWidth={lineWidth + 0.8}
        />
      </g>
      {labels.map((datum, index) => {
        // Reveal the complete revision rail together. Staggering by array
        // order would briefly imply REV 12 is current even though the first
        // captured editability frame is the open REV 13 state.
        const progress = revealProgress(frame, fps);
        return (
          <AnchorLabel
            key={datum.primary}
            datum={datum}
            progress={progress}
            opacity={progress * exit * (activeIndex === index ? 1 : 0.58)}
            variant={variant}
            coordinatesAreResolved
          />
        );
      })}
    </OverlaySvg>
  );
};
