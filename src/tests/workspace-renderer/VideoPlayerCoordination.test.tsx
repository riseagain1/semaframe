import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VideoPlayerView } from "../../app/components/workspace/VideoPlayerView";
import type { WorkspaceRenderComponent } from "../../workspace/renderer/contracts";

describe("video player lifecycle coordination", () => {
  afterEach(cleanup);

  it("keeps at most one media context active and unloads it when the page is hidden", () => {
    const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    try {
      render(<>
        <VideoPlayerView component={video("video-a", "First video", "https://youtu.be/dQw4w9WgXcQ")} />
        <VideoPlayerView component={video("video-b", "Second video", "https://vimeo.com/76979871")} />
      </>);

      fireEvent.click(screen.getByRole("button", { name: "Load First video" }));
      const firstFrame = screen.getByTitle("First video");
      expect(document.querySelectorAll("iframe, video")).toHaveLength(1);

      fireEvent.click(screen.getByRole("button", { name: "Load Second video" }));
      const secondFrame = screen.getByTitle("Second video");
      expect(firstFrame.isConnected).toBe(false);
      expect(secondFrame.isConnected).toBe(true);
      expect(document.querySelectorAll("iframe, video")).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Load First video" })).toBeInTheDocument();

      hidden = true;
      fireEvent(document, new Event("visibilitychange"));
      expect(secondFrame.isConnected).toBe(false);
      expect(document.querySelectorAll("iframe, video")).toHaveLength(0);
      expect(screen.getByRole("button", { name: "Load Second video" })).toBeInTheDocument();
    } finally {
      if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
      else Reflect.deleteProperty(document, "hidden");
    }
  });
});

function video(id: string, title: string, sourceUrl: string): WorkspaceRenderComponent {
  return {
    id,
    type: { typeId: "video-player", version: "1.0.0", digest: "test-video" },
    label: title,
    props: { sourceUrl, sourceKind: "auto", title, controls: true, autoplay: false },
    durableState: {},
    placement: {
      space: "viewport",
      anchor: "center",
      offset: { x: 0, y: 0 },
      size: { width: 480, height: 306 },
    },
    tags: [],
    visibility: "visible",
    locks: { placement: false, props: false, deletion: false, actions: false },
  };
}
