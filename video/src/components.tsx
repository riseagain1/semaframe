import type { CSSProperties, ReactNode } from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { theme, sans, serif } from "./theme";

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

export const PaperBackground = ({ dark = false }: { dark?: boolean }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const drift = interpolate(frame, [0, 12 * fps], [0, 44], clamp);
  return (
    <AbsoluteFill
      style={{
        overflow: "hidden",
        background: dark
          ? `radial-gradient(circle at 70% 18%, #20303a 0%, ${theme.night} 45%, #070a0e 100%)`
          : `radial-gradient(circle at 74% 20%, #fffaf1 0%, ${theme.paper} 48%, ${theme.paperDeep} 100%)`,
      }}
    >
      <div
        style={{
          position: "absolute",
          width: 980,
          height: 980,
          right: -420 + drift,
          bottom: -520,
          border: `2px solid ${dark ? "rgba(104,213,255,.13)" : "rgba(98,127,114,.14)"}`,
          borderRadius: "50%",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 760,
          height: 760,
          right: -310 + drift * 0.7,
          bottom: -390,
          border: `2px solid ${dark ? "rgba(214,107,69,.14)" : "rgba(214,107,69,.12)"}`,
          borderRadius: "50%",
        }}
      />
    </AbsoluteFill>
  );
};

export const SceneFade = ({ children, duration }: { children: ReactNode; duration: number }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 14, duration - 14, duration], [0, 1, 1, 0], clamp);
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
};

export const Wordmark = ({ inverse = false, compact = false }: { inverse?: boolean; compact?: boolean }) => (
  <div style={{ display: "flex", alignItems: "center", gap: compact ? 18 : 28 }}>
    <Img
      src={staticFile("brand/semaframe-mark.svg")}
      style={{ width: compact ? 70 : 104, height: compact ? 70 : 104 }}
    />
    <div>
      <div
        style={{
          color: inverse ? "#F5F7FA" : theme.ink,
          fontFamily: sans,
          fontSize: compact ? 28 : 52,
          fontWeight: 800,
          letterSpacing: compact ? 5 : 10,
        }}
      >
        SEMAFRAME
      </div>
      {!compact && (
        <div style={{ color: inverse ? "#AEBBC8" : theme.muted, fontFamily: sans, fontSize: 18, letterSpacing: 2.1, marginTop: 5 }}>
          BUILD SPACES AGENTS CAN UNDERSTAND
        </div>
      )}
    </div>
  </div>
);

export const Kicker = ({ children, color = theme.orange }: { children: ReactNode; color?: string }) => (
  <div style={{ color, fontFamily: sans, fontWeight: 800, fontSize: 18, letterSpacing: 3.2, textTransform: "uppercase" }}>
    {children}
  </div>
);

export const Title = ({ children, dark = false, style }: { children: ReactNode; dark?: boolean; style?: CSSProperties }) => (
  <div
    style={{
      color: dark ? "#F5F7FA" : theme.ink,
      fontFamily: serif,
      fontSize: 82,
      lineHeight: 0.98,
      letterSpacing: -2.8,
      ...style,
    }}
  >
    {children}
  </div>
);

export const Body = ({ children, dark = false, style }: { children: ReactNode; dark?: boolean; style?: CSSProperties }) => (
  <div style={{ color: dark ? "#C6D0DB" : theme.muted, fontFamily: sans, fontSize: 27, lineHeight: 1.48, ...style }}>
    {children}
  </div>
);

export const Badge = ({ children, tone = "ink" }: { children: ReactNode; tone?: "ink" | "orange" | "teal" | "paper" }) => {
  const colors = {
    ink: { background: theme.ink, color: theme.paper },
    orange: { background: theme.orange, color: "white" },
    teal: { background: theme.teal, color: "white" },
    paper: { background: theme.paperDeep, color: theme.ink },
  }[tone];
  return (
    <div style={{ ...colors, borderRadius: 999, padding: "12px 22px", fontFamily: sans, fontSize: 18, fontWeight: 750, letterSpacing: 0.8 }}>
      {children}
    </div>
  );
};

export const ScreenshotFrame = ({
  src,
  style,
  zoomFrom = 1,
  zoomTo = 1,
  imageStyle,
}: {
  src: string;
  style?: CSSProperties;
  zoomFrom?: number;
  zoomTo?: number;
  imageStyle?: CSSProperties;
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const entrance = spring({ frame, fps: 30, durationInFrames: 34, config: { damping: 200 } });
  const zoom = interpolate(frame, [0, durationInFrames], [zoomFrom, zoomTo], {
    ...clamp,
    easing: Easing.inOut(Easing.sin),
  });
  return (
    <div
      style={{
        position: "absolute",
        overflow: "hidden",
        borderRadius: 22,
        border: "1px solid rgba(255,255,255,.22)",
        background: theme.night,
        boxShadow: "0 34px 90px rgba(10,17,22,.28)",
        opacity: entrance,
        transform: `translateY(${(1 - entrance) * 28}px)`,
        ...style,
      }}
    >
      <Img
        src={staticFile(src)}
        style={{ width: "100%", height: "100%", objectFit: "contain", transform: `scale(${zoom})`, ...imageStyle }}
      />
    </div>
  );
};

export const Callout = ({ x, y, children, tone = "orange" }: { x: number; y: number; children: ReactNode; tone?: "orange" | "teal" }) => {
  const frame = useCurrentFrame();
  const progress = spring({ frame, fps: 30, delay: 15, durationInFrames: 30, config: { damping: 200 } });
  const color = tone === "orange" ? theme.orange : theme.teal;
  return (
    <div style={{ position: "absolute", left: x, top: y, opacity: progress, transform: `translateY(${(1 - progress) * 18}px)` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 18, height: 18, borderRadius: "50%", background: color, boxShadow: `0 0 0 8px ${color}24` }} />
        <div style={{ borderRadius: 12, padding: "11px 16px", color: theme.ink, background: "rgba(244,240,232,.95)", border: `1px solid ${color}77`, fontFamily: sans, fontSize: 18, fontWeight: 750, boxShadow: "0 10px 28px rgba(0,0,0,.18)" }}>
          {children}
        </div>
      </div>
    </div>
  );
};
