import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VideoPlayerView, resolveVideoSource } from "../../app/components/workspace/VideoPlayerView";
import { WorkspaceCanvasOverlay } from "../../app/components/workspace/WorkspaceCanvasOverlay";
import type { Box2DResizePolicy } from "../../workspace/components/componentTypes";
import type { ProjectedComponent, WorkspaceRenderComponent } from "../../workspace/renderer/contracts";

describe("VideoPlayerView security and lifecycle", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each([
    "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com:444/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com@evil.example/watch?v=dQw4w9WgXcQ",
    "https://player.vimeo.com.evil.example/video/76979871",
    "https://127.0.0.1/private.mp4",
    "https://2130706433/private.mp4",
    "https://[::1]/private.mp4",
    "https://media.internal/private.mp4",
    "https://media.example/video.mp4.exe",
    "//media.example/video.mp4",
    "javascript:alert(1)",
  ])("rejects an untrusted or non-media source: %s", (source) => {
    expect(resolveVideoSource(source)).toMatchObject({ ok: false });
  });

  it.each(["token", "key", "sig", "jwt", "session", "access_token", "api_key", "signature", "secret"])(
    "rejects persisted direct-media URLs carrying a likely credential parameter named %s",
    (credentialName) => {
      expect(resolveVideoSource(`https://media.example/video.mp4?${credentialName}=do-not-persist`, "direct"))
        .toMatchObject({ ok: false });
    },
  );

  it("rebuilds provider embeds from identity instead of forwarding untrusted query parameters", () => {
    expect(resolveVideoSource(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&origin=https%3A%2F%2Fevil.example&autoplay=1",
    )).toEqual({
      ok: true,
      provider: "youtube",
      playback: "embed",
      normalizedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      videoId: "dQw4w9WgXcQ",
    });
    expect(resolveVideoSource("https://vimeo.com/76979871?autoplay=1#redirect"))
      .toEqual({
        ok: true,
        provider: "vimeo",
        playback: "embed",
        normalizedUrl: "https://player.vimeo.com/video/76979871",
        videoId: "76979871",
      });
    expect(resolveVideoSource("https://vimeo.com/76979871/8272103f6e?autoplay=1"))
      .toEqual({
        ok: true,
        provider: "vimeo",
        playback: "embed",
        normalizedUrl: "https://player.vimeo.com/video/76979871?h=8272103f6e",
        videoId: "76979871",
      });
  });

  it("uses minimal iframe authority and never autoplays under reduced-motion preference", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    render(<VideoPlayerView component={videoComponent("youtube-reduced", {
      sourceUrl: "https://youtu.be/dQw4w9WgXcQ",
      sourceKind: "auto",
      title: "Reduced motion demo",
      autoplay: true,
      allowFullscreen: true,
    })} />);

    fireEvent.click(screen.getByRole("button", { name: "Load Reduced motion demo" }));
    const iframe = screen.getByTitle("Reduced motion demo");
    const source = new URL(iframe.getAttribute("src") ?? "");
    expect(source.origin).toBe("https://www.youtube-nocookie.com");
    expect(source.searchParams.get("autoplay")).toBe("0");
    // YouTube/Vimeo require an unsandboxed provider context for reliable native
    // controls, fullscreen, and provider navigation. The stronger boundary is
    // exact-host canonicalization plus the document's exact-host frame-src CSP.
    expect(iframe).not.toHaveAttribute("sandbox");
    expect(iframe).toHaveAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    expect(iframe).toHaveAttribute("loading", "lazy");
    expect(iframe.getAttribute("allow")).toBe("encrypted-media; picture-in-picture; fullscreen");
  });

  it("destroys the active browsing context when its source changes", () => {
    const view = render(<VideoPlayerView component={videoComponent("video-source-change", {
      sourceUrl: "https://youtu.be/dQw4w9WgXcQ",
      title: "Source switch",
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "Load Source switch" }));
    const oldFrame = screen.getByTitle("Source switch");
    expect(oldFrame.isConnected).toBe(true);

    view.rerender(<VideoPlayerView component={videoComponent("video-source-change", {
      sourceUrl: "https://vimeo.com/76979871",
      title: "Source switch",
    })} />);

    expect(oldFrame.isConnected).toBe(false);
    expect(screen.queryByTitle("Source switch")).not.toBeInTheDocument();
    const replacementLoadButton = screen.getByRole("button", { name: "Load Source switch" });
    replacementLoadButton.focus();
    expect(replacementLoadButton).toHaveFocus();
    fireEvent.click(replacementLoadButton);
    const newFrame = screen.getByTitle("Source switch");
    expect(newFrame).not.toBe(oldFrame);
    expect(new URL(newFrame.getAttribute("src") ?? "").origin).toBe("https://player.vimeo.com");

    view.unmount();
    expect(newFrame.isConnected).toBe(false);
  });

  it("turns a native network or codec failure into a recoverable accessible state", () => {
    render(<VideoPlayerView component={videoComponent("broken-direct", {
      sourceUrl: "/media/broken.mp4",
      sourceKind: "direct",
      title: "Broken direct",
      preload: "none",
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "Load Broken direct" }));
    const failedVideo = document.querySelector("video");
    expect(failedVideo).not.toBeNull();
    fireEvent.error(failedVideo!);

    expect(failedVideo!.isConnected).toBe(false);
    expect(screen.getByRole("alert")).toHaveTextContent("Video could not be loaded");
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    expect(retry).toHaveFocus();
    fireEvent.click(retry);
    const retriedVideo = document.querySelector("video");
    expect(retriedVideo).not.toBeNull();
    expect(retriedVideo).not.toBe(failedVideo);

    fireEvent.click(screen.getByRole("button", { name: "Unload Broken direct" }));
    expect(retriedVideo!.isConnected).toBe(false);
    expect(screen.getByRole("button", { name: "Load Broken direct" })).toBeInTheDocument();
  });
});

describe("VideoPlayerView structural performance", () => {
  afterEach(cleanup);

  it("mounts no media browsing contexts for ten unactivated players and exactly one on demand", () => {
    const components = Array.from({ length: 10 }, (_, index) => videoComponent(`video-${index}`, {
      sourceUrl: `https://vimeo.com/${76979871 + index}`,
      title: `Lazy video ${index + 1}`,
      autoplay: false,
      preload: "none",
    }));
    const view = render(<>{components.map((component) => (
      <VideoPlayerView key={component.id} component={component} />
    ))}</>);

    // No iframe/video element means the browser has no media source from this
    // component to request, decode, animate, or retain before activation.
    expect(document.querySelectorAll("iframe, video")).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: /^Load Lazy video/u })).toHaveLength(10);

    fireEvent.click(screen.getByRole("button", { name: "Load Lazy video 6" }));
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(document.querySelectorAll("video")).toHaveLength(0);
    expect(screen.getByTitle("Lazy video 6")).toHaveAttribute("loading", "lazy");

    const activeFrame = screen.getByTitle("Lazy video 6");
    view.unmount();
    expect(activeFrame.isConnected).toBe(false);
    expect(document.querySelectorAll("iframe, video")).toHaveLength(0);
  });

  it("preserves the active player across projection refreshes and emits no semantic playback actions", () => {
    const component = videoComponent("stable-player", {
      sourceUrl: "https://youtu.be/dQw4w9WgXcQ",
      title: "Stable player",
      autoplay: false,
    });
    const onAction = vi.fn();
    const view = render(<WorkspaceCanvasOverlay
      components={[component]}
      projections={new Map([[component.id, projection(component.id, 0)]])}
      selectedId={component.id}
      onAction={onAction}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Load Stable player" }));
    const activeFrame = screen.getByTitle("Stable player");

    // This models camera/projection refreshes. React must reconcile the same
    // browsing context instead of reloading the provider on every frame.
    for (let frame = 1; frame <= 120; frame += 1) {
      view.rerender(<WorkspaceCanvasOverlay
        components={[component]}
        projections={new Map([[component.id, projection(component.id, frame)]])}
        selectedId={component.id}
        onAction={onAction}
      />);
    }

    expect(screen.getByTitle("Stable player")).toBe(activeFrame);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("keeps the active provider context mounted while its outer frame is resized", () => {
    const component = {
      ...videoComponent("resizable-player", {
        sourceUrl: "https://vimeo.com/76979871",
        title: "Resizable player",
        autoplay: false,
      }),
      placement: {
        space: "viewport" as const,
        anchor: "center" as const,
        offset: { x: 0, y: 0 },
        size: { width: 480, height: 306 },
      },
    } satisfies WorkspaceRenderComponent;
    const policy: Box2DResizePolicy = {
      kind: "box2d",
      mode: "aspect_locked",
      defaultSize: { width: 480, height: 306 },
      minSize: { width: 356, height: 200 },
      maxSize: { width: 4_096, height: 4_096 },
      aspectRatio: 480 / 306,
      allowedAxes: ["width", "height"],
      units: "px",
    };
    const view = render(<WorkspaceCanvasOverlay
      components={[component]}
      projections={new Map([[component.id, { ...projection(component.id, 0), width: 480, height: 306 }]])}
      selectedId={component.id}
      getResizePolicy={() => policy}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Load Resizable player" }));
    const activeFrame = screen.getByTitle("Resizable player");
    const handle = screen.getByRole("button", { name: "Resize Resizable player from bottom right" });
    const content = activeFrame.closest(".workspace-projected-component__content");
    expect(content).not.toBeNull();
    expect(content?.contains(handle)).toBe(false);

    const resized = {
      ...component,
      placement: { ...component.placement, size: { width: 640, height: 408 } },
    } as WorkspaceRenderComponent;
    view.rerender(<WorkspaceCanvasOverlay
      components={[resized]}
      projections={new Map([[component.id, { ...projection(component.id, 0), width: 640, height: 408 }]])}
      selectedId={component.id}
      getResizePolicy={() => policy}
    />);

    expect(screen.getByTitle("Resizable player")).toBe(activeFrame);
  });

  it("keeps high-frequency native playback events entirely outside Workspace revisions", () => {
    const component = videoComponent("ephemeral-playback", {
      sourceUrl: "/media/demo.mp4",
      sourceKind: "direct",
      title: "Ephemeral playback",
      preload: "none",
    });
    const onAction = vi.fn();
    render(<WorkspaceCanvasOverlay
      components={[component]}
      projections={new Map([[component.id, projection(component.id, 0)]])}
      selectedId={component.id}
      onAction={onAction}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Load Ephemeral playback" }));
    const video = document.querySelector("video");
    expect(video).not.toBeNull();

    for (let tick = 0; tick < 300; tick += 1) {
      fireEvent(video!, new Event("timeupdate", { bubbles: false }));
    }
    for (const eventName of ["play", "playing", "progress", "pause", "seeking", "seeked", "ratechange", "volumechange", "ended"]) {
      fireEvent(video!, new Event(eventName, { bubbles: false }));
    }

    expect(onAction).not.toHaveBeenCalled();
    expect(document.querySelector("video")).toBe(video);
  });
});

function videoComponent(id: string, props: Record<string, unknown>): WorkspaceRenderComponent {
  return {
    id,
    type: { typeId: "video-player", version: "1.0.0", digest: "test-video-player" },
    label: typeof props.title === "string" ? props.title : id,
    props,
    durableState: {},
    placement: {
      space: "viewport",
      anchor: "center",
      offset: { x: 0, y: 0 },
      size: { width: 480, height: 270 },
    },
    tags: [],
    visibility: "visible",
    locks: { placement: false, props: false, deletion: false, actions: false },
  };
}

function projection(componentId: string, frame: number): ProjectedComponent {
  return {
    componentId,
    space: "viewport",
    left: 20 + frame / 10,
    top: 20,
    width: 480,
    height: 270,
    zIndex: 1,
    visible: true,
    spatialOnly: false,
  };
}
