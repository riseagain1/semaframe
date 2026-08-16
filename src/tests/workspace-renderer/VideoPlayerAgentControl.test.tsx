import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VideoPlayerView } from "../../app/components/workspace/VideoPlayerView";
import type { WorkspaceRenderComponent } from "../../workspace/renderer/contracts";

describe("video player agent desired-state control", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps click-to-load while applying YouTube play, seek, pause, and stop requests in place", async () => {
    const initial = videoComponent("provider-video", {
      sourceUrl: "https://youtu.be/dQw4w9WgXcQ",
      sourceKind: "youtube",
      title: "Provider control",
      autoplay: false,
    });
    const view = render(<VideoPlayerView component={withIntent(initial, "playing", "play", 0, 1)} />);
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByText(/Agent requested play; activate to apply it/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load Provider control" }));
    const frame = screen.getByTitle("Provider control") as HTMLIFrameElement;
    expect(new URL(frame.src).searchParams.get("enablejsapi")).toBe("1");
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");

    view.rerender(<VideoPlayerView component={withIntent(initial, "playing", "play", 0, 2)} />);
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(
      JSON.stringify({ event: "command", func: "playVideo", args: [] }),
      "https://www.youtube-nocookie.com",
    ));

    view.rerender(<VideoPlayerView component={withIntent(initial, "playing", "seek", 31.5, 3)} />);
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(
      JSON.stringify({ event: "command", func: "seekTo", args: [31.5, true] }),
      "https://www.youtube-nocookie.com",
    ));

    view.rerender(<VideoPlayerView component={withIntent(initial, "paused", "pause", 31.5, 4)} />);
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(
      JSON.stringify({ event: "command", func: "pauseVideo", args: [] }),
      "https://www.youtube-nocookie.com",
    ));

    view.rerender(<VideoPlayerView component={withIntent(initial, "stopped", "stop", 0, 5)} />);
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(
      JSON.stringify({ event: "command", func: "stopVideo", args: [] }),
      "https://www.youtube-nocookie.com",
    ));
    expect(screen.getByTitle("Provider control")).toBe(frame);
  });

  it("applies direct-media commands locally without emitting component actions", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const onAction = vi.fn();
    const initial = videoComponent("direct-video", {
      sourceUrl: "/media/demo.mp4",
      sourceKind: "direct",
      title: "Direct control",
      autoplay: false,
    });
    const view = render(<VideoPlayerView component={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Load Direct control" }));
    const video = screen.getByLabelText("Direct control") as HTMLVideoElement;

    view.rerender(<VideoPlayerView component={withIntent(initial, "playing", "play", 0, 1)} />);
    await waitFor(() => expect(play).toHaveBeenCalled());

    view.rerender(<VideoPlayerView component={withIntent(initial, "playing", "seek", 25, 2)} />);
    await waitFor(() => expect(video.currentTime).toBe(25));

    view.rerender(<VideoPlayerView component={withIntent(initial, "paused", "pause", 25, 3)} />);
    await waitFor(() => expect(pause).toHaveBeenCalled());
    expect(onAction).not.toHaveBeenCalled();
  });
});

function videoComponent(id: string, props: Record<string, unknown>): WorkspaceRenderComponent {
  return {
    id,
    type: { typeId: "video-player", version: "1.0.0", digest: "test-video" },
    label: String(props.title ?? id),
    props,
    durableState: {
      desiredPlayback: "stopped",
      lastCommand: "none",
      requestedTimeSeconds: 0,
      commandGeneration: 0,
    },
    placement: {
      space: "viewport", anchor: "center", offset: { x: 0, y: 0 },
      size: { width: 480, height: 306 },
    },
    tags: [],
    visibility: "visible",
    locks: { placement: false, props: false, deletion: false, actions: false },
  };
}

function withIntent(
  component: WorkspaceRenderComponent,
  desiredPlayback: "stopped" | "playing" | "paused",
  lastCommand: "play" | "pause" | "seek" | "stop",
  requestedTimeSeconds: number,
  commandGeneration: number,
): WorkspaceRenderComponent {
  return {
    ...component,
    durableState: { desiredPlayback, lastCommand, requestedTimeSeconds, commandGeneration },
  };
}
