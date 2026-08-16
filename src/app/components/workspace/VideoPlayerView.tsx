import { useEffect, useRef, useState } from "react";
import type { WorkspaceRenderComponent } from "../../../workspace/renderer/contracts";

export type VideoSourceKind = "auto" | "direct" | "youtube" | "vimeo";
export type VideoProvider = "direct" | "youtube" | "vimeo";

export type ResolvedVideoSource =
  | Readonly<{
    ok: true;
    provider: VideoProvider;
    playback: "native" | "embed";
    normalizedUrl: string;
    videoId?: string;
  }>
  | Readonly<{
    ok: false;
    reason: string;
  }>;

type EmbedOptions = Readonly<{
  controls: boolean;
  autoplay: boolean;
  muted: boolean;
  loop: boolean;
  allowFullscreen: boolean;
  startAtSeconds: number;
  origin?: string;
}>;

export type VideoPlaybackIntent = Readonly<{
  desiredPlayback: "stopped" | "playing" | "paused";
  lastCommand: "none" | "play" | "pause" | "seek" | "stop";
  requestedTimeSeconds: number;
  commandGeneration: number;
}>;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);
const VIMEO_HOSTS = new Set(["vimeo.com", "www.vimeo.com", "player.vimeo.com"]);
const VIDEO_EXTENSION = /\.(?:mp4|webm|ogg|ogv|m4v|mov)$/iu;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;
const VIMEO_ID = /^\d{1,12}$/u;
const CREDENTIAL_QUERY_KEY = /(?:^|[_-])(?:access[_-]?token|api[_-]?key|auth|credential|password|secret|signature|signed|token|key|sig|jwt|session)(?:$|[_-])/iu;

type ActivePlayerSubscriber = (ownerId: string | null) => void;
let activePlayerOwnerId: string | null = null;
const activePlayerSubscribers = new Set<ActivePlayerSubscriber>();

function claimActivePlayer(ownerId: string): void {
  if (activePlayerOwnerId === ownerId) return;
  activePlayerOwnerId = ownerId;
  for (const subscriber of [...activePlayerSubscribers]) subscriber(ownerId);
}

function releaseActivePlayer(ownerId: string): void {
  if (activePlayerOwnerId !== ownerId) return;
  activePlayerOwnerId = null;
}

/**
 * Resolve only sources the built-in renderer knows how to isolate safely.
 *
 * Provider pages are reduced to an allowlisted video ID and rebuilt on the
 * provider's player origin. Direct media must be a same-origin path or a
 * public HTTPS hostname and must name a supported media file. This is a
 * browser-side safety boundary, not a substitute for a host asset broker.
 */
export function resolveVideoSource(
  rawSource: string,
  sourceKind: VideoSourceKind = "auto",
): ResolvedVideoSource {
  const source = rawSource.trim();
  if (!source || source.length > 8_192) return invalid("The video source is empty or too long.");

  if (sourceKind === "youtube") return resolveYouTube(source);
  if (sourceKind === "vimeo") return resolveVimeo(source);
  if (sourceKind === "direct") return resolveDirect(source);

  const parsed = parseRemoteHttps(source);
  if (parsed.ok && YOUTUBE_HOSTS.has(parsed.url.hostname.toLowerCase())) return resolveYouTube(source);
  if (parsed.ok && VIMEO_HOSTS.has(parsed.url.hostname.toLowerCase())) return resolveVimeo(source);
  return resolveDirect(source);
}

/** Build a provider URL from normalized identity and inert display options. */
export function buildVideoEmbedUrl(source: Extract<ResolvedVideoSource, { ok: true }>, options: EmbedOptions): string {
  if (source.playback !== "embed" || !source.videoId) return source.normalizedUrl;
  const url = new URL(source.normalizedUrl);
  const autoplay = options.autoplay && !prefersReducedMotion();
  url.searchParams.set("controls", options.controls ? "1" : "0");
  url.searchParams.set("autoplay", autoplay ? "1" : "0");
  url.searchParams.set("loop", options.loop ? "1" : "0");
  url.searchParams.set("playsinline", "1");
  if (options.muted) url.searchParams.set(source.provider === "vimeo" ? "muted" : "mute", "1");
  if (options.startAtSeconds > 0) {
    if (source.provider === "youtube") url.searchParams.set("start", String(options.startAtSeconds));
    else url.hash = `t=${options.startAtSeconds}s`;
  }
  if (source.provider === "youtube") {
    url.searchParams.set("enablejsapi", "1");
    if (options.origin) url.searchParams.set("origin", options.origin);
    url.searchParams.set("rel", "0");
    url.searchParams.set("fs", options.allowFullscreen ? "1" : "0");
    if (options.loop) url.searchParams.set("playlist", source.videoId);
  } else {
    // Vimeo documents dnt=1 as its privacy-enhanced player mode.
    url.searchParams.set("dnt", "1");
  }
  return url.toString();
}

export function VideoPlayerView({ component }: Readonly<{ component: WorkspaceRenderComponent }>) {
  const sourceUrl = stringValue(component.props.sourceUrl) ?? "";
  const sourceKind = sourceKindValue(component.props.sourceKind);
  const source = resolveVideoSource(sourceUrl, sourceKind);
  const sourceIdentity = source.ok
    ? `${source.provider}:${source.normalizedUrl}`
    : `invalid:${sourceUrl}`;
  // Storing the identity rather than a boolean guarantees a prop/source change
  // immediately removes the old iframe or media element before a new source is
  // activated. No effect timing window can keep the previous player alive.
  const [activatedIdentity, setActivatedIdentity] = useState<string | null>(null);
  const [failure, setFailure] = useState<Readonly<{ identity: string; message: string }> | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const activated = source.ok && activatedIdentity === sourceIdentity;
  const activeFailure = failure?.identity === sourceIdentity ? failure : null;
  const title = stringValue(component.props.title) ?? component.label;
  const caption = stringValue(component.props.caption);
  const poster = safePosterSource(stringValue(component.props.posterAssetRef));
  const controls = component.props.controls !== false;
  const autoplay = component.props.autoplay === true;
  const muted = component.props.muted !== false;
  const loop = component.props.loop === true;
  const allowFullscreen = component.props.allowFullscreen !== false;
  const startAtSeconds = integerValue(component.props.startAtSeconds, 0, 86_400);
  const preload = component.props.preload === "metadata" ? "metadata" : "none";
  const fit = fitValue(component.props.fit);
  const playbackIntent = readVideoPlaybackIntent(component);

  useEffect(() => {
    const onActivePlayerChanged: ActivePlayerSubscriber = (ownerId) => {
      if (ownerId === component.id) return;
      setActivatedIdentity(null);
      setFailure(null);
    };
    const onVisibilityChanged = () => {
      if (!document.hidden) return;
      releaseActivePlayer(component.id);
      setActivatedIdentity(null);
      setFailure(null);
    };
    activePlayerSubscribers.add(onActivePlayerChanged);
    document.addEventListener("visibilitychange", onVisibilityChanged);
    return () => {
      activePlayerSubscribers.delete(onActivePlayerChanged);
      document.removeEventListener("visibilitychange", onVisibilityChanged);
      releaseActivePlayer(component.id);
    };
  }, [component.id]);

  useEffect(() => {
    if (!activated) releaseActivePlayer(component.id);
  }, [activated, component.id]);

  useEffect(() => {
    if (!activated || activeFailure || !source.ok || playbackIntent.commandGeneration === 0) return;
    applyPlaybackIntent(
      source,
      iframeRef.current,
      videoRef.current,
      playbackIntent,
      startAtSeconds,
      false,
    );
  }, [
    activated,
    activeFailure,
    playbackIntent.commandGeneration,
    sourceIdentity,
    startAtSeconds,
  ]);

  if (!source.ok) {
    return (
      <section
        className="workspace-video-player is-unavailable"
        aria-label={`${title} video player`}
        data-video-loaded="false"
        data-video-provider="invalid"
        data-video-source-kind={sourceKind}
      >
        <div className="workspace-video-player__status" role="status">
          <strong>{title}</strong>
          <span>Video unavailable</span>
          <small>{source.reason}</small>
        </div>
        {caption && <p className="workspace-video-player__caption">{caption}</p>}
      </section>
    );
  }

  const embedOptions: EmbedOptions = {
    controls,
    // Autoplay is evaluated only after the user presses the activation button.
    autoplay: activated && autoplay,
    muted,
    loop,
    allowFullscreen,
    startAtSeconds,
    ...(currentHttpOrigin() ? { origin: currentHttpOrigin() } : {}),
  };
  const playerUrl = source.playback === "embed"
    ? buildVideoEmbedUrl(source, embedOptions)
    : source.normalizedUrl;

  return (
    <section
      className="workspace-video-player"
      aria-label={`${title} video player`}
      data-video-loaded={activated ? "true" : "false"}
      data-video-provider={source.provider}
      data-video-source-kind={sourceKind}
      data-video-desired-playback={playbackIntent.desiredPlayback}
      data-video-command-generation={playbackIntent.commandGeneration}
    >
      <header className="workspace-video-player__header">
        <strong>{title}</strong>
        {activated && (
          <button
            type="button"
            data-no-canvas-drag="true"
            onClick={() => {
              releaseActivePlayer(component.id);
              setActivatedIdentity(null);
              setFailure(null);
            }}
            aria-label={`Unload ${title}`}
          >
            Unload
          </button>
        )}
      </header>
      <div className="workspace-video-player__viewport">
        {!activated ? (
          <div className="workspace-video-player__activation">
            {poster && <img src={poster} alt="" aria-hidden="true" draggable={false} />}
            <button
              type="button"
              data-no-canvas-drag="true"
              onClick={() => {
                setFailure(null);
                claimActivePlayer(component.id);
                setActivatedIdentity(sourceIdentity);
              }}
              aria-label={`Load ${title}`}
            >
              <span aria-hidden="true">▶</span>
              Load video
            </button>
            <small>{providerLabel(source.provider)} · loads only when requested</small>
            {playbackIntent.commandGeneration > 0 && (
              <small>Agent requested {playbackIntent.lastCommand}; activate to apply it.</small>
            )}
          </div>
        ) : activeFailure ? (
          <div className="workspace-video-player__status" role="alert">
            <strong>Video could not be loaded</strong>
            <small>{activeFailure.message}</small>
            <button
              type="button"
              data-no-canvas-drag="true"
              onClick={() => {
                claimActivePlayer(component.id);
                setFailure(null);
              }}
            >
              Retry
            </button>
          </div>
        ) : source.playback === "embed" ? (
          <iframe
            key={playerUrl}
            ref={iframeRef}
            src={playerUrl}
            title={title}
            loading="lazy"
            allow={iframePermissions(
              (autoplay || playbackIntent.desiredPlayback === "playing") && !prefersReducedMotion(),
              allowFullscreen,
            )}
            referrerPolicy="strict-origin-when-cross-origin"
            data-no-canvas-drag="true"
            onLoad={(event) => applyPlaybackIntent(
              source,
              event.currentTarget,
              null,
              playbackIntent,
              startAtSeconds,
              true,
            )}
            onError={() => {
              releaseActivePlayer(component.id);
              setFailure({ identity: sourceIdentity, message: "The provider player did not respond. Try again or unload it." });
            }}
          />
        ) : (
          <video
            key={playerUrl}
            ref={videoRef}
            src={playerUrl}
            aria-label={title}
            controls={controls}
            autoPlay={autoplay && !prefersReducedMotion()}
            muted={muted}
            loop={loop}
            playsInline
            preload={preload}
            poster={poster}
            style={{ objectFit: fit }}
            data-no-canvas-drag="true"
            onLoadedMetadata={(event) => applyPlaybackIntent(
              source,
              null,
              event.currentTarget,
              playbackIntent,
              startAtSeconds,
              true,
            )}
            onError={() => {
              releaseActivePlayer(component.id);
              setFailure({ identity: sourceIdentity, message: "The media host, format, or codec is unavailable in this browser." });
            }}
          />
        )}
      </div>
      {caption && <p className="workspace-video-player__caption">{caption}</p>}
    </section>
  );
}

function resolveYouTube(source: string): ResolvedVideoSource {
  const parsed = parseRemoteHttps(source);
  if (!parsed.ok) return parsed.result;
  const { url } = parsed;
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return invalid("Only official YouTube player URLs are supported.");
  let videoId: string | undefined;
  if (host === "youtu.be") {
    videoId = url.pathname.split("/").filter(Boolean)[0];
  } else if (url.pathname === "/watch") {
    videoId = url.searchParams.get("v") ?? undefined;
  } else {
    const parts = url.pathname.split("/").filter(Boolean);
    if (["embed", "shorts", "live"].includes(parts[0] ?? "")) videoId = parts[1];
  }
  if (!videoId || !VIDEO_ID.test(videoId)) return invalid("The YouTube URL does not contain a valid video ID.");
  return {
    ok: true,
    provider: "youtube",
    playback: "embed",
    normalizedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
    videoId,
  };
}

function resolveVimeo(source: string): ResolvedVideoSource {
  const parsed = parseRemoteHttps(source);
  if (!parsed.ok) return parsed.result;
  const { url } = parsed;
  const host = url.hostname.toLowerCase();
  if (!VIMEO_HOSTS.has(host)) return invalid("Only official Vimeo player URLs are supported.");
  const parts = url.pathname.split("/").filter(Boolean);
  const idIndex = host === "player.vimeo.com" && parts[0] === "video"
    ? 1
    : findLastIndex(parts, (part) => VIMEO_ID.test(part));
  const videoId = typeof idIndex === "number" && idIndex >= 0 ? parts[idIndex] : undefined;
  if (!videoId || !VIMEO_ID.test(videoId)) return invalid("The Vimeo URL does not contain a valid numeric video ID.");
  const pathHash = typeof idIndex === "number" && idIndex >= 0 ? parts[idIndex + 1] : undefined;
  const hash = url.searchParams.get("h") ?? (pathHash && /^[A-Za-z0-9_-]{6,64}$/u.test(pathHash) ? pathHash : undefined);
  const normalized = new URL(`https://player.vimeo.com/video/${videoId}`);
  if (hash) normalized.searchParams.set("h", hash);
  return {
    ok: true,
    provider: "vimeo",
    playback: "embed",
    normalizedUrl: normalized.toString(),
    videoId,
  };
}

function resolveDirect(source: string): ResolvedVideoSource {
  if (source.startsWith("/") && !source.startsWith("//")) {
    const url = new URL(source, "https://workspace.invalid");
    if (!VIDEO_EXTENSION.test(url.pathname)) return invalid("Direct video paths must end in a supported media extension.");
    if (hasCredentialQuery(url)) return invalid("Credential-bearing video URLs must use the host asset broker.");
    return { ok: true, provider: "direct", playback: "native", normalizedUrl: `${url.pathname}${url.search}${url.hash}` };
  }
  const parsed = parseRemoteHttps(source);
  if (!parsed.ok) return parsed.result;
  if (!isPublicMediaHostname(parsed.url.hostname)) return invalid("Direct video URLs must use a public hostname.");
  if (!VIDEO_EXTENSION.test(parsed.url.pathname)) return invalid("Direct video URLs must end in a supported media extension.");
  if (hasCredentialQuery(parsed.url)) return invalid("Credential-bearing video URLs must use the host asset broker.");
  return { ok: true, provider: "direct", playback: "native", normalizedUrl: parsed.url.toString() };
}

function parseRemoteHttps(source: string):
  | Readonly<{ ok: true; url: URL }>
  | Readonly<{ ok: false; result: ResolvedVideoSource }> {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return { ok: false, result: invalid("The video source is not a valid URL.") };
  }
  if (url.protocol !== "https:") return { ok: false, result: invalid("Remote video sources must use HTTPS.") };
  if (url.username || url.password) return { ok: false, result: invalid("Video URLs cannot contain credentials.") };
  if (url.port && url.port !== "443") return { ok: false, result: invalid("Video URLs cannot use a custom network port.") };
  return { ok: true, url };
}

function isPublicMediaHostname(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase();
  if (!hostname || hostname.length > 253 || hostname.endsWith(".")) return false;
  if (hostname.startsWith("[") || /^\d+(?:\.\d+){3}$/u.test(hostname)) return false;
  if (!hostname.includes(".")) return false;
  if ([".localhost", ".local", ".internal", ".home", ".lan", ".test", ".invalid", ".example", ".onion"]
    .some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix))) return false;
  return hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label));
}

function hasCredentialQuery(url: URL): boolean {
  return [...url.searchParams.keys()].some((key) => CREDENTIAL_QUERY_KEY.test(key));
}

function safePosterSource(source: string | undefined): string | undefined {
  if (!source) return undefined;
  return /^(?:data:image\/(?:png|jpeg|gif|webp);base64,|blob:|\/(?!\/))/iu.test(source) ? source : undefined;
}

function iframePermissions(autoplay: boolean, allowFullscreen: boolean): string {
  return [
    ...(autoplay ? ["autoplay"] : []),
    "encrypted-media",
    "picture-in-picture",
    ...(allowFullscreen ? ["fullscreen"] : []),
  ].join("; ");
}

export function readVideoPlaybackIntent(component: WorkspaceRenderComponent): VideoPlaybackIntent {
  const durable = component.durableState;
  const desiredPlayback = durable.desiredPlayback === "playing" || durable.desiredPlayback === "paused"
    ? durable.desiredPlayback
    : "stopped";
  const lastCommand = durable.lastCommand === "play" || durable.lastCommand === "pause"
    || durable.lastCommand === "seek" || durable.lastCommand === "stop"
    ? durable.lastCommand
    : "none";
  return {
    desiredPlayback,
    lastCommand,
    requestedTimeSeconds: numberValue(durable.requestedTimeSeconds, 0, 86_400),
    commandGeneration: integerValue(durable.commandGeneration, 0, Number.MAX_SAFE_INTEGER),
  };
}

function applyPlaybackIntent(
  source: Extract<ResolvedVideoSource, { ok: true }>,
  iframe: HTMLIFrameElement | null,
  video: HTMLVideoElement | null,
  intent: VideoPlaybackIntent,
  configuredStartSeconds: number,
  initialize: boolean,
): void {
  if (initialize) {
    const initialTime = intent.commandGeneration > 0
      ? intent.requestedTimeSeconds
      : configuredStartSeconds;
    if (initialTime > 0) sendPlaybackCommand(source, iframe, video, "seek", initialTime);
    if (intent.commandGeneration === 0) return;
    if (intent.lastCommand === "seek") {
      sendPlaybackCommand(
        source,
        iframe,
        video,
        intent.desiredPlayback === "playing" ? "play" : "pause",
      );
      return;
    }
  }
  if (intent.lastCommand !== "none") {
    sendPlaybackCommand(
      source,
      iframe,
      video,
      intent.lastCommand,
      intent.requestedTimeSeconds,
    );
  }
}

function sendPlaybackCommand(
  source: Extract<ResolvedVideoSource, { ok: true }>,
  iframe: HTMLIFrameElement | null,
  video: HTMLVideoElement | null,
  command: Exclude<VideoPlaybackIntent["lastCommand"], "none">,
  timeSeconds = 0,
): void {
  if (source.playback === "native") {
    if (!video) return;
    if (command === "seek") {
      try { video.currentTime = timeSeconds; } catch { /* Stream is not seekable yet. */ }
      return;
    }
    if (command === "pause") {
      video.pause();
      return;
    }
    if (command === "stop") {
      video.pause();
      try { video.currentTime = 0; } catch { /* Stream is not seekable yet. */ }
      return;
    }
    if (prefersReducedMotion()) return;
    try {
      const play = video.play();
      void play?.catch(() => undefined);
    } catch {
      // Browser autoplay policy is authoritative. Native controls remain
      // available and the durable state continues to mean "requested".
    }
    return;
  }
  if (!iframe?.contentWindow || (command === "play" && prefersReducedMotion())) return;
  const targetOrigin = new URL(source.normalizedUrl).origin;
  if (source.provider === "youtube") {
    const func = command === "play" ? "playVideo"
      : command === "pause" ? "pauseVideo"
        : command === "seek" ? "seekTo" : "stopVideo";
    const args = command === "seek" ? [timeSeconds, true] : [];
    iframe.contentWindow.postMessage(JSON.stringify({ event: "command", func, args }), targetOrigin);
    return;
  }
  if (command === "stop") {
    iframe.contentWindow.postMessage({ method: "pause" }, targetOrigin);
    iframe.contentWindow.postMessage({ method: "setCurrentTime", value: 0 }, targetOrigin);
    return;
  }
  iframe.contentWindow.postMessage(
    command === "seek"
      ? { method: "setCurrentTime", value: timeSeconds }
      : { method: command },
    targetOrigin,
  );
}

function prefersReducedMotion(): boolean {
  return typeof globalThis.matchMedia === "function"
    && globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function currentHttpOrigin(): string | undefined {
  if (typeof globalThis.location === "undefined") return undefined;
  return globalThis.location.protocol === "http:" || globalThis.location.protocol === "https:"
    ? globalThis.location.origin
    : undefined;
}

function invalid(reason: string): ResolvedVideoSource {
  return { ok: false, reason };
}

function sourceKindValue(value: unknown): VideoSourceKind {
  return value === "direct" || value === "youtube" || value === "vimeo" ? value : "auto";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function integerValue(value: unknown, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : minimum;
}

function numberValue(value: unknown, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : minimum;
}

function fitValue(value: unknown): "contain" | "cover" | "fill" | "none" {
  return value === "cover" || value === "fill" || value === "none" ? value : "contain";
}

function providerLabel(provider: VideoProvider): string {
  if (provider === "youtube") return "YouTube privacy-enhanced player";
  if (provider === "vimeo") return "Vimeo privacy-enhanced player";
  return "Direct media";
}

function findLastIndex(values: readonly string[], predicate: (value: string) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index]!)) return index;
  }
  return -1;
}
